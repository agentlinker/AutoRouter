import { request } from "undici";

import {
  PROVIDER_AUTH_FAILED_CODE,
  throwIfProviderAccessBlocked
} from "../utils/providerErrors.js";
import { HttpError } from "../utils/httpErrors.js";
import { mergeCustomHeaders, pickForwardedRequestHeaders } from "./customHeaders.js";
import type {
  MessagesAdapter,
  ProviderMessagesRequest,
  ProviderResponse,
  ProviderStreamChunk,
  RouteTarget
} from "./adapter.js";
import { parseJsonSafely } from "./openaiCompatible.js";
import { resolveUpstreamUrl } from "./upstreamUrl.js";
import { providerErrorDetails } from "../runtime/providerFailure.js";

function buildHeaders(target: RouteTarget): Record<string, string> {
  const headers = mergeCustomHeaders(
    mergeCustomHeaders(
      {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      pickForwardedRequestHeaders(target.request_headers)
    ),
    target.endpoint.custom_headers
  );

  if (target.credential) {
    headers["x-api-key"] = target.credential;
  }

  return headers;
}


/**
 * 保留 Anthropic 上游错误状态。
 */
function toAnthropicHttpError(statusCode: number, body: unknown, retryAfter?: string): HttpError {
  const record = (body ?? {}) as Record<string, unknown>;
  const message =
    typeof record.error === "object" && record.error !== null && "message" in record.error
      ? String((record.error as { message?: unknown }).message)
      : `Anthropic request failed with status ${statusCode}`;
  const details = providerErrorDetails(body, "anthropic-messages", "messages", retryAfter);

  if (statusCode === 401 || statusCode === 403) {
    return new HttpError(statusCode, PROVIDER_AUTH_FAILED_CODE, message, false, details);
  }
  if (statusCode === 404) {
    return new HttpError(statusCode, "provider_invalid_model", message, true, details);
  }
  if (statusCode === 408) {
    return new HttpError(statusCode, "provider_timeout", message, true, details);
  }
  if (statusCode === 429) {
    return new HttpError(statusCode, "provider_rate_limited", message, true, details);
  }
  if (statusCode >= 500) {
    return new HttpError(statusCode, "provider_server_error", message, true, details);
  }
  return new HttpError(statusCode, "request_invalid", message, false, details);
}

/**
 * 只读提取 Anthropic usage 用于记账，不重建响应。
 */
function extractAnthropicUsage(body: unknown): ProviderResponse["usage"] {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;
  const inputTokens =
    typeof record.input_tokens === "number" ? record.input_tokens : undefined;
  const outputTokens =
    typeof record.output_tokens === "number" ? record.output_tokens : undefined;

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens:
      inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined
  };
}


export class AnthropicAdapter implements MessagesAdapter {
  public readonly protocol = "anthropic-messages";



  /**
   * 原生 Anthropic Messages 直通：请求体只替换 model，响应按原始字节返回。
   * 零协议转换，因此 thinking blocks、cache_control、tool_use、server_tool_use
   * 等 Anthropic 独有字段全部保真。
   */
  public async messageCompletion(
    requestBody: ProviderMessagesRequest,
    target: RouteTarget
  ): Promise<ProviderResponse> {
    let response;
    try {
      response = await request(resolveUpstreamUrl(target.endpoint.base_url, "messages"), {
        method: "POST",
        headers: buildHeaders(target),
        body: JSON.stringify({
          ...requestBody,
          model: target.model.model_name,
          stream: false
        })
      });
    } catch (error) {
      throw new HttpError(
        503,
        "provider_unreachable",
        error instanceof Error ? error.message : "provider unreachable",
        true
      );
    }

    const raw = await response.body.text();
    const body = parseJsonSafely(raw);
    if (response.statusCode >= 400) {
      throwIfProviderAccessBlocked({
        statusCode: response.statusCode,
        contentType: response.headers["content-type"],
        operation: "Anthropic messages request",
        bodyText: raw
      });

      throw toAnthropicHttpError(response.statusCode, body,
        typeof response.headers["retry-after"] === "string" ? response.headers["retry-after"] : undefined);
    }

    return {
      status: response.statusCode,
      body,
      raw,
      usage: extractAnthropicUsage(body)
    };
  }

  public async *streamMessage(
    requestBody: ProviderMessagesRequest,
    target: RouteTarget
  ): AsyncIterable<ProviderStreamChunk> {
    let response;
    try {
      response = await request(resolveUpstreamUrl(target.endpoint.base_url, "messages"), {
        method: "POST",
        headers: buildHeaders(target),
        body: JSON.stringify({
          ...requestBody,
          model: target.model.model_name,
          stream: true
        })
      });
    } catch (error) {
      throw new HttpError(
        503,
        "provider_unreachable",
        error instanceof Error ? error.message : "provider unreachable",
        true
      );
    }

    if (response.statusCode >= 400) {
      const raw = await response.body.text();
      const body = parseJsonSafely(raw);
      throwIfProviderAccessBlocked({
        statusCode: response.statusCode,
        contentType: response.headers["content-type"],
        operation: "Anthropic streaming request",
        bodyText: raw
      });
      throw toAnthropicHttpError(response.statusCode, body,
        typeof response.headers["retry-after"] === "string" ? response.headers["retry-after"] : undefined);
    }

    for await (const chunk of response.body) {
      yield {
        raw: Buffer.from(chunk).toString("utf8")
      };
    }
  }
}
