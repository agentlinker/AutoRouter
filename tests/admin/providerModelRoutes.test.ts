import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProviderDetails,
  ProviderModel
} from "../../src/admin/api/providers.js";
import {
  modelRouteStatus,
  modelRouteSummary
} from "../../src/admin/utils/providerModelRoutes.js";

const model: ProviderModel = {
  model_key: "claude-opus-5",
  provider_model_id: "claude-opus-5",
  model_name: "Claude Opus 5",
  enabled: true,
  runtime_status: "normal",
  context_window: null,
  supports_streaming: true,
  supports_tools: true,
  supports_json_mode: false
};

function providerWithObservations(
  observations: ProviderDetails["account_endpoint_models"]
): ProviderDetails {
  return {
    provider_key: "test-provider",
    display_name: "Test Provider",
    protocol: "openai",
    base_url: "https://example.com",
    model_catalog_url: null,
    website_url: null,
    enabled: true,
    priority: 0,
    trust_level: "low",
    privacy_level: "public_only",
    usage_trust: "low",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    key_hint: "test",
    account_count: 1,
    available_account_count: 1,
    accounts: [{
      account_key: "account-1",
      enabled: true,
      runtime_status: "normal",
      key_hint: "test",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      models: [model]
    }],
    endpoints: [
      {
        endpoint_key: "openai",
        protocol: "openai",
        base_url: "https://example.com/v1",
        enabled: true,
        runtime_status: "normal",
        supports_streaming: true,
        supports_tools: true,
        supports_json_mode: true
      },
      {
        endpoint_key: "anthropic",
        protocol: "anthropic",
        base_url: "https://example.com",
        enabled: true,
        runtime_status: "normal",
        supports_streaming: true,
        supports_tools: true,
        supports_json_mode: false
      }
    ],
    latest_sync: null,
    models: [model],
    account_endpoint_models: observations
  };
}

describe("provider model routes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts failed observations as verified routes", () => {
    const provider = providerWithObservations([
      {
        account_key: "account-1",
        endpoint_key: "openai",
        model_key: model.model_key,
        runtime_status: "normal",
        last_success_at: "2026-09-01T00:00:00Z"
      },
      {
        account_key: "account-1",
        endpoint_key: "anthropic",
        model_key: model.model_key,
        runtime_status: "cooling_down",
        last_error_at: "2026-09-01T00:01:00Z"
      }
    ]);

    expect(modelRouteSummary(provider, model)).toEqual({
      availableAccounts: 1,
      accounts: 1,
      verified: 2,
      combinations: 2
    });
  });

  it("aggregates successful and unavailable routes as partial", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));

    const provider = providerWithObservations([
      {
        account_key: "account-1",
        endpoint_key: "openai",
        model_key: model.model_key,
        runtime_status: "normal",
        last_success_at: "2026-09-01T00:00:00Z"
      },
      {
        account_key: "account-1",
        endpoint_key: "anthropic",
        model_key: model.model_key,
        runtime_status: "cooling_down",
        status_cooldown_until: "2026-09-02T00:05:00Z",
        last_error_at: "2026-09-01T00:01:00Z"
      }
    ]);

    expect(modelRouteStatus(provider, model).state).toBe("partial");
  });

  it("marks routes with only active failures as unavailable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));

    const provider = providerWithObservations([
      {
        account_key: "account-1",
        endpoint_key: "openai",
        model_key: model.model_key,
        runtime_status: "cooling_down",
        status_cooldown_until: "2026-09-02T00:05:00Z",
        last_error_at: "2026-09-01T00:00:00Z"
      },
      {
        account_key: "account-1",
        endpoint_key: "anthropic",
        model_key: model.model_key,
        runtime_status: "abnormal",
        last_error_at: "2026-09-01T00:01:00Z"
      }
    ]);

    expect(modelRouteStatus(provider, model).state).toBe("unavailable");
  });

  it("keeps expired failures verified but returns them to pending verification", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));

    const provider = providerWithObservations([
      {
        account_key: "account-1",
        endpoint_key: "openai",
        model_key: model.model_key,
        runtime_status: "cooling_down",
        status_cooldown_until: "2026-09-01T23:59:00Z",
        last_error_at: "2026-09-01T23:55:00Z"
      },
      {
        account_key: "account-1",
        endpoint_key: "anthropic",
        model_key: model.model_key,
        runtime_status: "cooling_down",
        status_cooldown_until: "2026-09-01T23:59:00Z",
        last_error_at: "2026-09-01T23:55:00Z"
      }
    ]);

    expect(modelRouteSummary(provider, model).verified).toBe(2);
    expect(modelRouteStatus(provider, model).state).toBe("partial");
  });
});
