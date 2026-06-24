import { z } from "zod";

export const trustLevelSchema = z.enum(["low", "medium", "high"]);
export const privacyLevelSchema = z.enum(["public_only", "normal", "private"]);
export const usageTrustSchema = z.enum(["low", "medium", "high"]);
export const adapterTypeSchema = z.enum([
  "openai_compatible",
  "openrouter",
  "ollama",
  "anthropic"
]);
export const accountTypeSchema = z.enum(["api_key", "local_model"]);
export const healthStatusSchema = z.enum(["unknown", "healthy", "degraded", "down"]);

export const quotaSchema = z
  .object({
    monthly_usd_limit: z.number().nonnegative().optional(),
    remaining_usd: z.number().nonnegative().optional(),
    reset_at: z.string().optional()
  })
  .strict();

export const platformSchema = z
  .object({
    protocol: z.string().min(1)
  })
  .strict();

export const providerSchema = z
  .object({
    display_name: z.string().min(1),
    trust_level: trustLevelSchema.default("low"),
    privacy_level: privacyLevelSchema.default("public_only"),
    usage_trust: usageTrustSchema.default("low")
  })
  .strict();

export const endpointCapabilitiesSchema = z
  .object({
    streaming: z.boolean().default(true),
    tools: z.boolean().default(false),
    json_mode: z.boolean().default(false)
  })
  .strict();

export const endpointSchema = z
  .object({
    provider: z.string().min(1),
    platform: z.string().min(1),
    adapter: adapterTypeSchema,
    base_url: z.string().url(),
    enabled: z.boolean().default(true),
    capabilities: endpointCapabilitiesSchema.default({})
  })
  .strict();

export const accountSchema = z
  .object({
    endpoint: z.string().min(1),
    account_type: accountTypeSchema,
    credential_env: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
    quota: quotaSchema.optional()
  })
  .strict();

export const priceEntrySchema = z
  .object({
    input_per_1m: z.number().nonnegative().optional(),
    output_per_1m: z.number().nonnegative().optional(),
    cached_input_per_1m: z.number().nonnegative().optional(),
    source: z.enum(["official", "openrouter", "manual", "estimated"]).default("manual"),
    confidence: z.enum(["low", "medium", "high"]).default("low")
  })
  .strict();

export const modelCapabilitiesSchema = z
  .object({
    streaming: z.boolean().default(true),
    tools: z.boolean().default(false),
    json_mode: z.boolean().default(false)
  })
  .strict();

export const modelDefinitionSchema = z
  .object({
    endpoint: z.string().min(1),
    model_name: z.string().min(1),
    context_window: z.number().int().positive().optional(),
    capabilities: modelCapabilitiesSchema.default({}),
    pricing: priceEntrySchema.optional()
  })
  .strict();

export const routeCandidateSchema = z
  .object({
    account: z.string().min(1),
    model: z.string().min(1)
  })
  .strict();

export const routeSchema = z
  .object({
    policy: z.string().min(1),
    candidates: z.array(routeCandidateSchema).min(1)
  })
  .strict();

export const policyThresholdsSchema = z
  .object({
    min_trust_level: trustLevelSchema.default("low"),
    allow_public_only_provider: z.boolean().default(false),
    require_tools: z.boolean().default(false),
    require_json_mode: z.boolean().default(false),
    min_context_window: z.number().int().positive().optional()
  })
  .strict();

export const policyWeightsSchema = z
  .object({
    health: z.number().nonnegative().default(1),
    trust: z.number().nonnegative().default(1),
    cost: z.number().nonnegative().default(0),
    quality: z.number().nonnegative().default(0),
    context: z.number().nonnegative().default(0),
    tools: z.number().nonnegative().default(0),
    sticky: z.number().nonnegative().default(0),
    error_penalty: z.number().nonnegative().default(1),
    quota_penalty: z.number().nonnegative().default(1)
  })
  .strict();

export const policySchema = z
  .object({
    thresholds: policyThresholdsSchema.default({}),
    weights: policyWeightsSchema.default({}),
    min_trust_level: trustLevelSchema.default("low"),
    allow_public_only_provider: z.boolean().default(false),
    fallback_enabled: z.boolean().default(true),
    sticky_session: z.boolean().default(false)
  })
  .strict();

export const traceSchema = z
  .object({
    directory: z.string().default("./data/traces"),
    log_prompts: z.boolean().default(false)
  })
  .strict();

export const serverSchema = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().positive().default(8811),
    request_timeout_ms: z.number().int().positive().default(120000),
    gateway_token_env: z.string().default("AUTO_ROUTER_TOKEN")
  })
  .strict();

export const defaultsSchema = z
  .object({
    model: z.string().default("auto"),
    policy: z.string().default("balanced"),
    privacy_level: privacyLevelSchema.default("normal")
  })
  .strict();

export const routerConfigSchema = z
  .object({
    server: serverSchema.default({}),
    defaults: defaultsSchema.default({}),
    trace: traceSchema.default({}),
    platforms: z.record(z.string(), platformSchema).default({}),
    providers: z.record(z.string(), providerSchema).default({}),
    endpoints: z.record(z.string(), endpointSchema).default({}),
    accounts: z.record(z.string(), accountSchema).default({}),
    models: z.record(z.string(), modelDefinitionSchema).default({}),
    routes: z.record(z.string(), routeSchema).default({}),
    policies: z.record(z.string(), policySchema).default({})
  })
  .strict();

export type TrustLevel = z.infer<typeof trustLevelSchema>;
export type PrivacyLevel = z.infer<typeof privacyLevelSchema>;
export type UsageTrust = z.infer<typeof usageTrustSchema>;
export type AdapterType = z.infer<typeof adapterTypeSchema>;
export type AccountType = z.infer<typeof accountTypeSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type QuotaConfig = z.infer<typeof quotaSchema>;
export type PlatformConfig = z.infer<typeof platformSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type EndpointCapabilitiesConfig = z.infer<typeof endpointCapabilitiesSchema>;
export type EndpointConfig = z.infer<typeof endpointSchema>;
export type AccountConfig = z.infer<typeof accountSchema>;
export type PriceEntryConfig = z.infer<typeof priceEntrySchema>;
export type ModelCapabilitiesConfig = z.infer<typeof modelCapabilitiesSchema>;
export type ModelDefinitionConfig = z.infer<typeof modelDefinitionSchema>;
export type RouteCandidateConfig = z.infer<typeof routeCandidateSchema>;
export type RouteConfig = z.infer<typeof routeSchema>;
export type PolicyThresholdsConfig = z.infer<typeof policyThresholdsSchema>;
export type PolicyWeightsConfig = z.infer<typeof policyWeightsSchema>;
export type PolicyConfig = z.infer<typeof policySchema>;
export type TraceConfig = z.infer<typeof traceSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type DefaultsConfig = z.infer<typeof defaultsSchema>;
export type RouterConfig = z.infer<typeof routerConfigSchema>;
