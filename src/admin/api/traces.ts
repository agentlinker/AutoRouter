import { requestJson } from "./client.js";

export interface TraceCandidate {
  route_id: string | null;
  endpoint: string;
  platform: string;
  provider: string | null;
  account: string;
  api_key: string;
  model_id: string | null;
  model: string;
  reason: string | null;
  score: number | null;
  sticky: boolean;
}

export interface TraceAttempt extends TraceCandidate {
  status: "success" | "failed";
  error: string | null;
  retryable: boolean;
  latency_ms: number | null;
  first_token_ms: number | null;
  actual_upstream_url: string | null;
  stream_completed: boolean | null;
  stream_terminal_event: string | null;
  required_protocol: string | null;
  actual_protocol: string | null;
  operation: string | null;
  failure_kind: string | null;
  failure_scope: string | null;
  failure_confidence: string | null;
  status_code: number | null;
  provider_code: string | null;
  provider_type: string | null;
}

export type RouteOutcomeStatus = "not_requested" | "filtered" | "success" | "failed";

export interface RouteOutcomeItem {
  route_id: string | null;
  endpoint: string;
  platform: string;
  provider: string | null;
  account: string;
  api_key: string;
  model_id: string | null;
  model: string;
  score: number | null;
  sticky: boolean;
  status: RouteOutcomeStatus;
  reason: string | null;
  retryable: boolean | null;
  latency_ms: number | null;
  first_token_ms: number | null;
  actual_upstream_url: string | null;
  stream_completed: boolean | null;
  stream_terminal_event: string | null;
  required_protocol: string | null;
  actual_protocol: string | null;
  operation: string | null;
  failure_kind: string | null;
  failure_scope: string | null;
  failure_confidence: string | null;
  status_code: number | null;
  provider_code: string | null;
  provider_type: string | null;
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
  required_protocol: string | null;
  selected_provider: string | null;
  selected_endpoint: string | null;
  selected_route_id: string | null;
  selected_account_hash: string | null;
  selected_api_key: string | null;
  selected_model: string | null;
  status: "success" | "success_with_fallback" | "failed";
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
  attempt_count: number;
  fallback_count: number;
  candidates: TraceCandidate[];
  filtered: TraceCandidate[];
  attempts: TraceAttempt[];
  fallbacks: TraceCandidate[];
  route_items: RouteOutcomeItem[];
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
