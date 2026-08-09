import { requestJson } from "./client.js";

export interface ProviderModel {
  model_key: string;
  provider_model_id: string;
  model_name: string;
  endpoint_key: string;
  enabled?: boolean;
  runtime_status?: string;
  status_reason?: string | null;
  status_message?: string | null;
  status_source?: string | null;
  status_updated_at?: string | null;
  status_cooldown_until?: string | null;
  rate_limit_strike?: number;
  recent_error_count?: number;
  context_window: number | null;
  supports_streaming: boolean;
  supports_tools: boolean;
  supports_json_mode: boolean;
}

export interface ProviderEndpoint {
  endpoint_key: string;
  protocol: string;
  adapter_type: string;
  base_url: string;
  enabled: boolean;
  supports_streaming: boolean;
  supports_tools: boolean;
  supports_json_mode: boolean;
}

export interface ProviderAccount {
  account_key: string;
  endpoint_key: string | null;
  enabled: boolean;
  runtime_status?: string;
  status_reason?: string | null;
  status_message?: string | null;
  status_source?: string | null;
  status_updated_at?: string | null;
  status_cooldown_until?: string | null;
  recent_error_count?: number;
  expires_at?: string | null;
  quota?: {
    monthly_usd_limit?: number;
    remaining_usd?: number;
    remaining_requests?: number;
    reset_at?: string;
    source?: string;
  } | null;
  key_hint: string | null;
  last_error_at?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderTemplate {
  template_id: string;
  vendor_id: string;
  vendor_name: string;
  product_line: string;
  region?: string;
  display_name: string;
  suggested_provider_key: string;
  website_url?: string;
  docs_url?: string;
  provider_kind: "official" | "relay" | "custom";
  model_availability_scope: "shared_by_provider" | "per_account";
  endpoints: Array<{
    endpoint_key: string;
    protocol: "openai" | "anthropic";
    adapter_type: "openai_compatible" | "anthropic";
    base_url: string;
    enabled?: boolean;
  }>;
  notes?: string;
}

export interface ProviderDetails {
  provider_key: string;
  display_name: string;
  adapter_type: string;
  base_url: string;
  website_url: string | null;
  provider_kind?: "official" | "relay" | "custom";
  model_availability_scope?: "shared_by_provider" | "per_account";
  enabled: boolean;
  priority: number;
  runtime_status?: string;
  status_reason?: string | null;
  status_message?: string | null;
  status_source?: string | null;
  status_updated_at?: string | null;
  status_cooldown_until?: string | null;
  trust_level: string;
  privacy_level: string;
  usage_trust: string;
  created_at: string;
  updated_at: string;
  key_hint: string | null;
  account_count?: number;
  available_account_count?: number;
  accounts?: ProviderAccount[];
  endpoints: ProviderEndpoint[];
  latest_sync: {
    status: string;
    error_message: string | null;
    started_at: string;
    finished_at: string | null;
    discovered_count: number;
  } | null;
  models: ProviderModel[];
}

export interface ProviderListResponse {
  data: ProviderDetails[];
  meta: {
    total: number;
    page: number;
    page_size: number;
    sort_by: ProviderSortBy;
    sort_dir: SortDirection;
  };
}

export type ProviderSortBy = "priority" | "created_at" | "updated_at";
export type SortDirection = "asc" | "desc";

export interface ProviderListParams {
  sort_by: ProviderSortBy;
  sort_dir: SortDirection;
  page: number;
  page_size: number;
}

export interface ProviderFormValues {
  provider_key: string;
  display_name: string;
  endpoints: ProviderEndpointInput[];
  website_url?: string;
  api_key?: string;
  provider_kind?: "official" | "relay" | "custom";
  model_availability_scope?: "shared_by_provider" | "per_account";
  template_id?: string;
}

export interface ProviderEndpointInput {
  endpoint_key: string;
  protocol: "openai" | "anthropic";
  base_url: string;
  enabled?: boolean;
}

export interface CreateProviderPayload extends ProviderFormValues {
  protocol?: "openai" | "anthropic";
  base_url?: string;
}

export interface UpdateProviderPayload extends Omit<CreateProviderPayload, "provider_key"> {
  api_key?: string;
  priority?: number;
}

export function listProviders(
  token: string,
  params: ProviderListParams
): Promise<ProviderListResponse> {
  const search = new URLSearchParams({
    sort_by: params.sort_by,
    sort_dir: params.sort_dir,
    page: String(params.page),
    page_size: String(params.page_size)
  });
  return requestJson<ProviderListResponse>(`/admin/api/providers?${search.toString()}`, token);
}

export function getProvider(token: string, providerKey: string): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>(
    `/admin/api/providers/${encodeURIComponent(providerKey)}`,
    token
  );
}

