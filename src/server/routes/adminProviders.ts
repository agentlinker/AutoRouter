import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ProviderModelDiscoveryService } from "../../discovery/providerModelDiscovery.js";
import {
  ManagedProviderRepository,
  normalizeBaseUrlForMerge,
  type ManagedDiscoveredModelInput
} from "../../repositories/managedProviderRepository.js";
import {
  getOfficialProviderTemplate
} from "../../providers/officialProviderTemplates.js";
import { getProviderTemplateLoadResult } from "../../providers/providerTemplateLoader.js";
import { SecretCipher } from "../../security/secretCipher.js";
import {
  accountUnavailableReason,
  isRuntimeStatusValue
} from "../../runtime/runtimeStatus.js";
import type { RuntimeStatusService } from "../../runtime/runtimeStatusService.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import type { ManagedModelRow } from "../../db/schema.js";
import { HttpError, isHttpError } from "../../utils/httpErrors.js";
import { customHeadersSchema, RESERVED_CUSTOM_HEADER_NAMES } from "../../config/schema.js";
import { isResponsesUnsupportedError } from "../../utils/responsesFallback.js";

const protocolSchema = z.enum(["openai", "anthropic"]);
const protocolInputSchema = z.enum(["openai", "anthropic", "all"]);
const endpointKeySchema = z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/);

function parseCustomHeaders(json: string | null): Record<string, string> | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, string>;
  } catch {
    return undefined;
  }
}

function mergeTestHeaders(
  endpointHeaders: Record<string, string> | undefined,
  temporaryHeaders: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!temporaryHeaders) return endpointHeaders;
  const merged = { ...(endpointHeaders ?? {}) };
  for (const [name, value] of Object.entries(temporaryHeaders)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || RESERVED_CUSTOM_HEADER_NAMES.has(normalized)) continue;
    merged[normalized] = value;
  }
  return merged;
}

function extractTestResponseBody(body: unknown, raw?: string): string | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const choiceContent = Array.isArray(record?.choices)
    ? (record.choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content
    : undefined;
  const outputText = typeof record?.output_text === "string" ? record.output_text : undefined;
  const outputContent = Array.isArray(record?.output)
    ? record.output
        .flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const content = (item as { content?: unknown }).content;
          return Array.isArray(content)
            ? content.flatMap((part) =>
                part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                  ? [(part as { text: string }).text]
                  : []
              )
            : [];
        })
        .join("\n")
    : undefined;
  const messageContent = Array.isArray(record?.content)
    ? record.content
        .flatMap((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? [(part as { text: string }).text]
            : []
        )
        .join("\n")
    : undefined;
  const candidate = choiceContent ?? outputText ?? outputContent ?? messageContent ?? body;
  const text = typeof candidate === "string"
    ? candidate
    : candidate !== undefined && candidate !== null
      ? JSON.stringify(candidate)
      : raw ?? "";
  return text ? (text.length > 16_384 ? `${text.slice(0, 16_384)}\n…(已截断)` : text) : null;
}

const providerKindSchema = z.enum(["official", "relay", "custom"]);
const accountKeySchema = z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/);
const accountQuotaSchema = z.object({
  monthly_usd_limit: z.number().nonnegative().optional(),
  remaining_usd: z.number().nonnegative().optional(),
  remaining_requests: z.number().nonnegative().optional(),
  reset_at: z.string().optional(),
  source: z.enum(["manual", "discovered", "unknown"]).optional()
}).strict();

const createProviderBodySchema = z.object({
  provider_key: z.string().min(1).optional(),
  display_name: z.string().min(1),
  protocol: protocolInputSchema.optional(),
  base_url: z.string().url().optional(),
  endpoints: z.array(z.object({
    endpoint_key: endpointKeySchema.optional(),
    protocol: protocolInputSchema,
    base_url: z.string().url(),
    custom_headers: customHeadersSchema.optional(),
    enabled: z.boolean().optional()
  }).strict()).min(1).optional(),
  website_url: z.string().url().optional().or(z.literal("")),
  api_key: z.string().min(1),
  accounts: z.array(z.object({
    account_key: accountKeySchema,
    endpoint_key: endpointKeySchema.optional(),
    api_key: z.string().min(1),
    expires_at: z.string().min(1).optional().nullable(),
    quota: accountQuotaSchema.optional().nullable(),
    remark: z.string().optional().nullable(),
    enabled: z.boolean().optional()
  }).strict()).min(1).optional(),
  provider_kind: providerKindSchema.optional(),
  priority: z.number().int().nonnegative().default(0),
  template_id: z.string().min(1).optional(),
  trust_level: z.enum(["low", "medium", "high"]).default("low"),
  privacy_level: z.enum(["public_only", "normal", "private"]).default("normal"),
  usage_trust: z.enum(["low", "medium", "high"]).default("low")
}).strict();

const patchProviderBodySchema = z.object({
  enabled: z.boolean().optional(),
  display_name: z.string().min(1).optional(),
  priority: z.number().int().nonnegative().optional(),
  protocol: protocolInputSchema.optional(),
  base_url: z.string().url().optional(),
  endpoints: z.array(z.object({
    endpoint_key: endpointKeySchema.optional(),
    protocol: protocolInputSchema,
    base_url: z.string().url(),
    custom_headers: customHeadersSchema.optional(),
    enabled: z.boolean().optional()
  }).strict()).min(1).optional(),
  website_url: z.string().url().optional().or(z.literal("")),
  api_key: z.string().min(1).optional(),
  provider_kind: providerKindSchema.optional()
}).strict();

const providerListQuerySchema = z.object({
  sort_by: z.enum(["priority", "created_at", "updated_at"]).default("priority"),
  sort_dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50)
}).strict();

const testProviderModelBodySchema = z.object({
  account_key: accountKeySchema,
  model_key: z.string().min(1),
  prompt: z.string().trim().min(1).max(2000).default("Reply with OK."),
  endpoint_key: endpointKeySchema.optional(),
  temporary_headers: customHeadersSchema.optional()
}).strict();

const createAccountBodySchema = z.object({
  account_key: accountKeySchema,
  endpoint_key: endpointKeySchema.optional(),
  api_key: z.string().min(1),
  expires_at: z.string().min(1).optional().nullable(),
  quota: accountQuotaSchema.optional().nullable(),
  remark: z.string().optional().nullable(),
  enabled: z.boolean().optional()
}).strict();

const patchAccountBodySchema = z.object({
  endpoint_key: endpointKeySchema.optional().nullable(),
  api_key: z.string().min(1).optional(),
  expires_at: z.string().min(1).optional().nullable(),
  quota: accountQuotaSchema.optional().nullable(),
  remark: z.string().optional().nullable(),
  enabled: z.boolean().optional()
}).strict();

