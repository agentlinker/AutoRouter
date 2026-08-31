import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ProviderModelDiscoveryService } from "../../discovery/providerModelDiscovery.js";
import {
  ManagedProviderRepository,
  normalizeBaseUrlForMerge,
  type ManagedDiscoveredModelInput,
  type ManagedProviderDetails
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
import type { ManagedCredentialRow, ManagedModelRow } from "../../db/schema.js";
import { HttpError, isHttpError } from "../../utils/httpErrors.js";
import { customHeadersSchema, RESERVED_CUSTOM_HEADER_NAMES } from "../../config/schema.js";
import { isResponsesUnsupportedError } from "../../utils/responsesFallback.js";
import { providerKeyPattern, suggestProviderKey } from "../../utils/providerKey.js";

const protocolSchema = z.enum(["openai", "anthropic"]);
const protocolInputSchema = z.enum(["openai", "anthropic", "all"]);
const endpointKeySchema = z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/);
const providerKeySchema = z.string().trim().regex(
  providerKeyPattern,
  "Provider Key 只能包含小写字母、数字和连字符"
);

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

const manualModelInputSchema = z.object({
  model_name: z.string().trim().min(1),
  provider_model_id: z.string().trim().min(1).optional(),
  context_window: z.number().int().positive().optional(),
  supports_streaming: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_json_mode: z.boolean().optional()
}).strict();

function normalizeUrlInput(value: string): string {
  return value.replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, "");
}

const urlInputSchema = z.string().transform(normalizeUrlInput).pipe(z.string().url());
const websiteUrlInputSchema = z.string()
  .transform(normalizeUrlInput)
  .pipe(z.string().url().or(z.literal("")));

const createProviderBodySchema = z.object({
  provider_key: providerKeySchema.optional(),
  display_name: z.string().min(1),
  protocol: protocolInputSchema.optional(),
  base_url: urlInputSchema.optional(),
  endpoints: z.array(z.object({
    protocol: protocolInputSchema,
    base_url: urlInputSchema,
    custom_headers: customHeadersSchema.optional(),
    enabled: z.boolean().optional()
  }).strict()).min(1).optional(),
  website_url: websiteUrlInputSchema.optional(),
  model_catalog_url: z.string().url().optional().nullable().or(z.literal("")),
  api_key: z.string().min(1),
  accounts: z.array(z.object({
    account_key: accountKeySchema,
    api_key: z.string().min(1),
    expires_at: z.string().min(1).optional().nullable(),
    quota: accountQuotaSchema.optional().nullable(),
    remark: z.string().optional().nullable(),
    enabled: z.boolean().optional()
  }).strict()).min(1).optional(),
  provider_kind: providerKindSchema.optional(),
  models: z.array(manualModelInputSchema).optional(),
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
  base_url: urlInputSchema.optional(),
  endpoints: z.array(z.object({
    protocol: protocolInputSchema,
    base_url: urlInputSchema,
    custom_headers: customHeadersSchema.optional(),
    enabled: z.boolean().optional()
  }).strict()).min(1).optional(),
  website_url: websiteUrlInputSchema.optional(),
  model_catalog_url: z.string().url().optional().nullable().or(z.literal("")),
  api_key: z.string().min(1).optional(),
  provider_kind: providerKindSchema.optional(),
  models: z.array(manualModelInputSchema).optional()
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
  endpoint_key: endpointKeySchema,
  temporary_headers: customHeadersSchema.optional()
}).strict();

const clearAccountEndpointModelStatusBodySchema = z.object({
  account_key: accountKeySchema,
  model_key: z.string().min(1),
  endpoint_key: endpointKeySchema
}).strict();

const createAccountBodySchema = z.object({
  account_key: accountKeySchema,
  api_key: z.string().min(1),
  expires_at: z.string().min(1).optional().nullable(),
  quota: accountQuotaSchema.optional().nullable(),
  remark: z.string().optional().nullable(),
  enabled: z.boolean().optional()
}).strict();

