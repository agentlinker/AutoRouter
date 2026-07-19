import { requestJson } from "./client.js";

export interface ProviderModel {
  model_key: string;
  provider_model_id: string;
  model_name: string;
  context_window: number | null;
  supports_streaming: boolean;
  supports_tools: boolean;
  supports_json_mode: boolean;
}

export interface ProviderDetails {
  provider_key: string;
  display_name: string;
  adapter_type: string;
  base_url: string;
  website_url: string | null;
  enabled: boolean;
  trust_level: string;
  privacy_level: string;
  usage_trust: string;
  key_hint: string | null;
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
}

export interface ProviderFormValues {
  provider_key: string;
  display_name: string;
  base_url: string;
  website_url?: string;
  api_key?: string;
}

export function listProviders(token: string): Promise<ProviderListResponse> {
  return requestJson<ProviderListResponse>("/admin/api/providers", token);
}

export function createProvider(
  token: string,
  payload: ProviderFormValues
): Promise<ProviderDetails> {
  return requestJson<ProviderDetails>("/admin/api/providers", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateProvider(
  token: string,
  providerKey: string,
  payload: Omit<ProviderFormValues, "provider_key">
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

export function updateProviderModelCapabilities(
  token: string,
  providerKey: string,
  payload: {
    model_key: string;
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
