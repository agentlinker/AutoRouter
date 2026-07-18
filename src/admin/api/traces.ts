import { requestJson } from "./client.js";

export interface TraceCandidate {
  route_id: string | null;
  endpoint: string;
  platform: string;
  provider: string | null;
  account: string;
  model_id: string | null;
  model: string;
  reason: string | null;
}

export interface TraceRecord {
  trace_id: string;
  timestamp: string;
  session_id: string | null;
  requested_model: string;
  normalized_model: string;
  stream: boolean;
  has_tools: boolean;
  privacy_level: string;
  selected_provider: string | null;
  selected_endpoint: string | null;
  selected_route_id: string | null;
  selected_model: string | null;
  status: "success" | "failed";
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  price_confidence: string;
  policy_hits: string[];
  error: string | null;
  candidate_count: number;
  filtered_count: number;
  fallback_count: number;
  candidates: TraceCandidate[];
  filtered: TraceCandidate[];
  fallbacks: TraceCandidate[];
}

export interface TraceListResponse {
  data: TraceRecord[];
}

export function listTraces(token: string, limit = 100): Promise<TraceListResponse> {
  return requestJson<TraceListResponse>(`/admin/api/traces?limit=${limit}`, token);
}

export function getTraceDetail(token: string, traceId: string): Promise<TraceRecord> {
  return requestJson<TraceRecord>(`/admin/api/traces/${traceId}`, token);
}