const patchAccountBodySchema = z.object({
  api_key: z.string().min(1).optional(),
  expires_at: z.string().min(1).optional().nullable(),
  quota: accountQuotaSchema.optional().nullable(),
  remark: z.string().optional().nullable(),
  enabled: z.boolean().optional()
}).strict();

const mergeCheckBodySchema = z.object({
  provider_key: providerKeySchema.optional(),
  endpoints: z.array(z.object({
    protocol: protocolInputSchema,
    base_url: urlInputSchema
  }).strict()).min(1)
}).strict();

const createEndpointBodySchema = z.object({
  protocol: protocolInputSchema,
  base_url: urlInputSchema,
  custom_headers: customHeadersSchema.optional(),
  enabled: z.boolean().optional()
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
  base_url: urlInputSchema.optional(),
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

const createProviderModelBodySchema = manualModelInputSchema.extend({
  model_key: z.string().min(1).optional()
}).strict();

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
        endpoint_key: endpoint.protocol,
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
  model_catalog_url?: string | null;
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
  modelCatalogUrl: string | null;
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
    modelCatalogUrl: input.model_catalog_url || null,
    providerKind: input.provider_kind,
    enabled: input.enabled,
    priority: input.priority,
    trustLevel: input.trust_level,
    privacyLevel: input.privacy_level,
    usageTrust: input.usage_trust
  };
}

function ensureUniqueEndpointKeys(
  endpoints: NormalizedEndpointInput[]
) {
  const seen = new Set<string>();
  const protocols = new Set<string>();

  for (const endpoint of endpoints) {
    if (protocols.has(endpoint.protocol)) {
      throw new HttpError(400, "duplicate_protocol", "Provider protocol must be unique");
    }
    if (seen.has(endpoint.endpoint_key)) {
      throw new HttpError(400, "invalid_request", "Endpoint Key must be unique");
    }

    seen.add(endpoint.endpoint_key);
    protocols.add(endpoint.protocol);
  }
}

function buildManualModel(
  providerKey: string,
  input: z.infer<typeof manualModelInputSchema> & { model_key?: string }
): ManagedDiscoveredModelInput {
  const providerModelId = input.provider_model_id?.trim() || input.model_name.trim();
  const modelKey = input.model_key?.trim() || `${providerKey}/${providerModelId}`;

  return {
    modelKey,
    providerModelId,
    modelName: input.model_name.trim(),
    contextWindow: input.context_window,
    supportsStreaming: input.supports_streaming ?? true,
    supportsTools: input.supports_tools ?? false,
    supportsJsonMode: input.supports_json_mode ?? false,
    rawMetadataJson: JSON.stringify({
      source: "manual",
      provider_model_id: providerModelId,
      model_name: input.model_name.trim()
    })
  };
}

function mergeManualModelsIntoBundles(
  providerKey: string,
  endpointBundles: EndpointDiscoveryBundle[],
  manualModels: Array<z.infer<typeof manualModelInputSchema> & { model_key?: string }> | undefined
) {
  if (!manualModels || manualModels.length === 0) {
    return endpointBundles;
  }

  const bundlesByEndpointKey = new Map(
    endpointBundles.map((bundle) => [bundle.endpoint.endpointKey, bundle])
  );
  for (const model of manualModels) {
    const endpointKey = endpointBundles[0]?.endpoint.endpointKey ?? "openai";
    const bundle = bundlesByEndpointKey.get(endpointKey);
    if (!bundle) {
      throw new HttpError(400, "invalid_model_endpoint", `Model endpoint ${endpointKey} does not exist`);
    }

    const manual = buildManualModel(providerKey, model);
    const existingIndex = bundle.models.findIndex(
      (item) => item.modelKey === manual.modelKey || item.providerModelId === manual.providerModelId
    );
    if (existingIndex >= 0) {
      bundle.models[existingIndex] = manual;
    } else {
      bundle.models.push(manual);
    }
  }

  return endpointBundles;
}

