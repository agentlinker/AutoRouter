import { requestJson } from "./client.js";

export interface PolicyRecord {
  policy_id: string;
  is_default: boolean;
  route_count: number;
  routes: string[];
  min_trust_level: string;
  allow_public_only_provider: boolean;
  fallback_enabled: boolean;
  sticky_session: boolean;
  thresholds: Record<string, unknown>;
  weights: Record<string, unknown>;
}

export interface PoliciesResponse {
  data: PolicyRecord[];
}

export function listPolicies(token: string): Promise<PoliciesResponse> {
  return requestJson<PoliciesResponse>("/admin/api/policies", token);
}

export function getPolicyDetail(token: string, policyId: string): Promise<PolicyRecord> {
  return requestJson<PolicyRecord>(`/admin/api/policies/${policyId}`, token);
}
