import { requestJson } from "./client.js";

export interface CatalogModelInstance {
  provider_key: string;
  provider_display_name: string;
  endpoint_key: string;
  protocol: string | null;
  model_key: string;
  provider_model_id: string;
  model_name: string;
  enabled: boolean;
  context_window: number | null;
  supports_streaming: boolean;
  supports_tools: boolean;
  supports_json_mode: boolean;
  pricing_json: string | null;
  context_window_override: number | null;
  supports_streaming_override: boolean | null;
  supports_tools_override: boolean | null;
  supports_json_mode_override: boolean | null;
  pricing_json_override: string | null;
  effective_context_window: number | null;
  effective_supports_streaming: boolean;
  effective_supports_tools: boolean;
  effective_supports_json_mode: boolean;
  effective_pricing_json: string | null;
  manual_override_json: string | null;
}

export interface CatalogModel {
  logical_name: string;
  display_name: string | null;
  openrouter_slug: string | null;
  aliases_json: string | null;
  context_window: number | null;
  supports_streaming: boolean;
  supports_tools: boolean;
  supports_json_mode: boolean;
  input_modalities_json: string | null;
  pricing_json: string | null;
  metadata_source: string;
  metadata_confidence: string;
  notes: string | null;
  fetched_at: string | null;
  updated_at: string;
  instances: CatalogModelInstance[];
}

export interface CatalogModelListResponse {
  data: CatalogModel[];
}

export function listCatalogModels(token: string): Promise<CatalogModelListResponse> {
  return requestJson<CatalogModelListResponse>("/admin/api/catalog/models", token);
}

export function getCatalogModel(token: string, logicalName: string): Promise<CatalogModel> {
  return requestJson<CatalogModel>(
    `/admin/api/catalog/models/${encodeURIComponent(logicalName)}`,
    token
  );
}

export function updateCatalogModel(
  token: string,
  logicalName: string,
  payload: {
    display_name?: string | null;
    openrouter_slug?: string | null;
    context_window?: number | null;
    supports_streaming?: boolean;
    supports_tools?: boolean;
    supports_json_mode?: boolean;
    pricing_json?: string | null;
    notes?: string | null;
  }
): Promise<CatalogModel> {
  return requestJson<CatalogModel>(
    `/admin/api/catalog/models/${encodeURIComponent(logicalName)}`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify(payload)
    }
  );
}

export function enrichCatalogModelFromOpenRouter(
  token: string,
  logicalName: string
): Promise<CatalogModel> {
  return requestJson<CatalogModel>(
    `/admin/api/catalog/models/${encodeURIComponent(logicalName)}/enrich/openrouter`,
    token,
    { method: "POST" }
  );
}

export function updateCatalogModelInstance(
  token: string,
  logicalName: string,
  payload: {
    provider_key: string;
    model_key: string;
    enabled?: boolean;
    context_window_override?: number | null;
    supports_streaming_override?: boolean | null;
    supports_tools_override?: boolean | null;
    supports_json_mode_override?: boolean | null;
    pricing_json_override?: string | null;
  }
): Promise<CatalogModel> {
  return requestJson<CatalogModel>(
    `/admin/api/catalog/models/${encodeURIComponent(logicalName)}/instances`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify(payload)
    }
  );
}