export function createProvider(
  token: string,
  payload: CreateProviderPayload
): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>("/admin/api/providers", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateProvider(
  token: string,
  providerKey: string,
  payload: UpdateProviderPayload
): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>(`/admin/api/providers/${providerKey}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function syncProvider(token: string, providerKey: string): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>(`/admin/api/providers/${providerKey}/sync-models`, token, {
    method: "POST"
  });
}

export function createProviderEndpoint(
  token: string,
  providerKey: string,
  payload: {
    endpoint_key: string;
    protocol: "openai" | "anthropic";
    adapter_type: "openai_compatible" | "openrouter" | "anthropic";
    base_url: string;
    enabled?: boolean;
    api_key?: string;
  }
): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>(`/admin/api/providers/${providerKey}/endpoints`, token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function syncProviderEndpoint(
  token: string,
  providerKey: string,
  endpointKey: string
): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>(
    `/admin/api/providers/${providerKey}/endpoints/${endpointKey}/sync-models`,
    token,
    { method: "POST" }
  );
}

export function deleteProvider(token: string, providerKey: string): Promise<null> {
  return requestJson<null>(`/admin/api/providers/${providerKey}`, token, {
    method: "DELETE"
  });
}

export function setProviderEnabled(
  token: string,
  providerKey: string,
  enabled: boolean
): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>(`/admin/api/providers/${providerKey}`, token, {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
}

export function promoteProviderPriority(
  token: string,
  providerKey: string
): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>(
    `/admin/api/providers/${providerKey}/promote-priority`,
    token,
    { method: "POST" }
  );
}

export function updateProviderModelCapabilities(
  token: string,
  providerKey: string,
  payload: {
    model_key: string;
    enabled?: boolean;
    supports_streaming?: boolean;
    supports_tools?: boolean;
    supports_json_mode?: boolean;
  }
): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>(`/admin/api/providers/${providerKey}/models`, token, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function listProviderTemplates(token: string): Promise<{ data: ProviderTemplate[] }> {
  return requestJson<{ data: ProviderTemplate[] }>("/admin/api/provider-templates", token);
}

export function mergeCheckProvider(
  token: string,
  payload: { protocol: "openai" | "anthropic"; base_url: string }
): Promise<{
  normalized_base_url: string;
  matches: Array<{
    provider_key: string;
    display_name: string;
    provider_kind: string;
    model_availability_scope: string;
    endpoint_key: string;
    protocol: string;
    base_url: string;
  }>;
}> {
  return requestJson("/admin/api/providers/merge-check", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function createProviderAccount(
  token: string,
  providerKey: string,
  payload: {
    account_key: string;
    endpoint_key?: string;
    api_key: string;
    expires_at?: string | null;
    quota?: ProviderAccount["quota"];
    enabled?: boolean;
  }
): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>(`/admin/api/providers/${providerKey}/accounts`, token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateProviderAccount(
  token: string,
  providerKey: string,
  accountKey: string,
  payload: {
    endpoint_key?: string | null;
    api_key?: string;
    expires_at?: string | null;
    quota?: ProviderAccount["quota"] | null;
    enabled?: boolean;
  }
): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>(
    `/admin/api/providers/${providerKey}/accounts/${accountKey}`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify(payload)
    }
  );
}

export function deleteProviderAccount(
  token: string,
  providerKey: string,
  accountKey: string
): Promise<null> {
  return requestJson<null>(
    `/admin/api/providers/${providerKey}/accounts/${accountKey}`,
    token,
    { method: "DELETE" }
  );
}

export function syncProviderAccount(
  token: string,
  providerKey: string,
  accountKey: string
): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>(
    `/admin/api/providers/${providerKey}/accounts/${accountKey}/sync-models`,
    token,
    { method: "POST" }
  );
}
