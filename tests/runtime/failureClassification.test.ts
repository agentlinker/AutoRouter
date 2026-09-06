import { describe, expect, it } from "vitest";

import {
  classifyFailureEvidence,
  classifyProviderFailure,
  type FailureEvidence
} from "../../src/runtime/providerFailure.js";
import { normalizeRuntimeStatusSettings } from "../../src/runtime/runtimeStatus.js";
import { HttpError } from "../../src/utils/httpErrors.js";

const evidence = (input: Partial<FailureEvidence>): FailureEvidence => ({
  protocol: "anthropic-messages",
  operation: "messages",
  message: "upstream request failed",
  ...input
});

describe("structured provider failure classification", () => {
  it("uses Account scope only for explicit invalid credential machine codes", () => {
    expect(classifyFailureEvidence(evidence({ status_code: 401, provider_code: "invalid_api_key" })))
      .toMatchObject({ kind: "authentication", scope: "account", confidence: "explicit-provider-code", retryable: false });
    expect(classifyFailureEvidence(evidence({ status_code: 401 })))
      .toMatchObject({ kind: "authentication", scope: "account-endpoint", confidence: "http-status", retryable: false });
  });

  it("keeps generic 403 and group dispatch denial on Account-Endpoint", () => {
    expect(classifyFailureEvidence(evidence({ status_code: 403 })))
      .toMatchObject({ kind: "authorization", scope: "account-endpoint" });
    expect(classifyFailureEvidence(evidence({ status_code: 403, provider_code: "group_access_denied" })))
      .toMatchObject({ kind: "authorization", scope: "account-endpoint", confidence: "verified-profile" });
  });

  it("attributes explicit billing evidence to Account", () => {
    expect(classifyFailureEvidence(evidence({ status_code: 402, provider_code: "billing_hard_limit_reached" })))
      .toMatchObject({ kind: "billing", scope: "account", retryable: false });
  });

  it("attributes model errors and rate limits to Account-Endpoint-Model", () => {
    expect(classifyFailureEvidence(evidence({ status_code: 404, provider_code: "model_not_found" })))
      .toMatchObject({ kind: "model-unavailable", scope: "account-endpoint-model" });
    expect(classifyFailureEvidence(evidence({ status_code: 429 })))
      .toMatchObject({ kind: "rate-limit", scope: "account-endpoint-model", retryable: true });
  });

  it("attributes DNS, TLS and connection failures to Endpoint", () => {
    for (const transport_error of ["dns", "tls", "connection"] as const) {
      expect(classifyFailureEvidence(evidence({ transport_error })))
        .toMatchObject({ kind: "connectivity", scope: "endpoint", confidence: "transport", retryable: true });
    }
  });

  it("keeps request validation and unknown evidence non-persistent", () => {
    expect(classifyFailureEvidence(evidence({ status_code: 400 })))
      .toMatchObject({ kind: "request-invalid", scope: "request", retryable: false });
    expect(classifyFailureEvidence(evidence({})))
      .toMatchObject({ kind: "unknown", scope: "unknown", confidence: "unknown" });
  });

  it("preserves machine-readable evidence from HttpError details", () => {
    const failure = classifyProviderFailure(new HttpError(401, "provider_error", "bad key", false, {
      provider_code: "invalid_api_key",
      provider_type: "authentication_error",
      protocol: "openai-responses",
      operation: "responses"
    }));
    expect(failure).toMatchObject({
      kind: "authentication",
      scope: "account",
      evidence: {
        status_code: 401,
        provider_code: "invalid_api_key",
        provider_type: "authentication_error",
        protocol: "openai-responses",
        operation: "responses",
        message: "bad key"
      }
    });
  });

  it("does not widen scope from an undocumented message string", () => {
    expect(classifyProviderFailure(new HttpError(403, "provider_error", "invalid api key")))
      .toMatchObject({ scope: "account-endpoint", confidence: "http-status" });
  });
});

describe("normalizeRuntimeStatusSettings", () => {
  it("normalizes auth_disables_account", () => {
    expect(normalizeRuntimeStatusSettings({ auth_disables_account: false }).auth_disables_account)
      .toBe(false);
  });
});