const mergeCheckBodySchema = z.object({
  protocol: protocolSchema,
  base_url: z.string().url()
}).strict();

const createEndpointBodySchema = z.object({
  endpoint_key: endpointKeySchema.optional(),
  protocol: protocolInputSchema,
  base_url: z.string().url(),
  custom_headers: customHeadersSchema.optional(),
  enabled: z.boolean().optional(),
  api_key: z.string().min(1).optional()
}).strict();

interface EndpointDiscoveryBundle {
  endpoint: {
    endpointKey: string;
    protocol: "openai" | "anthropic";
    baseUrl: string;
    customHeaders?: Record<string, string>;
    protocolBundleKey?: string | null;
    enabled?: boolean;
  };
  models: ManagedDiscoveredModelInput[];
  error?: unknown;
}

type Protocol = "openai" | "anthropic";
type ProtocolInput = Protocol | "all";

interface NormalizedEndpointInput {
  endpoint_key: string;
  protocol: Protocol;
  base_url: string;
  custom_headers?: Record<string, string>;
  protocol_bundle_key?: string | null;
  enabled?: boolean;
}

const patchEndpointBodySchema = z.object({
  protocol: protocolSchema.optional(),
  base_url: z.string().url().optional(),
  custom_headers: customHeadersSchema.optional(),
  enabled: z.boolean().optional()
}).strict();

const patchModelCapabilitiesBodySchema = z.object({
  model_key: z.string().min(1),
  enabled: z.boolean().optional(),
  supports_streaming: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_json_mode: z.boolean().optional()
}).strict();

async function discoverModelsForEndpoint(
  discoveryService: ProviderModelDiscoveryService,
  input: {
    providerKey: string;
    endpointKey: string;
    protocol: "openai" | "anthropic";
    baseUrl: string;
    apiKey: string;
  }
) {
  const discoveryInput = {
    providerKey: input.endpointKey === "default" ? input.providerKey : `${input.providerKey}/${input.endpointKey}`,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey
  };

  if (input.protocol === "anthropic") {
    const models = await discoveryService.listAnthropicModels(discoveryInput);
    return input.endpointKey === "default"
      ? models
      : models.map((model) => ({
          ...model,
          providerModelId: `${input.endpointKey}:${model.providerModelId}`
        }));
  }

  const models = await discoveryService.listOpenAiCompatibleModels(discoveryInput);
  return input.endpointKey === "default"
    ? models
    : models.map((model) => ({
        ...model,
        providerModelId: `${input.endpointKey}:${model.providerModelId}`
      }));
}

function normalizeEndpointInputs(input: {
  protocol?: ProtocolInput;
  baseUrl?: string;
  endpoints?: Array<{
    endpoint_key?: string;
    protocol: ProtocolInput;
    base_url: string;
    custom_headers?: Record<string, string>;
    enabled?: boolean;
  }>;
}): NormalizedEndpointInput[] {
  const expand = (endpoint: {
    endpoint_key?: string;
    protocol: ProtocolInput;
    base_url: string;
    custom_headers?: Record<string, string>;
    enabled?: boolean;
  }): NormalizedEndpointInput[] => {
    if (endpoint.protocol === "all") {
      return ["openai", "anthropic"].map((protocol) => ({
        endpoint_key: protocol,
        protocol: protocol as Protocol,
        base_url: endpoint.base_url,
        custom_headers: endpoint.custom_headers,
        protocol_bundle_key: "all",
        enabled: endpoint.enabled
      }));
    }

    return [
      {
        endpoint_key: endpoint.endpoint_key ?? endpoint.protocol,
        protocol: endpoint.protocol,
        base_url: endpoint.base_url,
        custom_headers: endpoint.custom_headers,
        protocol_bundle_key: null,
        enabled: endpoint.enabled
      }
    ];
  };

  if (input.endpoints && input.endpoints.length > 0) {
    return input.endpoints.flatMap(expand);
  }

  if (input.baseUrl !== undefined || input.protocol !== undefined) {
    if (!input.baseUrl) {
      throw new HttpError(400, "invalid_request", "Base URL is required");
    }

    return expand({
      protocol: input.protocol ?? "openai",
      base_url: input.baseUrl,
      enabled: true
    });
  }

  return [];
}

function buildProviderInput(input: {
  provider_key: string;
  display_name: string;
  website_url?: string | null;
  provider_kind?: "official" | "relay" | "custom";
  trust_level: "low" | "medium" | "high";
  privacy_level: "public_only" | "normal" | "private";
  usage_trust: "low" | "medium" | "high";
  enabled?: boolean;
  priority?: number;
}, endpointInputs: NormalizedEndpointInput[]): {
  providerKey: string;
  displayName: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  websiteUrl: string | null;
  providerKind?: "official" | "relay" | "custom";
  enabled?: boolean;
  priority?: number;
  trustLevel: "low" | "medium" | "high";
  privacyLevel: "public_only" | "normal" | "private";
  usageTrust: "low" | "medium" | "high";
} {
  const representativeEndpoint = endpointInputs[0];

  return {
    providerKey: input.provider_key,
    displayName: input.display_name,
    protocol: representativeEndpoint?.protocol ?? "openai",
    baseUrl: representativeEndpoint?.base_url ?? "",
    websiteUrl: input.website_url || null,
    providerKind: input.provider_kind,
    enabled: input.enabled,
    priority: input.priority,
    trustLevel: input.trust_level,
    privacyLevel: input.privacy_level,
    usageTrust: input.usage_trust
  };
}

function providerKeyBaseFromUrl(baseUrl: string): string {
  const hostname = new URL(baseUrl).hostname;
  const normalized = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "provider";
}

