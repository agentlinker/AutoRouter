import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PriceTable } from "../../src/catalog/priceTable.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { createDatabaseClient } from "../../src/db/client.js";
import { AdapterRegistry } from "../../src/providers/registry.js";
import { AppSettingsRepository } from "../../src/repositories/appSettingsRepository.js";
import { ManagedProviderRepository } from "../../src/repositories/managedProviderRepository.js";
import { RouteTraceRepository } from "../../src/repositories/routeTraceRepository.js";
import { selectRoute } from "../../src/routing/routeEngine.js";
import { StickySessionStore } from "../../src/routing/stickySession.js";
import { RuntimeManager } from "../../src/runtime/runtimeManager.js";
import { RuntimeStatusService } from "../../src/runtime/runtimeStatusService.js";
import { SecretCipher } from "../../src/security/secretCipher.js";
import { TraceStore } from "../../src/trace/traceStore.js";
import { HttpError } from "../../src/utils/httpErrors.js";
import { createLogger } from "../../src/utils/logger.js";

function createHarness(tempDir: string) {
  const config = loadConfig({
    override: {
      database: {
        path: join(tempDir, "autorouter.db")
      },
      trace: {
        directory: join(tempDir, "traces"),
        log_prompts: false
      },
      routes: {},
      providers: {},
      endpoints: {},
      accounts: {},
      models: {},
      policies: {}
    }
  });
  const databaseClient = createDatabaseClient(config.database.path);
  const managedProviders = new ManagedProviderRepository(databaseClient.db);
  const appSettings = new AppSettingsRepository(databaseClient.db);
  const traceStore = new TraceStore(new RouteTraceRepository(databaseClient.db));
  const secretCipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);

  managedProviders.createProviderWithEndpointBundles({
    provider: {
      providerKey: "demo",
      displayName: "Demo",
      baseUrl: "https://demo.example.com/v1",
      trustLevel: "medium",
      privacyLevel: "normal",
      usageTrust: "medium"
    },
    encryptedApiKey: secretCipher.encrypt("secret"),
    endpointBundles: [
      {
        endpoint: {
          endpointKey: "openai",
          protocol: "openai",
          baseUrl: "https://demo.example.com/v1",
          supportsStreaming: true,
          supportsTools: true,
          supportsJsonMode: true
        },
        models: [
          {
            modelKey: "demo/demo-model",
            providerModelId: "demo-model",
            modelName: "demo-model",
            contextWindow: 128000,
            supportsStreaming: true,
            supportsTools: true,
            supportsJsonMode: true
          }
        ]
      }
    ]
  });

  const runtimeManager = new RuntimeManager({
    baseConfig: config,
    managedProviderRepository: managedProviders,
    appSettingsRepository: appSettings,
    secretCipher,
    adapters: new AdapterRegistry(),
    stickySessions: new StickySessionStore(),
    traceStore,
    logger: createLogger()
  });

  return {
    managedProviders,
    appSettings,
    runtimeManager,
    service: new RuntimeStatusService(managedProviders, appSettings),
    priceTable: new PriceTable(config)
  };
}

