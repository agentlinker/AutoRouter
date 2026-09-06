import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabaseClient } from "../../src/db/client.js";
import { ManagedProviderRepository } from "../../src/repositories/managedProviderRepository.js";
import { RuntimeConfigProjector } from "../../src/runtime/runtimeConfigProjector.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { AdapterRegistry } from "../../src/providers/registry.js";
import { StickySessionStore } from "../../src/routing/stickySession.js";
import { TraceStore } from "../../src/trace/traceStore.js";
import { RouteTraceRepository } from "../../src/repositories/routeTraceRepository.js";
import { SecretCipher } from "../../src/security/secretCipher.js";
import { createLogger } from "../../src/utils/logger.js";

describe("provider model catalog sharing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autorouter-endpoint-isolation-"));
    vi.stubEnv(
      "AUTO_ROUTER_MASTER_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createRepo() {
    const config = loadConfig({
      override: {
        database: { path: join(tempDir, "autorouter.db") },
        trace: { directory: join(tempDir, "traces"), log_prompts: false },
        routes: {},
        providers: {},
        endpoints: {},
        accounts: {},
        models: {},
        policies: {}
      }
    });
    const db = createDatabaseClient(config.database.path);
    return {
      config,
      db,
      repo: new ManagedProviderRepository(db.db),
      cipher: new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY)
    };
  }

  function seedSharedCatalogProvider(
    repo: ManagedProviderRepository,
    cipher: SecretCipher
  ) {
    repo.createProviderWithEndpointBundles({
      provider: {
        providerKey: "relay",
        displayName: "Relay",
        baseUrl: "https://relay.example.com/v1",
        providerKind: "relay"
      },
      encryptedApiKey: cipher.encrypt("key-a"),
      apiKeyHint: "...y-a",
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "openai",
            protocol: "openai-responses",
            baseUrl: "https://relay.example.com/v1"
          },
          models: [
            {
              modelKey: "relay/glm-5.2",
              providerModelId: "glm-5.2",
              modelName: "glm-5.2",
              supportsStreaming: true,
              supportsTools: true,
              supportsJsonMode: false
            }
          ]
        },
        {
          endpoint: {
            endpointKey: "anthropic",
            protocol: "anthropic-messages",
            baseUrl: "https://relay.example.com"
          },
          models: []
        }
      ]
    });
  }

  it("shares an account-visible provider model with every enabled endpoint", () => {
    const { repo, cipher } = createRepo();
    seedSharedCatalogProvider(repo, cipher);

    const bundles = repo.listEnabledProviderBundles();
    expect(
      bundles
        .map((bundle) => ({
          endpointKey: bundle.endpoint.endpointKey,
          models: bundle.models.map((model) => model.modelName)
        }))
        .sort((left, right) => left.endpointKey.localeCompare(right.endpointKey))
    ).toEqual([
      { endpointKey: "anthropic", models: ["glm-5.2"] },
      { endpointKey: "openai", models: ["glm-5.2"] }
    ]);
  });

  it("projects the shared model as a candidate on both protocols", () => {
    const { config, db, repo, cipher } = createRepo();
    seedSharedCatalogProvider(repo, cipher);
    repo.markAccountEndpointSuccess("relay", "default", "anthropic", true);

    const projector = new RuntimeConfigProjector({
      baseConfig: config,
      managedProviderRepository: repo,
      secretCipher: cipher,
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: new TraceStore(new RouteTraceRepository(db.db)),
      logger: createLogger()
    });
    const snapshot = projector.project();

    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]).toMatchObject({
      id: "relay/default",
      provider_key: "relay",
      account_key: "default"
    });
    expect(snapshot.accountEndpoints).toEqual([
      expect.objectContaining({
        account_id: "relay/default",
        endpoint_id: "relay/anthropic",
        runtime_status: "normal"
      })
    ]);

    const candidates = snapshot.modelCatalog.getCandidates("glm-5.2");
    expect(candidates.map((candidate) => candidate.endpoint).sort()).toEqual([
      "relay/anthropic",
      "relay/openai"
    ]);
    expect(new Set(candidates.map((candidate) => candidate.account))).toEqual(
      new Set(["relay/openai/default", "relay/anthropic/default"])
    );
  });

  it("updates one account catalog without assigning models to an endpoint", () => {
    const { repo, cipher } = createRepo();
    seedSharedCatalogProvider(repo, cipher);

    repo.syncProviderModels("relay", {
      accountKey: "default",
      catalogUrl: "https://relay.example.com/v1/models",
      status: "success",
      models: [
        {
          modelKey: "relay/glm-5.3",
          providerModelId: "glm-5.3",
          modelName: "glm-5.3",
          supportsStreaming: true,
          supportsTools: true,
          supportsJsonMode: false
        }
      ]
    });

    const modelsByEndpoint = repo
      .listEnabledProviderBundles()
      .map((bundle) => ({
        endpointKey: bundle.endpoint.endpointKey,
        models: bundle.models.map((model) => model.providerModelId)
      }))
      .sort((left, right) => left.endpointKey.localeCompare(right.endpointKey));

    expect(modelsByEndpoint).toEqual([
      { endpointKey: "anthropic", models: ["glm-5.3"] },
      { endpointKey: "openai", models: ["glm-5.3"] }
    ]);
  });

  it("blocks only the observed account-endpoint-model combination", () => {
    const { repo, cipher } = createRepo();
    seedSharedCatalogProvider(repo, cipher);

    const observation = repo.applyAccountEndpointModelFailure(
      "relay",
      "default",
      "anthropic",
      "relay/glm-5.2",
      {
        runtimeStatus: "abnormal",
        reason: "model_unavailable_permanent",
        cooldownUntil: null,
        code: "provider_invalid_model",
        message: "model is not available on this protocol"
      }
    );

    expect(observation?.runtimeStatus).toBe("abnormal");
    expect(
      repo.listEnabledProviderBundles()
        .map((bundle) => ({
          endpointKey: bundle.endpoint.endpointKey,
          models: bundle.models.map((model) => model.modelName)
        }))
        .sort((left, right) => left.endpointKey.localeCompare(right.endpointKey))
    ).toEqual([
      { endpointKey: "anthropic", models: [] },
      { endpointKey: "openai", models: ["glm-5.2"] }
    ]);
    expect(
      repo.getAccountEndpointModel("relay", "default", "openai", "relay/glm-5.2")
    ).toBeNull();
  });

  it("clears an observation back to unknown without changing account visibility", () => {
    const { repo, cipher } = createRepo();
    seedSharedCatalogProvider(repo, cipher);

    repo.applyAccountEndpointModelFailure(
      "relay",
      "default",
      "anthropic",
      "relay/glm-5.2",
      {
        runtimeStatus: "cooling_down",
        reason: "model_unavailable",
        cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
        code: "provider_invalid_model",
        message: "temporary model failure"
      }
    );

    expect(
      repo.clearAccountEndpointModelStatus("relay", "default", "anthropic", "relay/glm-5.2")
    ).toBe(true);
    expect(
      repo.getAccountEndpointModel("relay", "default", "anthropic", "relay/glm-5.2")
    ).toBeNull();
    expect(
      repo.listEnabledProviderBundles()
        .map((bundle) => bundle.endpoint.endpointKey)
        .sort()
    ).toEqual(["anthropic", "openai"]);
  });
});
