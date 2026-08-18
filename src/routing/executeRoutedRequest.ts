import { resolveAccountExecutionGate } from "../runtime/runtimeStatus.js";
import type { RuntimeStatusService } from "../runtime/runtimeStatusService.js";
import type { ProviderResponse, ProviderStreamChunk, RouteTarget } from "../providers/adapter.js";
import type { SelectedRoute } from "./routeEngine.js";
import type { RuntimeSnapshot } from "../runtime/runtimeTypes.js";
import type { TraceAttempt, TraceCandidate } from "../trace/traceTypes.js";
import { HttpError } from "../utils/httpErrors.js";
import {
  PROVIDER_AUTH_FAILED_CODE,
  PROVIDER_AUTH_FAILED_MESSAGE
} from "../utils/providerErrors.js";

/** `selectRoute` 返回的候选，已排序并带 runtime 对象引用 */
export type RoutedCandidate = SelectedRoute & { score: number; sticky: boolean };

export interface RoutedExecutionInput {
  state: RuntimeSnapshot;
  runtimeStatusService?: RuntimeStatusService;
  candidates: RoutedCandidate[];
  requestHeaders?: RouteTarget["request_headers"];
  /**
   * 跳过不适用的候选（如 `/v1/responses` 需要 adapter 实现 responseCompletion）。
   * 返回 false 的候选不计入 attempts，也不记失败。
   */
  supportsCandidate?: (candidate: RoutedCandidate, target: RouteTarget) => boolean;
  /** 非流式执行；返回上游响应 */
  invoke: (candidate: RoutedCandidate, target: RouteTarget) => Promise<ProviderResponse>;
}

export interface RoutedExecutionOutcome {
  /** 实际成功执行的候选；全部失败时为 null */
  selected: RoutedCandidate | null;
  response: ProviderResponse | null;
  attempts: TraceAttempt[];
  fallbacks: TraceCandidate[];
  lastError: unknown;
  /** supportsCandidate 至少放行过一个候选 */
  sawSupportedCandidate: boolean;
}

function toTraceCandidate(candidate: RoutedCandidate): TraceCandidate {
  return {
    route_id: candidate.routeId,
    endpoint: candidate.endpoint.id,
    platform: candidate.platform.id,
    provider: candidate.provider.id,
    account: candidate.account.id,
    model_id: candidate.modelId,
    model: candidate.model,
    score: candidate.score,
    sticky: false
  };
}

/**
 * 解析 runtime status 记账用的 modelKey，多级回退与原 handler 保持一致。
 */
function resolveModelKey(state: RuntimeSnapshot, candidate: RoutedCandidate): string {
  return state.modelStatuses?.[candidate.modelId]?.model_key ?? candidate.modelId;
}

/**
 * 构造 adapter 需要的 RouteTarget，凭证从 credentialStore 解析。
 * account 配置缺失时返回 null，由调用方计为失败并继续下一个候选。
 */
function buildRouteTarget(
  state: RuntimeSnapshot,
  candidate: RoutedCandidate,
  requestHeaders?: RouteTarget["request_headers"]
): RouteTarget | null {
  const accountConfig = state.config.accounts[candidate.account.id];
  if (!accountConfig) {
    return null;
  }

  return {
    platform: candidate.platform,
    provider: candidate.provider,
    endpoint: candidate.endpoint,
    account: candidate.account,
    modelId: candidate.modelId,
    model: candidate.modelDefinition,
    credential: state.credentialStore.resolve(candidate.account.id, accountConfig),
    request_headers: requestHeaders
  };
}

/**
 * 判断候选此刻是否可执行；顺带把过期冷却恢复到本次 snapshot。
 */
function passesAccountGate(candidate: RoutedCandidate): boolean {
  const gate = resolveAccountExecutionGate({
    enabled: candidate.account.enabled,
    available: candidate.account.available,
    runtimeStatus: candidate.account.runtime_status ?? "normal",
    statusReason: candidate.account.status_reason,
    statusMessage: candidate.account.status_message,
    statusCooldownUntil: candidate.account.status_cooldown_until,
    disabledReason: candidate.account.disabled_reason,
    disabledMessage: candidate.account.disabled_message
  });

  if (!gate.canExecute) {
    return false;
  }

  if (gate.recoveredFromExpiredCooldown) {
    candidate.account.available = true;
    candidate.account.disabled_reason = undefined;
    candidate.account.disabled_message = undefined;
  }

  return true;
}

/**
 * 记录一次失败：错误计数、runtime status、auth 失败禁用 account。
 */
function recordFailure(
  input: { state: RuntimeSnapshot; runtimeStatusService?: RuntimeStatusService },
  candidate: RoutedCandidate,
  error: unknown
) {
  candidate.endpoint.recent_error_count += 1;
  candidate.account.recent_error_count += 1;

  input.runtimeStatusService?.recordFailure({
    snapshot: input.state,
    providerKey: candidate.provider.id,
    modelKey: resolveModelKey(input.state, candidate),
    accountId: candidate.account.id,
    error
  });

  if (error instanceof HttpError && error.code === PROVIDER_AUTH_FAILED_CODE) {
    candidate.account.available = false;
    candidate.account.disabled_reason = PROVIDER_AUTH_FAILED_CODE;
    candidate.account.disabled_message = error.message || PROVIDER_AUTH_FAILED_MESSAGE;
  }
}

/**
 * 协议无关的非流式路由执行：按候选顺序尝试，任何上游失败都 fallback 到下一个。
 * `HttpError.retryable` 只描述同一候选是否可重试，不决定是否跨候选 fallback。
 */
