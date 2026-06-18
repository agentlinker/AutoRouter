import { z } from "zod";

export const trustLevelSchema = z.enum(["low", "medium", "high"]);
export const privacyLevelSchema = z.enum(["public_only", "normal", "private"]);
export const usageTrustSchema = z.enum(["low", "medium", "high"]);
export const protocolTypeSchema = z.enum([
  "openai_compatible",
  "openrouter",
  "ollama"
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

export const accountSchema = z
  .object({
    id: z.string().min(1),
    account_type: accountTypeSchema,
    api_key_env: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
    quota: quotaSchema.optional()
  })
  .strict();

export const platformSchema = z
  .object({
    display_name: z.string().min(1),
    trust_level: trustLevelSchema.optional(),
    privacy_level: privacyLevelSchema.optional(),
    usage_trust: usageTrustSchema.optional(),
  })
  .strict();

export const endpointSchema = z
  .object({
    platform: z.string().min(1),
    protocol: protocolTypeSchema,
    base_url: z.string().url(),
    enabled: z.boolean().default(true),
    accounts: z.array(accountSchema).min(1)
  })
  .strict();

export const modelCandidateSchema = z
  .object({
    endpoint: z.string().min(1),
    account: z.string().min(1),
    model: z.string().min(1)
  })
  .strict();

export const priceEntrySchema = z
  .object({
    input_per_1m: z.number().nonnegative().optional(),
    output_per_1m: z.number().nonnegative().optional(),
    cached_input_per_1m: z.number().nonnegative().optional(),
    source: z.enum(["official", "openrouter", "manual", "estimated"]).default("manual"),
    confidence: z.enum(["low", "medium", "high"]).default("unknown" as never)
  })
  .strict();

export const modelAliasSchema = z
  .object({
    policy: z.string().min(1),
    candidates: z.array(modelCandidateSchema).min(1)
  })
  .strict();

export const policySchema = z
  .object({
    min_trust_level: trustLevelSchema.default("low"),
    allow_public_only_provider: z.boolean().default(false),
    fallback_enabled: z.boolean().default(true),
    sticky_session: z.boolean().default(false)
  })
  .strict();

export const traceSchema = z
  .object({
    directory: z.string().default("/tmp/autorouter-traces"),
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
    endpoints: z.record(z.string(), endpointSchema).default({}),
    models: z.record(z.string(), modelAliasSchema).default({}),
    policies: z.record(z.string(), policySchema).default({}),
    prices: z
      .record(
        z.string(),
        z.record(z.string(), priceEntrySchema)
      )
      .default({})
  })
  .strict();

export type TrustLevel = z.infer<typeof trustLevelSchema>;
export type PrivacyLevel = z.infer<typeof privacyLevelSchema>;
export type UsageTrust = z.infer<typeof usageTrustSchema>;
export type ProtocolType = z.infer<typeof protocolTypeSchema>;
export type AccountType = z.infer<typeof accountTypeSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type QuotaConfig = z.infer<typeof quotaSchema>;
export type AccountConfig = z.infer<typeof accountSchema>;
export type PlatformConfig = z.infer<typeof platformSchema>;
export type EndpointConfig = z.infer<typeof endpointSchema>;
export type ModelCandidateConfig = z.infer<typeof modelCandidateSchema>;
export type ModelAliasConfig = z.infer<typeof modelAliasSchema>;
export type PriceEntryConfig = z.infer<typeof priceEntrySchema>;
export type PolicyConfig = z.infer<typeof policySchema>;
export type TraceConfig = z.infer<typeof traceSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type DefaultsConfig = z.infer<typeof defaultsSchema>;
export type RouterConfig = z.infer<typeof routerConfigSchema>;