function uniqueProviderKey(
  repository: ManagedProviderRepository,
  preferredKey: string | undefined,
  baseUrl: string
): string {
  const base = preferredKey?.trim() || providerKeyBaseFromUrl(baseUrl);
  let candidate = base;
  let suffix = 2;
  while (repository.getProviderDetails(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function ensureUniqueEndpointKeys(
  endpoints: NormalizedEndpointInput[]
) {
  const seen = new Set<string>();
  const protocols = new Set<string>();

  for (const endpoint of endpoints) {
    if (seen.has(endpoint.endpoint_key)) {
      throw new HttpError(400, "invalid_request", "Endpoint Key must be unique");
    }
    if (protocols.has(endpoint.protocol)) {
      throw new HttpError(400, "duplicate_protocol", "Provider protocol must be unique");
    }

    seen.add(endpoint.endpoint_key);
    protocols.add(endpoint.protocol);
  }
}

function normalizeSubmittedAccountEndpointKey(
  endpointKey: string | undefined,
  endpoints: NormalizedEndpointInput[]
) {
  if (!endpointKey) {
    return undefined;
  }
  if (endpoints.some((endpoint) => endpoint.endpoint_key === endpointKey)) {
    return endpointKey;
  }
  if (
    endpointKey === "default" &&
    !endpoints.some((endpoint) => endpoint.endpoint_key === "default") &&
    endpoints.some((endpoint) => endpoint.endpoint_key === "openai")
  ) {
    return "openai";
  }
  return endpointKey;
}

function normalizeSubmittedAccountEndpointKeyFromDetails(
  endpointKey: string | undefined,
  endpoints: NonNullable<ReturnType<ManagedProviderRepository["getProviderDetails"]>>["endpoints"]
) {
  if (!endpointKey) {
    return undefined;
  }
  if (endpoints.some((endpoint) => endpoint.endpointKey === endpointKey)) {
    return endpointKey;
  }
  if (
    endpointKey === "default" &&
    !endpoints.some((endpoint) => endpoint.endpointKey === "default") &&
    endpoints.some((endpoint) => endpoint.endpointKey === "openai")
  ) {
    return "openai";
  }
  return endpointKey;
}

async function discoverEndpointBundles(
  discoveryService: ProviderModelDiscoveryService,
  input: {
    providerKey: string;
    apiKey: string;
    endpoints: NormalizedEndpointInput[];
  }
) {
  return Promise.all(
    input.endpoints.map(async (endpoint) => {
      let models: ManagedDiscoveredModelInput[];
      let error: unknown;
      try {
        models = await discoverModelsForEndpoint(discoveryService, {
          providerKey: input.providerKey,
          endpointKey: endpoint.endpoint_key,
          protocol: endpoint.protocol,
          baseUrl: endpoint.base_url,
          apiKey: input.apiKey
        });
      } catch (caught) {
        error = caught;
        models = [];
      }

      return {
        endpoint: {
          endpointKey: endpoint.endpoint_key,
          protocol: endpoint.protocol,
          baseUrl: endpoint.base_url,
          customHeaders: endpoint.custom_headers,
          protocolBundleKey: endpoint.protocol_bundle_key,
          enabled: endpoint.enabled
        },
        models,
        error
      };
    })
  );
}

function discoveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Provider model discovery failed";
}

/**
 * 任一 endpoint 发现失败即整体报错。
 *
 * 不能只在「所有 endpoint 都没发现到模型」时报错：那样单个 endpoint 失败会被
 * 静默吞掉，只留一条 model_sync_runs 记录，前端只显示最新一条成功记录，
 * 结果是 provider 建好了但某个 endpoint 永远空着，用户无从得知。
 */
function ensureProviderDiscoveryUsable(endpointBundles: EndpointDiscoveryBundle[]): void {
  const failedBundles = endpointBundles.filter((bundle) => bundle.error !== undefined);
  if (failedBundles.length === 0) {
    return;
  }

  const first = failedBundles[0]!;
  const failedKeys = failedBundles.map((bundle) => bundle.endpoint.endpointKey);
  throw new HttpError(
    isHttpError(first.error) ? first.error.statusCode : 502,
    isHttpError(first.error) ? first.error.code : "provider_discovery_failed",
    `Provider model discovery failed for endpoint ${failedKeys.join(", ")}: ${
      discoveryErrorMessage(first.error)
    }`,
    isHttpError(first.error) ? first.error.retryable : false,
    {
      failed_endpoints: failedBundles.map((bundle) => ({
        endpoint_key: bundle.endpoint.endpointKey,
        protocol: bundle.endpoint.protocol,
        base_url: bundle.endpoint.baseUrl,
        error: discoveryErrorMessage(bundle.error)
      }))
    }
  );
}

function serializeProviderDetails(details: ReturnType<ManagedProviderRepository["getProviderDetails"]>) {
  if (!details) {
    return null;
  }

  const serializeModel = (model: ManagedModelRow) => ({
    model_key: model.modelKey,
    provider_model_id: model.providerModelId,
    model_name: model.modelName,
    context_window: model.contextWindow,
    supports_streaming: model.supportsStreaming,
    supports_tools: model.supportsTools,
    supports_json_mode: model.supportsJsonMode,
    enabled: model.enabled,
    runtime_status: model.runtimeStatus ?? "normal",
    status_reason: model.statusReason ?? null,
    status_message: model.statusMessage ?? null,
    status_source: model.statusSource ?? "system",
    status_updated_at: model.statusUpdatedAt ?? null,
    status_cooldown_until: model.statusCooldownUntil ?? null,
    rate_limit_strike: model.rateLimitStrike ?? 0,
    recent_error_count: model.recentErrorCount ?? 0,
    endpoint_key:
      details.endpoints.find((endpoint) => endpoint.id === model.endpointId)?.endpointKey ?? "default"
  });
  const accountModelsByAccountId = new Map(
    details.accountModels.map((item) => [item.accountId, item.models] as const)
  );

  const accounts = (details.accounts ?? (details.credential ? [details.credential] : [])).map((account) => {
    const endpointKey =
      details.endpoints.find((endpoint) => endpoint.id === account.endpointId)?.endpointKey ?? null;
    let quota: Record<string, unknown> | null = null;
    if (account.quotaJson) {
      try {
        const parsed = JSON.parse(account.quotaJson) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          quota = parsed as Record<string, unknown>;
        }
      } catch {
        quota = null;
      }
    }
    return {
      account_key: account.accountKey,
      endpoint_key: endpointKey,
      enabled: account.enabled ?? true,
      runtime_status: account.runtimeStatus ?? "normal",
      status_reason: account.statusReason ?? null,
      status_message: account.statusMessage ?? null,
      status_source: account.statusSource ?? "system",
      status_updated_at: account.statusUpdatedAt ?? null,
      status_cooldown_until: account.statusCooldownUntil ?? null,
      recent_error_count: account.recentErrorCount ?? 0,
      expires_at: account.expiresAt ?? null,
      quota,
      remark: account.remark ?? null,
      key_hint: account.keyHint ?? null,
      last_error_at: account.lastErrorAt ?? null,
      last_error_code: account.lastErrorCode ?? null,
      last_error_message: account.lastErrorMessage ?? null,
      created_at: account.createdAt,
      updated_at: account.updatedAt,
      models: (accountModelsByAccountId.get(account.id) ?? []).map(serializeModel)
    };
  });

  const availableAccounts = accounts.filter((account) => {
    if (!account.enabled) {
      return false;
    }
    if (account.expires_at) {
      const expiresAt = Date.parse(account.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        return false;
      }
    }
    if (
      account.quota &&
      typeof account.quota.remaining_usd === "number" &&
      account.quota.remaining_usd <= 0
    ) {
      return false;
    }
    // 与调度侧共用同一套运行态判定，避免这里漏掉新增状态导致虚报可用数
    return (
      accountUnavailableReason({
        runtimeStatus: isRuntimeStatusValue(account.runtime_status)
          ? account.runtime_status
          : "normal",
        statusReason: account.status_reason,
        statusMessage: account.status_message,
        statusCooldownUntil: account.status_cooldown_until
      }) === null
    );
  }).length;

  return {
    provider_key: details.provider.providerKey,
    display_name: details.provider.displayName,
    protocol: details.endpoints[0]?.protocol ?? "openai",
    base_url: details.provider.baseUrl,
    website_url: details.provider.websiteUrl,
    provider_kind: details.provider.providerKind ?? "custom",
    enabled: details.provider.enabled,
    priority: details.provider.priority ?? 0,
    trust_level: details.provider.trustLevel,
    privacy_level: details.provider.privacyLevel,
    usage_trust: details.provider.usageTrust,
    created_at: details.provider.createdAt,
    updated_at: details.provider.updatedAt,
    key_hint: details.credential?.keyHint ?? accounts[0]?.key_hint ?? null,
    account_count: accounts.length,
    available_account_count: availableAccounts,
    accounts,
    endpoints: details.endpoints.map((endpoint) => ({
      endpoint_key: endpoint.endpointKey,
      protocol: endpoint.protocol,
      base_url: endpoint.baseUrl,
      custom_headers: parseCustomHeaders(endpoint.customHeadersJson),
      protocol_bundle_key: endpoint.protocolBundleKey ?? null,
      enabled: endpoint.enabled,
      supports_streaming: endpoint.supportsStreaming,
      supports_tools: endpoint.supportsTools,
      supports_json_mode: endpoint.supportsJsonMode
    })),
    latest_sync: details.latestSync
      ? {
          status: details.latestSync.status,
          error_message: details.latestSync.errorMessage,
          started_at: details.latestSync.startedAt,
          finished_at: details.latestSync.finishedAt,
          discovered_count: details.latestSync.discoveredCount
        }
      : null,
    models: details.models.map(serializeModel)
  };
}

export async function registerAdminProvidersRoutes(
  fastify: FastifyInstance,
  dependencies: {
    runtimeManager: RuntimeManagerLike;
    repository: ManagedProviderRepository;
    discoveryService: ProviderModelDiscoveryService;
    secretCipher: SecretCipher;
    runtimeStatusService?: RuntimeStatusService;
  }
) {
  fastify.get<{ Querystring: unknown }>("/admin/api/providers", async (request) => {
    const query = providerListQuerySchema.parse(request.query);
    const result = dependencies.repository.listProviderSummariesPage({
      sortBy: query.sort_by,
      sortDir: query.sort_dir,
      page: query.page,
      pageSize: query.page_size
    });
    return {
      data: result.items.map((item) => serializeProviderDetails(item)),
      meta: {
        total: result.total,
        available_total: result.availableTotal,
        page: result.page,
        page_size: result.pageSize,
        sort_by: result.sortBy,
        sort_dir: result.sortDir
      }
    };
  });

  fastify.get("/admin/api/provider-templates", async () => {
    const loaded = getProviderTemplateLoadResult();
    return {
      data: loaded.templates,
      meta: {
        load_errors: loaded.errors
      }
    };
  });

  fastify.get<{ Params: { templateId: string } }>(
    "/admin/api/provider-templates/:templateId",
    async (request) => {
      const template = getOfficialProviderTemplate(request.params.templateId);
      if (!template) {
        throw new HttpError(404, "template_not_found", "Provider template not found");
      }
      return template;
    }
  );

  fastify.post<{ Body: unknown }>("/admin/api/providers/merge-check", async (request) => {
    const body = mergeCheckBodySchema.parse(request.body);
    const matches = dependencies.repository.findProvidersByEndpoint({
      protocol: body.protocol,
      baseUrl: body.base_url
    });
    return {
      normalized_base_url: normalizeBaseUrlForMerge(body.base_url),
      matches: matches.map((item) => ({
        provider_key: item.provider.providerKey,
        display_name: item.provider.displayName,
        provider_kind: item.provider.providerKind ?? "custom",
        endpoint_key: item.endpoint.endpointKey,
        protocol: item.endpoint.protocol,
        base_url: item.endpoint.baseUrl
      }))
    };
  });

  fastify.get<{ Params: { providerKey: string } }>("/admin/api/providers/:providerKey", async (request) => {
    const details = dependencies.repository.getProviderDetails(request.params.providerKey);
    if (!details) {
      throw new HttpError(404, "provider_not_found", "Provider not found");
    }

    return serializeProviderDetails(details);
  });

  fastify.post<{
    Params: { providerKey: string };
    Body: unknown;
  }>("/admin/api/providers/:providerKey/test-model", async (request) => {
    const body = testProviderModelBodySchema.parse(request.body);
    const details = dependencies.repository.getProviderDetails(request.params.providerKey);
    if (!details) {
      throw new HttpError(404, "provider_not_found", "Provider not found");
    }

    const account = details.accounts.find((item) => item.accountKey === body.account_key);
    if (!account) {
      throw new HttpError(404, "account_not_found", "Account not found");
    }

    const model = details.models.find((item) => item.modelKey === body.model_key);
    if (!model) {
      throw new HttpError(404, "model_not_found", "Provider model not found");
    }

    const accountModels = details.accountModels.find((item) => item.accountId === account.id);
    if (!accountModels?.models.some((item) => item.id === model.id)) {
      throw new HttpError(
        400,
        "account_model_not_available",
        "Selected model is not available for this account"
      );
    }

    const accountEndpoint = account.endpointId
      ? details.endpoints.find((item) => item.id === account.endpointId)
      : null;
    const modelEndpoint = model.endpointId
      ? details.endpoints.find((item) => item.id === model.endpointId)
      : null;
    const requestedEndpoint = body.endpoint_key
      ? details.endpoints.find((item) => item.endpointKey === body.endpoint_key)
      : null;
    if (body.endpoint_key && !requestedEndpoint) {
      throw new HttpError(404, "endpoint_not_found", "Endpoint not found");
    }
    if (requestedEndpoint && accountEndpoint && requestedEndpoint.id !== accountEndpoint.id) {
      throw new HttpError(400, "account_endpoint_mismatch", "Selected account cannot access the endpoint");
    }
    if (requestedEndpoint && modelEndpoint && requestedEndpoint.id !== modelEndpoint.id) {
      throw new HttpError(400, "model_endpoint_mismatch", "Selected model belongs to another endpoint");
    }
    if (
      accountEndpoint &&
      modelEndpoint &&
      accountEndpoint.id !== modelEndpoint.id
    ) {
      throw new HttpError(
        400,
        "account_model_endpoint_mismatch",
        "Selected account cannot access the model endpoint"
      );
    }

    const endpoint =
      requestedEndpoint ??
      modelEndpoint ??
      accountEndpoint ??
      details.endpoints.find((item) => item.enabled) ??
      details.endpoints[0];
    if (!endpoint) {
      throw new HttpError(404, "endpoint_not_found", "Provider endpoint not found");
    }

    const snapshot = dependencies.runtimeManager.getSnapshot();
    const adapterType = endpoint.protocol === "anthropic" ? "anthropic" : "openai_compatible";
    const adapter = snapshot.adapters.get(adapterType);
    const endpointId = `${details.provider.providerKey}/${endpoint.endpointKey}`;
    const accountId = `${endpointId}/${account.accountKey}`;
    const target = {
      platform: {
        id: endpoint.protocol,
        protocol: endpoint.protocol
      },
      provider: {
        id: details.provider.providerKey,
        display_name: details.provider.displayName,
        priority: details.provider.priority ?? 0,
        trust_level: details.provider.trustLevel,
        privacy_level: details.provider.privacyLevel,
        usage_trust: details.provider.usageTrust
      },
      endpoint: {
        id: endpointId,
        provider_id: details.provider.providerKey,
        platform_id: endpoint.protocol,
        base_url: endpoint.baseUrl,
        custom_headers: mergeTestHeaders(
          parseCustomHeaders(endpoint.customHeadersJson),
          body.temporary_headers
        ),
        enabled: endpoint.enabled,
        capabilities: {
          streaming: endpoint.supportsStreaming,
          tools: endpoint.supportsTools,
          json_mode: endpoint.supportsJsonMode
        },
        recent_error_count: 0
      },
      account: {
        id: accountId,
        endpoint_id: endpointId,
        provider_key: details.provider.providerKey,
        endpoint_key: endpoint.endpointKey,
        account_key: account.accountKey,
        api_key_hint: account.keyHint ?? undefined,
        account_type: "api_key",
        enabled: account.enabled,
        available: true,
        runtime_status: account.runtimeStatus as never,
        status_reason: account.statusReason,
        status_message: account.statusMessage,
        status_cooldown_until: account.statusCooldownUntil,
        recent_error_count: account.recentErrorCount ?? 0
      },
      modelId: model.modelKey,
      model: {
        endpoint: endpointId,
        model_name: model.modelName,
        context_window: model.contextWindow ?? undefined,
        capabilities: {
          streaming: model.supportsStreaming,
          tools: model.supportsTools,
          json_mode: model.supportsJsonMode
        }
      },
      credential: dependencies.secretCipher.decrypt(account.apiKeyEncrypted)
    };

    const startedAt = Date.now();
    let protocol: "responses" | "chat_completions" =
      endpoint.protocol === "openai" && adapter.responseCompletion
        ? "responses"
        : "chat_completions";

    try {
      const chatRequest = {
        model: model.modelName,
        messages: [{ role: "user" as const, content: body.prompt }],
        stream: false,
        tools: [],
        temperature: 0,
        max_tokens: 8,
        metadata: {},
        context_tokens_est: 8
      };

      let providerResponse;
      if (protocol === "responses") {
        try {
          providerResponse = await adapter.responseCompletion!({
            model: model.modelName,
            input: body.prompt,
            max_output_tokens: 8,
            stream: false
          }, target);
        } catch (error) {
          if (!isResponsesUnsupportedError(error)) {
            throw error;
          }
          protocol = "chat_completions";
          providerResponse = await adapter.chatCompletion(chatRequest, target);
        }
      } else {
        providerResponse = await adapter.chatCompletion(chatRequest, target);
      }

      dependencies.runtimeStatusService?.recordSuccess({
        snapshot,
        providerKey: details.provider.providerKey,
        accountKey: account.accountKey,
        modelKey: model.modelKey
      });

      return {
        success: true,
        provider_key: details.provider.providerKey,
        account_key: account.accountKey,
        model_key: model.modelKey,
        model_name: model.modelName,
        prompt: body.prompt,
        protocol,
        latency_ms: Date.now() - startedAt,
        upstream_status: providerResponse.status,
        error_code: null,
        error_message: null,
        response_body: extractTestResponseBody(providerResponse.body, providerResponse.raw),
        endpoint_key: endpoint.endpointKey
      };
    } catch (error) {
      dependencies.runtimeStatusService?.recordFailure({
        snapshot,
        providerKey: details.provider.providerKey,
        accountKey: account.accountKey,
        modelKey: model.modelKey,
        error
      });

      return {
        success: false,
        provider_key: details.provider.providerKey,
        account_key: account.accountKey,
        model_key: model.modelKey,
        model_name: model.modelName,
        prompt: body.prompt,
        protocol,
        latency_ms: Date.now() - startedAt,
        upstream_status: isHttpError(error) ? error.statusCode : null,
        error_code: isHttpError(error) ? error.code : "provider_test_failed",
        error_message: error instanceof Error ? error.message : "Provider test failed"
      };
    }
  });

  fastify.post<{ Body: unknown }>("/admin/api/providers", async (request, reply) => {
    const body = createProviderBodySchema.parse(request.body);

    const template = body.template_id ? getOfficialProviderTemplate(body.template_id) : null;
    if (body.template_id && !template) {
      throw new HttpError(404, "template_not_found", "Provider template not found");
    }

    const endpointInputs = normalizeEndpointInputs({
      protocol: body.protocol,
      baseUrl: body.base_url,
      endpoints: body.endpoints ?? template?.endpoints.map((endpoint) => ({
        endpoint_key: endpoint.endpoint_key,
        protocol: endpoint.protocol,
        base_url: endpoint.base_url,
        custom_headers: endpoint.custom_headers,
        enabled: endpoint.enabled
      }))
    });
    if (endpointInputs.length === 0) {
      throw new HttpError(400, "invalid_request", "At least one endpoint is required");
    }
    ensureUniqueEndpointKeys(endpointInputs);
    const providerKey = uniqueProviderKey(
      dependencies.repository,
      body.provider_key ?? template?.suggested_provider_key,
      endpointInputs[0]!.base_url
    );

    const primaryAccount = body.accounts?.[0];
    if (body.accounts) {
      const accountKeys = new Set<string>();
      for (const account of body.accounts) {
        if (accountKeys.has(account.account_key)) {
          throw new HttpError(400, "duplicate_account_key", "Account Key must be unique");
        }
        accountKeys.add(account.account_key);
      }
    }
    const discoveryApiKey = primaryAccount?.api_key ?? body.api_key;
    const endpointBundles = await discoverEndpointBundles(dependencies.discoveryService, {
      providerKey,
      apiKey: discoveryApiKey,
      endpoints: endpointInputs
    });
    ensureProviderDiscoveryUsable(endpointBundles);

    const details = dependencies.repository.createProviderWithEndpointBundles({
      provider: buildProviderInput({
        ...body,
        provider_key: providerKey,
        website_url: body.website_url || template?.website_url || "",
        provider_kind: body.provider_kind ?? template?.provider_kind
      }, endpointInputs),
      encryptedApiKey: dependencies.secretCipher.encrypt(discoveryApiKey),
      apiKeyHint: ManagedProviderRepository.toApiKeyHint(discoveryApiKey),
      defaultAccount: primaryAccount
        ? {
            accountKey: primaryAccount.account_key,
            endpointKey: normalizeSubmittedAccountEndpointKey(primaryAccount.endpoint_key, endpointInputs),
            enabled: primaryAccount.enabled,
            expiresAt: primaryAccount.expires_at ?? null,
            quotaJson: primaryAccount.quota ? JSON.stringify(primaryAccount.quota) : null,
            remark: primaryAccount.remark?.trim() || null
          }
        : undefined,
      endpointBundles
    });

    for (const account of body.accounts?.slice(1) ?? []) {
      const created = dependencies.repository.createAccount(providerKey, {
        accountKey: account.account_key,
        endpointKey: normalizeSubmittedAccountEndpointKey(account.endpoint_key, endpointInputs),
        encryptedApiKey: dependencies.secretCipher.encrypt(account.api_key),
        apiKeyHint: ManagedProviderRepository.toApiKeyHint(account.api_key),
        enabled: account.enabled,
        expiresAt: account.expires_at ?? null,
        quotaJson: account.quota ? JSON.stringify(account.quota) : null,
        remark: account.remark?.trim() || null
      });
      if (!created) {
        throw new HttpError(400, "invalid_account", `Unable to create account ${account.account_key}`);
      }
    }

    await dependencies.runtimeManager.reload();
    reply.status(201);
    return serializeProviderDetails(
      dependencies.repository.getProviderDetails(providerKey) ?? details
    );
  });

  fastify.post<{ Params: { providerKey: string } }>(
    "/admin/api/providers/:providerKey/sync-models",
    async (request) => {
      const details = dependencies.repository.getProviderDetails(request.params.providerKey);
      if (!details || !details.credential) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }

      const apiKey = dependencies.secretCipher.decrypt(details.credential.apiKeyEncrypted);
      const endpoints = details.endpoints.filter((item) => item.enabled);
      if (endpoints.length === 0) {
        throw new HttpError(404, "endpoint_not_found", "Provider endpoint not found");
      }

      let updated = details;
      const failures: Array<{ endpoint_key: string; error: string }> = [];
      for (const endpoint of endpoints) {
        let discoveredModels: ManagedDiscoveredModelInput[] = [];
        try {
          discoveredModels = await discoverModelsForEndpoint(dependencies.discoveryService, {
            providerKey: details.provider.providerKey,
            endpointKey: endpoint.endpointKey,
            protocol: endpoint.protocol as "openai" | "anthropic",
            baseUrl: endpoint.baseUrl,
            apiKey
          });
        } catch (error) {
          updated = dependencies.repository.syncProviderModels(details.provider.providerKey, {
            endpointKey: endpoint.endpointKey,
            accountKey: details.accounts?.[0]?.accountKey ?? details.credential?.accountKey ?? "default",
            status: "error",
            errorMessage: error instanceof Error ? error.message : "discovery_failed",
            models: []
          }) ?? updated;
          failures.push({
            endpoint_key: endpoint.endpointKey,
            error: error instanceof Error ? error.message : "discovery_failed"
          });
          continue;
        }

        updated = dependencies.repository.syncProviderModels(details.provider.providerKey, {
          endpointKey: endpoint.endpointKey,
          accountKey: details.accounts?.[0]?.accountKey ?? details.credential?.accountKey ?? "default",
          status: "success",
          models: discoveredModels
        }) ?? updated;
      }

      await dependencies.runtimeManager.reload();
      if (failures.length > 0) {
        throw new HttpError(
          502,
          "provider_discovery_failed",
          `Provider model discovery failed for endpoint ${
            failures.map((item) => item.endpoint_key).join(", ")
          }: ${failures[0]!.error}`,
          false,
          { failed_endpoints: failures }
        );
      }

      return serializeProviderDetails(updated);
    }
  );

  fastify.patch<{ Params: { providerKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey",
    async (request) => {
      const body = patchProviderBodySchema.parse(request.body);
      const existing = dependencies.repository.getProviderDetails(request.params.providerKey);
      if (!existing) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }

      const credentialForSync = body.api_key
        ? body.api_key
        : existing.credential
          ? dependencies.secretCipher.decrypt(existing.credential.apiKeyEncrypted)
          : null;
      const endpointInputs = normalizeEndpointInputs({
        protocol: body.protocol,
        baseUrl: body.base_url,
        endpoints: body.endpoints
      });
      const shouldReplaceEndpoints =
        body.endpoints !== undefined || body.base_url !== undefined || body.protocol !== undefined;

      if (shouldReplaceEndpoints) {
        if (endpointInputs.length === 0) {
          throw new HttpError(400, "invalid_request", "At least one endpoint is required");
        }
        ensureUniqueEndpointKeys(endpointInputs);
        if (!credentialForSync) {
          throw new HttpError(400, "credential_required", "API key is required when changing endpoints");
        }

        const endpointBundles = await discoverEndpointBundles(dependencies.discoveryService, {
          providerKey: existing.provider.providerKey,
          apiKey: credentialForSync,
          endpoints: endpointInputs
        });
        ensureProviderDiscoveryUsable(endpointBundles);

        const updated = dependencies.repository.replaceProviderWithEndpointBundles({
          providerKey: existing.provider.providerKey,
          provider: buildProviderInput(
            {
              provider_key: existing.provider.providerKey,
              display_name: body.display_name ?? existing.provider.displayName,
              website_url: body.website_url === "" ? null : body.website_url ?? existing.provider.websiteUrl,
              provider_kind:
                body.provider_kind ??
                (existing.provider.providerKind as "official" | "relay" | "custom" | undefined),
              priority: body.priority ?? existing.provider.priority ?? 0,
              trust_level: existing.provider.trustLevel as "low" | "medium" | "high",
              privacy_level: existing.provider.privacyLevel as "public_only" | "normal" | "private",
              usage_trust: existing.provider.usageTrust as "low" | "medium" | "high",
              enabled: body.enabled ?? existing.provider.enabled
            },
            endpointInputs
          ),
          encryptedApiKey: body.api_key ? dependencies.secretCipher.encrypt(body.api_key) : undefined,
          apiKeyHint: body.api_key ? ManagedProviderRepository.toApiKeyHint(body.api_key) : undefined,
          endpointBundles
        });

        await dependencies.runtimeManager.reload();
        return serializeProviderDetails(updated);
      }

      dependencies.repository.updateProvider(request.params.providerKey, {
        enabled: body.enabled,
        displayName: body.display_name,
        priority: body.priority,
        websiteUrl: body.website_url === "" ? null : body.website_url,
        providerKind: body.provider_kind
      });

      if (body.api_key) {
        dependencies.repository.updateCredential(
          request.params.providerKey,
          dependencies.secretCipher.encrypt(body.api_key),
          ManagedProviderRepository.toApiKeyHint(body.api_key)
        );
      }

      const updated = dependencies.repository.getProviderDetails(request.params.providerKey);
      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(updated);
    }
  );

  fastify.post<{ Params: { providerKey: string } }>(
    "/admin/api/providers/:providerKey/promote-priority",
    async (request) => {
      const updated = dependencies.repository.elevateProviderPriority(request.params.providerKey);
      if (!updated) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }
      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(updated);
    }
  );

  fastify.post<{ Params: { providerKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey/endpoints",
    async (request, reply) => {
      const body = createEndpointBodySchema.parse(request.body);
      const existing = dependencies.repository.getProviderDetails(request.params.providerKey);
      if (!existing || !existing.credential) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }

      const endpointInputs = normalizeEndpointInputs({
        endpoints: [{
          endpoint_key: body.endpoint_key,
          protocol: body.protocol,
          base_url: body.base_url,
          custom_headers: body.custom_headers,
          enabled: body.enabled
        }]
      });
      ensureUniqueEndpointKeys(endpointInputs);

      for (const endpointInput of endpointInputs) {
        if (dependencies.repository.getProviderEndpoint(request.params.providerKey, endpointInput.endpoint_key)) {
          throw new HttpError(409, "endpoint_exists", "Provider endpoint already exists");
        }
        if (dependencies.repository.getProviderEndpointByProtocol(request.params.providerKey, endpointInput.protocol)) {
          throw new HttpError(409, "protocol_exists", "Provider protocol already exists");
        }
      }

      const apiKey = body.api_key ?? dependencies.secretCipher.decrypt(existing.credential.apiKeyEncrypted);
      const endpointBundles = await discoverEndpointBundles(dependencies.discoveryService, {
        providerKey: existing.provider.providerKey,
        apiKey,
        endpoints: endpointInputs
      });
      ensureProviderDiscoveryUsable(endpointBundles);

      let updated = existing;
      for (const bundle of endpointBundles) {
        const endpoint = dependencies.repository.createProviderEndpoint(request.params.providerKey, {
          endpointKey: bundle.endpoint.endpointKey,
          protocol: bundle.endpoint.protocol,
          baseUrl: bundle.endpoint.baseUrl,
          customHeaders: bundle.endpoint.customHeaders,
          protocolBundleKey: bundle.endpoint.protocolBundleKey,
          enabled: bundle.endpoint.enabled
        });

        if (!endpoint) {
          throw new HttpError(404, "provider_not_found", "Provider not found");
        }

        updated = dependencies.repository.syncProviderModels(existing.provider.providerKey, {
          endpointKey: endpoint.endpointKey,
          accountKey: existing.accounts?.[0]?.accountKey ?? existing.credential?.accountKey ?? "default",
          status: "success",
          models: bundle.models
        }) ?? updated;
      }

      if (body.api_key) {
        dependencies.repository.updateCredential(
          request.params.providerKey,
          dependencies.secretCipher.encrypt(body.api_key),
          ManagedProviderRepository.toApiKeyHint(body.api_key)
        );
      }

      await dependencies.runtimeManager.reload();
      reply.status(201);
      return serializeProviderDetails(updated);
    }
  );

  fastify.patch<{ Params: { providerKey: string; endpointKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey/endpoints/:endpointKey",
    async (request) => {
      const body = patchEndpointBodySchema.parse(request.body);
      if (body.protocol) {
        const existingProtocolEndpoint = dependencies.repository.getProviderEndpointByProtocol(
          request.params.providerKey,
          body.protocol
        );
        if (
          existingProtocolEndpoint &&
          existingProtocolEndpoint.endpointKey !== request.params.endpointKey
        ) {
          throw new HttpError(409, "protocol_exists", "Provider protocol already exists");
        }
      }
      const updated = dependencies.repository.updateProviderEndpoint(
        request.params.providerKey,
        request.params.endpointKey,
        {
          protocol: body.protocol,
          baseUrl: body.base_url,
          customHeaders: body.custom_headers,
          enabled: body.enabled
        }
      );

      if (!updated) {
        throw new HttpError(404, "endpoint_not_found", "Provider endpoint not found");
      }

      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(updated);
    }
  );

  fastify.post<{ Params: { providerKey: string; endpointKey: string } }>(
    "/admin/api/providers/:providerKey/endpoints/:endpointKey/sync-models",
    async (request) => {
      const details = dependencies.repository.getProviderDetails(request.params.providerKey);
      const endpoint = dependencies.repository.getProviderEndpoint(
        request.params.providerKey,
        request.params.endpointKey
      );
      if (!details || !details.credential || !endpoint) {
        throw new HttpError(404, "endpoint_not_found", "Provider endpoint not found");
      }

      const apiKey = dependencies.secretCipher.decrypt(details.credential.apiKeyEncrypted);
      const discoveredModels = await discoverModelsForEndpoint(dependencies.discoveryService, {
        providerKey: details.provider.providerKey,
        endpointKey: endpoint.endpointKey,
        protocol: endpoint.protocol as "openai" | "anthropic",
        baseUrl: endpoint.baseUrl,
        apiKey
      });

      const updated = dependencies.repository.syncProviderModels(details.provider.providerKey, {
        endpointKey: endpoint.endpointKey,
        accountKey: details.accounts?.[0]?.accountKey ?? details.credential?.accountKey ?? "default",
        status: "success",
        models: discoveredModels
      });

      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(updated);
    }
  );

  fastify.patch<{ Params: { providerKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey/models",
    async (request) => {
      const body = patchModelCapabilitiesBodySchema.parse(request.body);
      const updated = dependencies.repository.updateModelCapabilities(request.params.providerKey, {
        modelKey: body.model_key,
        enabled: body.enabled,
        supportsStreaming: body.supports_streaming,
        supportsTools: body.supports_tools,
        supportsJsonMode: body.supports_json_mode
      });

      if (!updated) {
        throw new HttpError(404, "model_not_found", "Provider model not found");
      }

      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(updated);
    }
  );

  fastify.get<{ Params: { providerKey: string } }>(
    "/admin/api/providers/:providerKey/accounts",
    async (request) => {
      const details = dependencies.repository.getProviderDetails(request.params.providerKey);
      if (!details) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }
      return {
        data: serializeProviderDetails(details)?.accounts ?? []
      };
    }
  );

  fastify.post<{ Params: { providerKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey/accounts",
    async (request, reply) => {
      const body = createAccountBodySchema.parse(request.body);
      const existing = dependencies.repository.getProviderDetails(request.params.providerKey);
      if (!existing) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }
      if (dependencies.repository.getAccount(request.params.providerKey, body.account_key)) {
        throw new HttpError(409, "account_exists", "Account already exists");
      }

      const created = dependencies.repository.createAccount(request.params.providerKey, {
        accountKey: body.account_key,
        endpointKey: normalizeSubmittedAccountEndpointKeyFromDetails(body.endpoint_key, existing.endpoints),
        encryptedApiKey: dependencies.secretCipher.encrypt(body.api_key),
        apiKeyHint: ManagedProviderRepository.toApiKeyHint(body.api_key),
        enabled: body.enabled,
        expiresAt: body.expires_at ?? null,
        quotaJson: body.quota ? JSON.stringify(body.quota) : null,
        remark: body.remark?.trim() || null
      });
      if (!created) {
        throw new HttpError(400, "invalid_request", "Failed to create account");
      }

      await dependencies.runtimeManager.reload();
      reply.status(201);
      return serializeProviderDetails(
        dependencies.repository.getProviderDetails(request.params.providerKey)
      );
    }
  );

  fastify.patch<{ Params: { providerKey: string; accountKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey/accounts/:accountKey",
    async (request) => {
      const body = patchAccountBodySchema.parse(request.body);
      const existing = dependencies.repository.getAccount(
        request.params.providerKey,
        request.params.accountKey
      );
      if (!existing) {
        throw new HttpError(404, "account_not_found", "Account not found");
      }
      const providerDetails = dependencies.repository.getProviderDetails(request.params.providerKey);
      if (!providerDetails) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }

      const updated = dependencies.repository.updateAccount(
        request.params.providerKey,
        request.params.accountKey,
        {
          endpointKey:
            body.endpoint_key === null
              ? null
              : normalizeSubmittedAccountEndpointKeyFromDetails(body.endpoint_key, providerDetails.endpoints),
          encryptedApiKey: body.api_key
            ? dependencies.secretCipher.encrypt(body.api_key)
            : undefined,
          apiKeyHint: body.api_key
            ? ManagedProviderRepository.toApiKeyHint(body.api_key)
            : undefined,
          enabled: body.enabled,
          expiresAt: body.expires_at,
          quotaJson:
            body.quota === undefined
              ? undefined
              : body.quota === null
                ? null
                : JSON.stringify(body.quota),
          remark: body.remark === undefined ? undefined : body.remark?.trim() || null
        }
      );
      if (!updated) {
        throw new HttpError(400, "invalid_request", "Failed to update account");
      }

      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(
        dependencies.repository.getProviderDetails(request.params.providerKey)
      );
    }
  );

  fastify.post<{ Params: { providerKey: string; accountKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey/accounts/:accountKey/sync-models",
    async (request) => {
      const details = dependencies.repository.getProviderDetails(request.params.providerKey);
      const account = dependencies.repository.getAccount(
        request.params.providerKey,
        request.params.accountKey
      );
      if (!details || !account) {
        throw new HttpError(404, "account_not_found", "Account not found");
      }

      const apiKey = dependencies.secretCipher.decrypt(account.apiKeyEncrypted);
      const boundEndpoint = account.endpointId
        ? details.endpoints.find((item) => item.id === account.endpointId)
        : null;
      const endpoints = boundEndpoint
        ? [boundEndpoint]
        : details.endpoints.filter((item) => item.enabled);

      if (endpoints.length === 0) {
        throw new HttpError(404, "endpoint_not_found", "Provider endpoint not found");
      }

      let lastUpdated = details;
      const failures: Array<{ endpoint_key: string; error: string }> = [];
      for (const endpoint of endpoints) {
        let models: ManagedDiscoveredModelInput[] = [];
        try {
          models = await discoverModelsForEndpoint(dependencies.discoveryService, {
            providerKey: details.provider.providerKey,
            endpointKey: endpoint.endpointKey,
            protocol: endpoint.protocol as "openai" | "anthropic",
            baseUrl: endpoint.baseUrl,
            apiKey
          });
        } catch (error) {
          lastUpdated = dependencies.repository.syncProviderModels(details.provider.providerKey, {
            endpointKey: endpoint.endpointKey,
            accountKey: account.accountKey,
            status: "error",
            errorMessage: error instanceof Error ? error.message : "discovery_failed",
            models: []
          }) ?? lastUpdated;
          failures.push({
            endpoint_key: endpoint.endpointKey,
            error: error instanceof Error ? error.message : "discovery_failed"
          });
          continue;
        }

        lastUpdated = dependencies.repository.syncProviderModels(details.provider.providerKey, {
          endpointKey: endpoint.endpointKey,
          accountKey: account.accountKey,
          status: "success",
          models
        }) ?? lastUpdated;
      }

      await dependencies.runtimeManager.reload();

      // 成功的 endpoint 已落库，但失败必须让调用方看到，不能只留在 model_sync_runs 里
      if (failures.length > 0) {
        throw new HttpError(
          502,
          "provider_discovery_failed",
          `Provider model discovery failed for endpoint ${
            failures.map((item) => item.endpoint_key).join(", ")
          }: ${failures[0]!.error}`,
          false,
          { failed_endpoints: failures }
        );
      }

      return serializeProviderDetails(lastUpdated);
    }
  );

  fastify.delete<{ Params: { providerKey: string; accountKey: string } }>(
    "/admin/api/providers/:providerKey/accounts/:accountKey",
    async (request, reply) => {
      const existing = dependencies.repository.getAccount(
        request.params.providerKey,
        request.params.accountKey
      );
      if (!existing) {
        throw new HttpError(404, "account_not_found", "Account not found");
      }
      const deleted = dependencies.repository.deleteAccount(
        request.params.providerKey,
        request.params.accountKey
      );
      if (!deleted) {
        throw new HttpError(
          400,
          "account_required",
          "Provider must keep at least one account"
        );
      }
      await dependencies.runtimeManager.reload();
      reply.status(204);
      return null;
    }
  );

  fastify.delete<{ Params: { providerKey: string } }>(
    "/admin/api/providers/:providerKey",
    async (request, reply) => {
      const deleted = dependencies.repository.deleteProvider(request.params.providerKey);
      if (!deleted) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }

      await dependencies.runtimeManager.reload();
      reply.status(204);
      return null;
    }
  );
}
