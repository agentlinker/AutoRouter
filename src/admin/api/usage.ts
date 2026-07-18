import { requestJson } from "./client.js";
import type { TraceRecord } from "./traces.js";

export interface UsageProviderSummary {
  provider_key: string;
  request_count: number;
  success_count: number;
  failure_count: number;
  avg_latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface UsageTotals {
  requests: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  avg_latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  unique_providers: number;
  unique_models: number;
}

export interface UsageResponse {
  totals: UsageTotals;
  providers: UsageProviderSummary[];
  recent_requests: TraceRecord[];
}

export function getUsageOverview(token: string): Promise<UsageResponse> {
  return requestJson<UsageResponse>("/admin/api/usage", token);
}

export function getUsageDetail(token: string, traceId: string): Promise<TraceRecord> {
  return requestJson<TraceRecord>(`/admin/api/usage/${traceId}`, token);
}