function buildEndpointBundles(
  endpoints: NormalizedEndpointInput[],
  models: ManagedDiscoveredModelInput[]
): EndpointDiscoveryBundle[] {
  return endpoints.map((endpoint, index) => ({
    endpoint: {
      endpointKey: endpoint.endpoint_key,
      protocol: endpoint.protocol,
      baseUrl: endpoint.base_url,
      customHeaders: endpoint.custom_headers,
      protocolBundleKey: endpoint.protocol_bundle_key,
      enabled: endpoint.enabled
    },
    models: index === 0 ? models : []
  }));
}

async function discoverProviderCatalog(
  discoveryService: ProviderModelDiscoveryService,
  input: {
    providerKey: string;
    apiKey: string;
    modelCatalogUrl?: string | null;
    endpoints: NormalizedEndpointInput[];
  }
) {
  return discoveryService.discoverProviderModels({
    providerKey: input.providerKey,
    apiKey: input.apiKey,
    modelCatalogUrl: input.modelCatalogUrl,
    endpoints: input.endpoints.map((endpoint) => ({
      endpointKey: endpoint.endpoint_key,
      protocol: endpoint.protocol,
      baseUrl: endpoint.base_url,
      enabled: endpoint.enabled
    }))
  });
}

function discoveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Provider model discovery failed";
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
    recent_error_count: model.recentErrorCount ?? 0
  });
  const accountModelsByAccountId = new Map(
    details.accountModels.map((item) => [item.accountId, item.models] as const)
  );
  const accountById = new Map(details.accounts.map((account) => [account.id, account]));
  const endpointById = new Map(details.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const modelById = new Map(details.models.map((model) => [model.id, model]));

  const accounts = (details.accounts ?? (details.credential ? [details.credential] : [])).map((account) => {
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
    model_catalog_url: details.provider.modelCatalogUrl,
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
      runtime_status: endpoint.runtimeStatus,
      status_reason: endpoint.statusReason,
      status_message: endpoint.statusMessage,
      status_source: endpoint.statusSource,
      status_updated_at: endpoint.statusUpdatedAt,
      status_cooldown_until: endpoint.statusCooldownUntil,
      recent_error_count: endpoint.recentErrorCount,
      supports_streaming: endpoint.supportsStreaming,
      supports_tools: endpoint.supportsTools,
      supports_json_mode: endpoint.supportsJsonMode
    })),
    latest_sync: details.latestSync
      ? {
          account_key:
            details.latestSync.accountId
              ? accountById.get(details.latestSync.accountId)?.accountKey ?? null
              : null,
          catalog_url: details.latestSync.catalogUrl,
          status: details.latestSync.status,
          error_message: details.latestSync.errorMessage,
          started_at: details.latestSync.startedAt,
          finished_at: details.latestSync.finishedAt,
          discovered_count: details.latestSync.discoveredCount
        }
      : null,
    models: details.models.map(serializeModel),
    account_endpoint_models: details.accountEndpointModels.flatMap((observation) => {
      const account = accountById.get(observation.accountId);
      const endpoint = endpointById.get(observation.endpointId);
      const model = modelById.get(observation.managedModelId);
      if (!account || !endpoint || !model) {
        return [];
      }
      return [{
        account_key: account.accountKey,
        endpoint_key: endpoint.endpointKey,
        model_key: model.modelKey,
        runtime_status: observation.runtimeStatus,
        status_reason: observation.statusReason,
        status_message: observation.statusMessage,
        status_source: observation.statusSource,
        status_updated_at: observation.statusUpdatedAt,
        status_cooldown_until: observation.statusCooldownUntil,
        last_success_at: observation.lastSuccessAt,
        last_error_at: observation.lastErrorAt,
        last_error_code: observation.lastErrorCode,
        last_error_message: observation.lastErrorMessage
      }];
    })
  };
}

