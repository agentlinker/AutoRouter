import { z } from "zod";

const providerKindSchema = z.enum(["official", "relay", "custom"]);
const modelAvailabilityScopeSchema = z.enum(["shared_by_provider", "per_account"]);
const protocolSchema = z.enum(["openai", "anthropic"]);

export const providerTemplateEndpointSchema = z.object({
  endpoint_key: z.string().min(1),
  protocol: protocolSchema,
  base_url: z.string().url(),
  custom_headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional()
}).strict();

export const providerTemplateSchema = z.object({
  template_id: z.string().min(1),
  vendor_id: z.string().min(1),
  vendor_name: z.string().min(1),
  product_line: z.string().min(1),
  region: z.string().optional(),
  display_name: z.string().min(1),
  suggested_provider_key: z.string().min(1),
  website_url: z.string().url().optional(),
  docs_url: z.string().url().optional(),
  provider_kind: providerKindSchema,
  model_availability_scope: modelAvailabilityScopeSchema,
  endpoints: z.array(providerTemplateEndpointSchema).min(1),
  notes: z.string().optional()
}).strict();

export const providerTemplatesFileSchema = z.object({
  templates: z.array(providerTemplateSchema).default([])
}).strict();

export type ProviderTemplate = z.infer<typeof providerTemplateSchema>;
export type ProviderTemplateEndpoint = z.infer<typeof providerTemplateEndpointSchema>;
