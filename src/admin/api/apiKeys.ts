import { requestJson } from "./client.js";

export interface SystemApiKeyEntry {
  scope: "system";
  entry_id: string;
  label: string;
  description: string;
  env_name: string;
  configured: boolean;
}

export interface ProviderApiKeyEntry {
  scope: "provider";
  entry_id: string;
  provider_key: string;
  display_name: string;
  enabled: boolean;
  key_hint: string | null;
  configured: boolean;
  updated_at: string | null;
}

export interface ApiKeysListResponse {
  system: SystemApiKeyEntry[];
  providers: ProviderApiKeyEntry[];
}

export type ApiKeyDetailResponse = SystemApiKeyEntry | ProviderApiKeyEntry;

export function listApiKeys(token: string): Promise<ApiKeysListResponse> {
  return requestJson<ApiKeysListResponse>("/admin/api/api-keys", token);
}

export function getApiKeyDetail(
  token: string,
  keyScope: string,
  entryId: string
): Promise<ApiKeyDetailResponse> {
  return requestJson<ApiKeyDetailResponse>(`/admin/api/api-keys/${keyScope}/${entryId}`, token);
}