interface AdminProviderDependencies {
  runtimeManager: RuntimeManagerLike;
  repository: ManagedProviderRepository;
  discoveryService: ProviderModelDiscoveryService;
  secretCipher: SecretCipher;
  runtimeStatusService?: RuntimeStatusService;
}

async function syncAccountModels(
  dependencies: AdminProviderDependencies,
  details: ManagedProviderDetails,
  account: ManagedCredentialRow
): Promise<ManagedProviderDetails> {
  const apiKey = dependencies.secretCipher.decrypt(account.apiKeyEncrypted);
  try {
    const result = await dependencies.discoveryService.discoverProviderModels({
      providerKey: details.provider.providerKey,
      apiKey,
      modelCatalogUrl: details.provider.modelCatalogUrl,
      endpoints: details.endpoints.map((endpoint) => ({
        endpointKey: endpoint.endpointKey,
        protocol: endpoint.protocol as "openai" | "anthropic",
        baseUrl: endpoint.baseUrl,
        enabled: endpoint.enabled
      }))
    });
    return dependencies.repository.syncProviderModels(details.provider.providerKey, {
      accountKey: account.accountKey,
      catalogUrl: result.catalogUrl,
      status: "success",
      models: result.models
    }) ?? details;
  } catch (error) {
    return dependencies.repository.syncProviderModels(details.provider.providerKey, {
      accountKey: account.accountKey,
      catalogUrl: details.provider.modelCatalogUrl,
      status: "error",
      errorMessage: discoveryErrorMessage(error),
      models: []
    }) ?? details;
  }
}