describe("RuntimeStatusService", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autorouter-runtime-status-"));
    vi.stubEnv(
      "AUTO_ROUTER_MASTER_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists account auth failures without disabling the whole provider", () => {
    const harness = createHarness(tempDir);

    harness.service.recordFailure({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo/demo-model",
      accountKey: "default",
      endpointKey: "openai",
      error: new HttpError(401, "provider_auth_failed", "Invalid API key")
    });

    let details = harness.managedProviders.getProviderDetails("demo");
    expect(details?.provider.runtimeStatus).toBe("normal");
    const account = details?.accounts.find((item) => item.accountKey === "default");
    expect(account?.runtimeStatus).toBe("disabled");
    expect(account?.statusMessage).toBe("Invalid API key");

    const runtimeAccount = harness.runtimeManager
      .getSnapshot()
      .accounts.find((item) => item.id.endsWith("/default"));
    expect(runtimeAccount?.available).toBe(false);

    harness.managedProviders.setAccountEnabled("demo", "default", true);
    details = harness.managedProviders.getProviderDetails("demo");
    expect(details?.accounts[0]?.runtimeStatus).toBe("normal");
    expect(details?.accounts[0]?.statusMessage).toBeNull();
  });

  it("persists combination rate limits and does not fake recovery when the provider model is enabled", () => {
    const harness = createHarness(tempDir);

    harness.service.recordFailure({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo/demo-model",
      accountKey: "default",
      endpointKey: "openai",
      error: new HttpError(429, "provider_rate_limited", "Too many requests")
    });

    let model = harness.managedProviders.getAccountEndpointModel(
      "demo",
      "default",
      "openai",
      "demo/demo-model"
    );
    expect(model?.runtimeStatus).toBe("rate_limited");
    expect(model?.rateLimitStrike).toBe(1);
    expect(model?.statusCooldownUntil).toBeTruthy();
    expect(
      harness.runtimeManager.getSnapshot().modelStatuses[
        "account:demo/openai/default|model:demo/demo-model"
      ]?.runtime_status
    ).toBe("rate_limited");

    harness.managedProviders.setModelEnabled("demo", "demo/demo-model", true);
    model = harness.managedProviders.getAccountEndpointModel(
      "demo",
      "default",
      "openai",
      "demo/demo-model"
    );
    expect(model?.runtimeStatus).toBe("rate_limited");
    expect(model?.rateLimitStrike).toBe(1);
  });

  it("keeps repeated upstream 5xx scoped to the account-model", () => {
    const harness = createHarness(tempDir);
    harness.appSettings.setRuntimeStatusSettings({ error_threshold: 2 });
    const snapshot = harness.runtimeManager.getSnapshot();
    const selectDemoRoute = () =>
      selectRoute(
        snapshot.config,
        snapshot.modelCatalog,
        snapshot.priceTable,
        snapshot.platforms,
        snapshot.providers,
        snapshot.endpoints,
        snapshot.accounts,
        "demo-model",
        false,
        false,
        10,
        "normal",
        null,
        snapshot.modelStatuses
      );

    expect(selectDemoRoute().selected.endpoint.id).toBe("demo/openai");

    for (let index = 0; index < 2; index += 1) {
      harness.service.recordFailure({
        snapshot,
        providerKey: "demo",
        modelKey: "demo/demo-model",
        accountKey: "default",
        endpointKey: "openai",
        error: new HttpError(500, "provider_error", "Upstream failed")
      });
    }

    const model = harness.managedProviders.getAccountEndpointModel(
      "demo",
      "default",
      "openai",
      "demo/demo-model"
    );
    expect(model?.runtimeStatus).toBe("cooling_down");
    expect(model?.recentErrorCount).toBe(2);
    expect(model?.statusReason).toBe("upstream_error_cooldown");
    expect(harness.managedProviders.getAccount("demo", "default")?.runtimeStatus).toBe("normal");
    expect(
      harness.managedProviders.getModelByProviderAndKey("demo", "demo/demo-model")?.runtimeStatus
    ).toBe("normal");
    expect(selectDemoRoute).toThrowError(expect.objectContaining({
      statusCode: 503,
      code: "endpoint_unavailable"
    }));

    harness.service.recordSuccess({
      snapshot,
      providerKey: "demo",
      modelKey: "demo/demo-model",
      accountKey: "default",
      endpointKey: "openai"
    });
    expect(selectDemoRoute().selected.endpoint.id).toBe("demo/openai");
  });

  it("does not fall back to provider-model status when the account cannot use the model", () => {
    const harness = createHarness(tempDir);
    harness.managedProviders.syncProviderModels("demo", {
      accountKey: "default",
      status: "success",
      models: []
    });

    harness.service.recordFailure({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo/demo-model",
      accountKey: "default",
      endpointKey: "openai",
      error: new HttpError(400, "request_invalid", "Rejected request")
    });
    harness.service.recordSuccess({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo/demo-model",
      accountKey: "default",
      endpointKey: "openai"
    });

    expect(
      harness.managedProviders.getAccountEndpointModel(
        "demo",
        "default",
        "openai",
        "demo/demo-model"
      )
    ).toBeNull();
    expect(
      harness.managedProviders.getModelByProviderAndKey("demo", "demo/demo-model")
    ).toMatchObject({
      runtimeStatus: "normal",
      lastErrorAt: null,
      lastErrorCode: null,
      lastErrorMessage: null
    });
  });
});
