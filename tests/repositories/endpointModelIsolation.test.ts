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

/**
 * 回归用例：endpoint 没有自己的模型时，不得借用同 provider 其它 endpoint 的模型。
 * 否则会造出「anthropic endpoint + openai 模型」这类不存在的候选，被路由选中后
 * 打到根本没有该模型的协议面上。
 */
describe("endpoint model isolation", () => {
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

  /** openai endpoint 有模型、anthropic endpoint 发现为空的 provider */
  function seedLopsidedProvider(
    repo: ManagedProviderRepository,
    cipher: SecretCipher,
    scope: "per_account" | "shared_by_provider"
  ) {
    repo.createProviderWithEndpointBundles({
      provider: {
        providerKey: "relay",
        displayName: "Relay",
        baseUrl: "https://relay.example.com/v1",
        providerKind: "relay",
        modelAvailabilityScope: scope
      },
      encryptedApiKey: cipher.encrypt("key-a"),
      apiKeyHint: "...y-a",
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "openai",
            protocol: "openai",
            baseUrl: "https://relay.example.com/v1"
          },
          models: [
            {
              modelKey: "relay/openai/glm-5.2",
              providerModelId: "openai:glm-5.2",
              modelName: "glm-5.2",
              supportsStreaming: true,
              supportsTools: true,
              supportsJsonMode: false
            }
          ]
        },
        {
          // 上游 anthropic 面没有 /models 接口，发现结果为空
          endpoint: {
            endpointKey: "anthropic",
            protocol: "anthropic",
            baseUrl: "https://relay.example.com"
          },
          models: []
        }
      ]
    });
  }

  it("keeps an empty endpoint empty instead of borrowing sibling endpoint models", () => {
    const { repo, cipher } = createRepo();
    seedLopsidedProvider(repo, cipher, "per_account");

    const bundles = repo.listEnabledProviderBundles();
    const anthropicBundles = bundles.filter(
      (bundle) => bundle.endpoint.endpointKey === "anthropic"
    );
    const openaiBundles = bundles.filter((bundle) => bundle.endpoint.endpointKey === "openai");

    expect(openaiBundles.flatMap((bundle) => bundle.models.map((model) => model.modelName))).toEqual([
      "glm-5.2"
    ]);
    expect(anthropicBundles.flatMap((bundle) => bundle.models)).toEqual([]);
  });

  it("does not project phantom candidates onto the model-less endpoint", () => {
    const { config, db, repo, cipher } = createRepo();
    seedLopsidedProvider(repo, cipher, "per_account");

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

    const modelIds = Object.keys(snapshot.config.models).filter((id) => id.startsWith("relay/"));
    expect(modelIds).toEqual(["relay/openai/glm-5.2"]);
    // 幻影 key 的特征：anthropic 路径下挂着带 openai: 前缀的上游模型 id
    expect(modelIds.some((id) => id.includes("/anthropic/"))).toBe(false);
  });

  it("applies the same isolation under shared_by_provider scope", () => {
    const { repo, cipher } = createRepo();
    seedLopsidedProvider(repo, cipher, "shared_by_provider");

    const bundles = repo.listEnabledProviderBundles();
    const anthropicBundles = bundles.filter(
      (bundle) => bundle.endpoint.endpointKey === "anthropic"
    );

    expect(anthropicBundles.length).toBeGreaterThan(0);
    expect(anthropicBundles.flatMap((bundle) => bundle.models)).toEqual([]);
  });

  it("still serves models once the endpoint syncs its own", () => {
    const { repo, cipher } = createRepo();
    seedLopsidedProvider(repo, cipher, "per_account");

    repo.syncProviderModels("relay", {
      endpointKey: "anthropic",
      accountKey: "default",
      status: "success",
      models: [
        {
          modelKey: "relay/anthropic/glm-5.2",
          providerModelId: "anthropic:glm-5.2",
          modelName: "glm-5.2",
          supportsStreaming: true,
          supportsTools: true,
          supportsJsonMode: false
        }
      ]
    });

    const anthropicModels = repo
      .listEnabledProviderBundles()
      .filter((bundle) => bundle.endpoint.endpointKey === "anthropic")
      .flatMap((bundle) => bundle.models.map((model) => model.providerModelId));

    expect(anthropicModels).toEqual(["anthropic:glm-5.2"]);
  });
});