export async function registerAdminProvidersRoutes(
  fastify: FastifyInstance,
  dependencies: AdminProviderDependencies
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
    const endpointInputs = normalizeEndpointInputs({
      endpoints: body.endpoints
    });
    ensureUniqueEndpointKeys(endpointInputs);
    const candidates = dependencies.repository.findProvidersByEndpointSet(
      endpointInputs.map((endpoint) => ({
        protocol: endpoint.protocol,
        baseUrl: endpoint.base_url
      }))
    );
    const keyConflict = body.provider_key
      ? dependencies.repository.getProviderDetails(body.provider_key)
      : null;
    return {
      normalized_endpoints: endpointInputs.map((endpoint) => ({
        protocol: endpoint.protocol,
        base_url: normalizeBaseUrlForMerge(endpoint.base_url)
      })),
      key_conflict: keyConflict
        ? {
            provider_key: keyConflict.provider.providerKey,
            display_name: keyConflict.provider.displayName
          }
        : null,
      candidates: candidates.map((item) => ({
        provider_key: item.provider.providerKey,
        display_name: item.provider.displayName,
        provider_kind: item.provider.providerKind ?? "custom",
        relation: item.relation,
        matching_endpoints: item.matchingEndpoints.map((endpoint) => ({
          endpoint_key: endpoint.endpointKey,
          protocol: endpoint.protocol,
          base_url: endpoint.baseUrl
        })),
        conflicting_endpoints: item.conflictingEndpoints.map((endpoint) => ({
          protocol: endpoint.protocol,
          candidate_base_url: endpoint.candidateBaseUrl,
          existing_base_url: endpoint.existingBaseUrl
        })),
        candidate_only_endpoints: item.candidateOnlyEndpoints.map((endpoint) => ({
          protocol: endpoint.protocol,
          base_url: endpoint.baseUrl
        })),
        existing_only_endpoints: item.existingOnlyEndpoints.map((endpoint) => ({
          endpoint_key: endpoint.endpointKey,
          protocol: endpoint.protocol,
          base_url: endpoint.baseUrl
        }))
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

    const endpoint = details.endpoints.find((item) => item.endpointKey === body.endpoint_key);
    if (!endpoint) {
      throw new HttpError(404, "endpoint_not_found", "Endpoint not found");
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
        endpointKey: endpoint.endpointKey,
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
        endpointKey: endpoint.endpointKey,
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
        error_message: error instanceof Error ? error.message : "Provider test failed",
        endpoint_key: endpoint.endpointKey
      };
    }
  });

  fastify.post<{ Params: { providerKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey/account-endpoint-models/clear-status",
    async (request) => {
      const body = clearAccountEndpointModelStatusBodySchema.parse(request.body);
      const cleared = dependencies.repository.clearAccountEndpointModelStatus(
        request.params.providerKey,
        body.account_key,
        body.endpoint_key,
        body.model_key
      );
      if (!cleared) {
        throw new HttpError(404, "observation_not_found", "Observed combination status not found");
      }
      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(
        dependencies.repository.getProviderDetails(request.params.providerKey)
      );
    }
  );

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
    const providerKey = body.provider_key ?? await suggestProviderKey({
      suggestedKey: template?.suggested_provider_key,
      displayName: body.display_name,
      baseUrl: endpointInputs[0]!.base_url
    });
    if (dependencies.repository.getProviderDetails(providerKey)) {
      throw new HttpError(
        409,
        "provider_key_conflict",
        `Provider Key already exists: ${providerKey}`
      );
    }

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
    let catalogUrl: string | null = body.model_catalog_url || null;
    let discoveredModels: ManagedDiscoveredModelInput[] = [];
    let discoveryError: string | null = null;
    try {
      const result = await discoverProviderCatalog(dependencies.discoveryService, {
        providerKey,
        apiKey: discoveryApiKey,
        modelCatalogUrl: body.model_catalog_url || null,
        endpoints: endpointInputs
      });
      catalogUrl = result.catalogUrl;
      discoveredModels = result.models;
    } catch (error) {
      discoveryError = discoveryErrorMessage(error);
    }
    const endpointBundles = mergeManualModelsIntoBundles(
      providerKey,
      buildEndpointBundles(endpointInputs, discoveredModels),
      body.models
    );

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
            enabled: primaryAccount.enabled,
            expiresAt: primaryAccount.expires_at ?? null,
            quotaJson: primaryAccount.quota ? JSON.stringify(primaryAccount.quota) : null,
            remark: primaryAccount.remark?.trim() || null
          }
        : undefined,
      endpointBundles,
      initialSync: {
        status: discoveryError ? "error" : "success",
        catalogUrl,
        errorMessage: discoveryError,
        discoveredCount: discoveredModels.length
      }
    });

    for (const account of body.accounts?.slice(1) ?? []) {
      const created = dependencies.repository.createAccount(providerKey, {
        accountKey: account.account_key,
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
      try {
        const result = await discoverProviderCatalog(dependencies.discoveryService, {
          providerKey,
          apiKey: account.api_key,
          modelCatalogUrl: body.model_catalog_url || null,
          endpoints: endpointInputs
        });
        const models = mergeManualModelsIntoBundles(
          providerKey,
          buildEndpointBundles(endpointInputs, result.models),
          body.models
        ).flatMap((bundle) => bundle.models);
        dependencies.repository.syncProviderModels(providerKey, {
          accountKey: account.account_key,
          catalogUrl: result.catalogUrl,
          status: "success",
          models
        });
      } catch (error) {
        dependencies.repository.syncProviderModels(providerKey, {
          accountKey: account.account_key,
          catalogUrl: body.model_catalog_url || null,
          status: "error",
          errorMessage: discoveryErrorMessage(error),
          models: []
        });
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

      let updated = details;
      for (const account of details.accounts) {
        const apiKey = dependencies.secretCipher.decrypt(account.apiKeyEncrypted);
        try {
          const result = await dependencies.discoveryService.discoverProviderModels({
            providerKey: details.provider.providerKey,
            apiKey,
            modelCatalogUrl: details.provider.modelCatalogUrl,
            endpoints: details.endpoints.map((endpoint) => ({
              endpointKey: endpoint.endpointKey,
              protocol: endpoint.protocol as "openai" | "anthropic",
              baseUrl: endpoint.baseUrl,
              enabled: endpoint.enabled
            }))
          });
          updated = dependencies.repository.syncProviderModels(details.provider.providerKey, {
            accountKey: account.accountKey,
            catalogUrl: result.catalogUrl,
            status: "success",
            models: result.models
          }) ?? updated;
        } catch (error) {
          updated = dependencies.repository.syncProviderModels(details.provider.providerKey, {
            accountKey: account.accountKey,
            catalogUrl: details.provider.modelCatalogUrl,
            status: "error",
            errorMessage: error instanceof Error ? error.message : "discovery_failed",
            models: []
          }) ?? updated;
        }
      }

      await dependencies.runtimeManager.reload();
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
        dependencies.repository.replaceProviderEndpoints(
          existing.provider.providerKey,
          endpointInputs.map((endpoint) => ({
            endpointKey: endpoint.protocol,
            protocol: endpoint.protocol,
            baseUrl: endpoint.base_url,
            customHeaders: endpoint.custom_headers,
            protocolBundleKey: endpoint.protocol_bundle_key,
            enabled: endpoint.enabled
          }))
        );
      }

      dependencies.repository.updateProvider(request.params.providerKey, {
        enabled: body.enabled,
        displayName: body.display_name,
        priority: body.priority,
        websiteUrl: body.website_url === "" ? null : body.website_url,
        modelCatalogUrl:
          body.model_catalog_url !== undefined ? body.model_catalog_url || null : undefined,
        providerKind: body.provider_kind
      });

      if (body.api_key) {
        dependencies.repository.updateCredential(
          request.params.providerKey,
          dependencies.secretCipher.encrypt(body.api_key),
          ManagedProviderRepository.toApiKeyHint(body.api_key)
        );
      }

      for (const model of body.models ?? []) {
        dependencies.repository.upsertManualModel(request.params.providerKey, {
          model: buildManualModel(request.params.providerKey, model)
        });
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

      let updated = existing;
      for (const endpointInput of endpointInputs) {
        const endpoint = dependencies.repository.createProviderEndpoint(request.params.providerKey, {
          endpointKey: endpointInput.protocol,
          protocol: endpointInput.protocol,
          baseUrl: endpointInput.base_url,
          customHeaders: endpointInput.custom_headers,
          protocolBundleKey: endpointInput.protocol_bundle_key,
          enabled: endpointInput.enabled
        });

        if (!endpoint) {
          throw new HttpError(404, "provider_not_found", "Provider not found");
        }

        updated = dependencies.repository.getProviderDetails(request.params.providerKey) ?? updated;
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

  fastify.post<{ Params: { providerKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey/models",
    async (request, reply) => {
      const body = createProviderModelBodySchema.parse(request.body);
      const existing = dependencies.repository.getProviderDetails(request.params.providerKey);
      if (!existing) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }

      const updated = dependencies.repository.upsertManualModel(request.params.providerKey, {
        model: buildManualModel(request.params.providerKey, body)
      });

      if (!updated) {
        throw new HttpError(404, "endpoint_not_found", "Provider endpoint not found");
      }

      await dependencies.runtimeManager.reload();
      reply.status(201);
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

      const createdDetails =
        dependencies.repository.getProviderDetails(request.params.providerKey) ?? existing;
      const updated = await syncAccountModels(dependencies, createdDetails, created);
      await dependencies.runtimeManager.reload();
      reply.status(201);
      return serializeProviderDetails(updated);
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
      const updated = dependencies.repository.updateAccount(
        request.params.providerKey,
        request.params.accountKey,
        {
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

      const lastUpdated = await syncAccountModels(dependencies, details, account);

      await dependencies.runtimeManager.reload();
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