export async function executeRoutedRequest(
  input: RoutedExecutionInput
): Promise<RoutedExecutionOutcome> {
  const attempts: TraceAttempt[] = [];
  const fallbacks: TraceCandidate[] = [];
  let selected: RoutedCandidate | null = null;
  let response: ProviderResponse | null = null;
  let lastError: unknown;
  let sawSupportedCandidate = false;

  for (const [index, candidate] of input.candidates.entries()) {
    if (!passesAccountGate(candidate)) {
      continue;
    }

    const target = buildRouteTarget(input.state, candidate, input.requestHeaders);
    if (!target) {
      lastError = new HttpError(500, "account_not_found", "Configured account missing");
      continue;
    }

    if (input.supportsCandidate && !input.supportsCandidate(candidate, target)) {
      continue;
    }
    sawSupportedCandidate = true;

    const attemptStartedAt = Date.now();
    try {
      response = await input.invoke(candidate, target);
      const latencyMs = Date.now() - attemptStartedAt;

      attempts.push({
        ...toTraceCandidate(candidate),
        status: "success",
        latency_ms: latencyMs,
        first_token_ms: latencyMs
      });
      selected = candidate;

      input.runtimeStatusService?.recordSuccess({
        snapshot: input.state,
        providerKey: candidate.provider.id,
        modelKey: resolveModelKey(input.state, candidate),
        accountId: candidate.account.id
      });
      break;
    } catch (error) {
      lastError = error;
      recordFailure(input, candidate, error);

      attempts.push({
        ...toTraceCandidate(candidate),
        status: "failed",
        error: error instanceof Error ? error.message : "provider_request_failed",
        retryable: error instanceof HttpError && error.retryable,
        latency_ms: Date.now() - attemptStartedAt
      });

      if (index < input.candidates.length - 1) {
        fallbacks.push(toTraceCandidate(candidate));
      }
    }
  }

  return { selected, response, attempts, fallbacks, lastError, sawSupportedCandidate };
}

export interface RoutedStreamInput extends Omit<RoutedExecutionInput, "invoke"> {
  /** 流式执行；yield 上游原始 chunk */
  invokeStream: (
    candidate: RoutedCandidate,
    target: RouteTarget
  ) => AsyncIterable<ProviderStreamChunk>;
  /** 首个 chunk 到达前调用一次，用于写响应头 */
  onStreamStart?: (candidate: RoutedCandidate) => void;
}

export interface RoutedStreamEvent {
  chunk: ProviderStreamChunk;
  candidate: RoutedCandidate;
}

/**
 * 协议无关的流式路由执行。与非流式的关键差别：一旦向调用方 yield 过 chunk，
 * 就不能再 fallback（字节已在途），此时把失败信息挂到 outcome 上由调用方落 trace。
 *
 * 不直接写 reply，让调用方决定是透传还是转换后再写。
 */
export async function* streamRoutedRequest(
  input: RoutedStreamInput,
  outcome: {
    selected: RoutedCandidate | null;
    attempts: TraceAttempt[];
    fallbacks: TraceCandidate[];
    lastError: unknown;
    sawSupportedCandidate: boolean;
    /** 已向调用方 yield 过 chunk 后又失败 */
    partialFailure: boolean;
  }
): AsyncGenerator<RoutedStreamEvent> {
  for (const [index, candidate] of input.candidates.entries()) {
    if (!passesAccountGate(candidate)) {
      continue;
    }

    const target = buildRouteTarget(input.state, candidate, input.requestHeaders);
    if (!target) {
      outcome.lastError = new HttpError(500, "account_not_found", "Configured account missing");
      continue;
    }

    if (input.supportsCandidate && !input.supportsCandidate(candidate, target)) {
      continue;
    }
    outcome.sawSupportedCandidate = true;

    const attemptStartedAt = Date.now();
    let firstTokenMs: number | undefined;
    let yieldedForCandidate = false;

    try {
      input.onStreamStart?.(candidate);

      for await (const chunk of input.invokeStream(candidate, target)) {
        if (firstTokenMs === undefined) {
          firstTokenMs = Date.now() - attemptStartedAt;
        }
        yieldedForCandidate = true;
        yield { chunk, candidate };
      }

      const latencyMs = Date.now() - attemptStartedAt;
      outcome.attempts.push({
        ...toTraceCandidate(candidate),
        status: "success",
        latency_ms: latencyMs,
        first_token_ms: firstTokenMs ?? latencyMs
      });
      outcome.selected = candidate;

      input.runtimeStatusService?.recordSuccess({
        snapshot: input.state,
        providerKey: candidate.provider.id,
        modelKey: resolveModelKey(input.state, candidate),
        accountId: candidate.account.id
      });
      return;
    } catch (error) {
      outcome.lastError = error;
      recordFailure(input, candidate, error);

      outcome.attempts.push({
        ...toTraceCandidate(candidate),
        status: "failed",
        error: error instanceof Error ? error.message : "provider_request_failed",
        retryable: error instanceof HttpError && error.retryable,
        latency_ms: Date.now() - attemptStartedAt,
        first_token_ms: firstTokenMs
      });

      // 字节已写出，不能再换候选
      if (yieldedForCandidate) {
        outcome.selected = candidate;
        outcome.partialFailure = true;
        return;
      }

      if (index < input.candidates.length - 1) {
        outcome.fallbacks.push(toTraceCandidate(candidate));
      }
    }
  }
}
