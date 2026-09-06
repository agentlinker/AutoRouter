import type { WireProtocol } from "../config/schema.js";
import { HttpError } from "../utils/httpErrors.js";

export type ProviderOperation = "responses" | "chat-completions" | "messages";
export type FailureKind =
  | "authentication"
  | "authorization"
  | "billing"
  | "model-unavailable"
  | "rate-limit"
  | "connectivity"
  | "request-invalid"
  | "upstream"
  | "unknown";
export type FailureScope =
  | "account"
  | "endpoint"
  | "account-endpoint"
  | "account-endpoint-model"
  | "request"
  | "unknown";
export type FailureConfidence =
  | "explicit-provider-code"
  | "verified-profile"
  | "transport"
  | "http-status"
  | "unknown";

export interface FailureEvidence {
  status_code?: number;
  provider_code?: string;
  provider_type?: string;
  retry_after?: string;
  protocol: WireProtocol;
  operation: ProviderOperation;
  message: string;
  transport_error?: "dns" | "tls" | "connection";
}

export interface StructuredProviderFailure {
  kind: FailureKind;
  scope: FailureScope;
  confidence: FailureConfidence;
  retryable: boolean;
  evidence: FailureEvidence;
}

export function providerErrorDetails(
  body: unknown,
  protocol: WireProtocol,
  operation: ProviderOperation,
  retryAfter?: string
): Record<string, unknown> {
  const root = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const error = root.error && typeof root.error === "object"
    ? root.error as Record<string, unknown>
    : root;
  return {
    protocol,
    operation,
    ...(typeof error.code === "string" ? { provider_code: error.code } : {}),
    ...(typeof error.type === "string" ? { provider_type: error.type } : {}),
    ...(retryAfter ? { retry_after: retryAfter } : {})
  };
}

const INVALID_KEY_CODES = new Set(["invalid_api_key", "api_key_revoked", "api_key_expired"]);
const BILLING_CODES = new Set(["billing_hard_limit_reached", "insufficient_quota", "insufficient_balance"]);
const MODEL_CODES = new Set(["model_not_found", "model_access_denied", "invalid_model"]);
const ACCOUNT_ENDPOINT_CODES = new Set(["group_access_denied", "path_access_denied", "dispatch_denied"]);

export function classifyFailureEvidence(evidence: FailureEvidence): StructuredProviderFailure {
  const code = evidence.provider_code?.toLowerCase();
  if (code && INVALID_KEY_CODES.has(code)) {
    return { kind: "authentication", scope: "account", confidence: "explicit-provider-code", retryable: false, evidence };
  }
  if (code && BILLING_CODES.has(code)) {
    return { kind: "billing", scope: "account", confidence: "explicit-provider-code", retryable: false, evidence };
  }
  if (code && MODEL_CODES.has(code)) {
    return { kind: "model-unavailable", scope: "account-endpoint-model", confidence: "explicit-provider-code", retryable: false, evidence };
  }
  if (code && ACCOUNT_ENDPOINT_CODES.has(code)) {
    return { kind: "authorization", scope: "account-endpoint", confidence: "verified-profile", retryable: false, evidence };
  }
  if (evidence.transport_error) {
    return { kind: "connectivity", scope: "endpoint", confidence: "transport", retryable: true, evidence };
  }

  const status = evidence.status_code;
  if (status === 401) {
    return { kind: "authentication", scope: "account-endpoint", confidence: "http-status", retryable: false, evidence };
  }
  if (status === 403) {
    return { kind: "authorization", scope: "account-endpoint", confidence: "http-status", retryable: false, evidence };
  }
  if (status === 402) {
    return { kind: "billing", scope: "account", confidence: "http-status", retryable: false, evidence };
  }
  if (status === 404 || status === 410) {
    return { kind: "model-unavailable", scope: "account-endpoint-model", confidence: "http-status", retryable: false, evidence };
  }
  if (status === 429) {
    return { kind: "rate-limit", scope: "account-endpoint-model", confidence: "http-status", retryable: true, evidence };
  }
  if (status === 408 || (status !== undefined && status >= 500)) {
    return { kind: "upstream", scope: "account-endpoint-model", confidence: "http-status", retryable: true, evidence };
  }
  if (status !== undefined && status >= 400) {
    return { kind: "request-invalid", scope: "request", confidence: "http-status", retryable: false, evidence };
  }
  return { kind: "unknown", scope: "unknown", confidence: "unknown", retryable: false, evidence };
}

function protocolFromDetails(details: Record<string, unknown> | undefined): WireProtocol {
  const protocol = details?.protocol;
  return protocol === "openai-responses" || protocol === "openai-chat-completions" || protocol === "anthropic-messages"
    ? protocol
    : "openai-responses";
}

function operationForProtocol(protocol: WireProtocol): ProviderOperation {
  if (protocol === "openai-chat-completions") return "chat-completions";
  if (protocol === "anthropic-messages") return "messages";
  return "responses";
}

export function classifyProviderFailure(
  error: unknown,
  context?: { protocol?: WireProtocol; operation?: ProviderOperation }
): StructuredProviderFailure {
  const http = error instanceof HttpError ? error : null;
  const details = http?.details;
  const protocol = context?.protocol ?? protocolFromDetails(details);
  const message = error instanceof Error ? error.message : "provider_request_failed";
  const code = typeof details?.provider_code === "string" ? details.provider_code : undefined;
  const type = typeof details?.provider_type === "string" ? details.provider_type : undefined;
  const retryAfter = typeof details?.retry_after === "string" ? details.retry_after : undefined;
  const transportError = http?.code === "provider_unreachable"
    ? "connection"
    : undefined;
  return classifyFailureEvidence({
    status_code: http?.statusCode,
    provider_code: code,
    provider_type: type,
    retry_after: retryAfter,
    protocol,
    operation: context?.operation ?? operationForProtocol(protocol),
    message,
    transport_error: transportError
  });
}
