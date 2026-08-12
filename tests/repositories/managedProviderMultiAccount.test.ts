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

describe("managed provider multi-account", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autorouter-multi-account-"));
    vi.stubEnv(
      "AUTO_ROUTER_MASTER_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates default account, supports extra keys, and projects account ids", () => {
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
    const repo = new ManagedProviderRepository(db.db);
    const cipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);

    repo.createProviderWithEndpointBundles({
      provider: {
        providerKey: "demo",
        displayName: "Demo",
        adapterType: "openai_compatible",
        baseUrl: "https://demo.example.com/v1",
        providerKind: "official",
        modelAvailabilityScope: "shared_by_provider"
      },
      encryptedApiKey: cipher.encrypt("key-1"),
      apiKeyHint: "...y-1",
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "openai",
            protocol: "openai",
            adapterType: "openai_compatible",
            baseUrl: "https://demo.example.com/v1"
          },
          models: [
            {
              modelKey: "demo-model",
              providerModelId: "demo-model",
              modelName: "demo-model",
              supportsStreaming: true,
              supportsTools: true,
              supportsJsonMode: false
            }
          ]
        },
        {
          endpoint: {
            endpointKey: "anthropic",
            protocol: "anthropic",
            adapterType: "anthropic",
            baseUrl: "https://demo.example.com/anthropic"
          },
          models: []
        }
      ]
    });

    const created = repo.createAccount("demo", {
      accountKey: "backup",
      endpointKey: "openai",
      encryptedApiKey: cipher.encrypt("key-2"),
      apiKeyHint: "...y-2"
    });
    expect(created?.accountKey).toBe("backup");

    const details = repo.getProviderDetails("demo");
    expect(details?.provider.providerKind).toBe("official");
    expect(details?.accounts).toHaveLength(2);

    const bundles = repo.listEnabledProviderBundles();
    expect(bundles.some((item) => item.credential.accountKey === "default")).toBe(true);
    expect(bundles.some((item) => item.credential.accountKey === "backup")).toBe(true);

    repo.markAccountAuthFailed("demo", "backup", "Invalid API key");
    expect(repo.getAccount("demo", "backup")?.runtimeStatus).toBe("disabled");
    expect(repo.getProviderDetails("demo")?.provider.runtimeStatus).toBe("normal");

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
    expect(Object.keys(snapshot.config.accounts).some((id) => id.endsWith("/backup"))).toBe(true);
    const backup = snapshot.accounts.find((item) => item.id.endsWith("/backup"));
    expect(backup?.available).toBe(false);
  });

  it("suggests merge for same base_url + protocol", () => {
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
    const repo = new ManagedProviderRepository(db.db);
    const cipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);

    repo.createProviderWithEndpointBundles({
      provider: {
        providerKey: "bigmodel",
        displayName: "智谱官方",
        adapterType: "openai_compatible",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4/"
      },
      encryptedApiKey: cipher.encrypt("secret"),
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "openai",
            protocol: "openai",
            adapterType: "openai_compatible",
            baseUrl: "https://open.bigmodel.cn/api/paas/v4/"
          },
          models: []
        }
      ]
    });

    const matches = repo.findProvidersByEndpoint({
      protocol: "openai",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4"
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.provider.providerKey).toBe("bigmodel");
  });

  it("per_account isolates models so one key does not inherit another key discovery", () => {
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
    const repo = new ManagedProviderRepository(db.db);
    const cipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);

    repo.createProviderWithEndpointBundles({
      provider: {
        providerKey: "relay",
        displayName: "Relay",
        adapterType: "openai_compatible",
        baseUrl: "https://relay.example.com/v1",
        providerKind: "relay",
        modelAvailabilityScope: "per_account"
      },
      encryptedApiKey: cipher.encrypt("key-a"),
      apiKeyHint: "...y-a",
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "openai",
            protocol: "openai",
            adapterType: "openai_compatible",
            baseUrl: "https://relay.example.com/v1"
          },
          models: [
            {
              modelKey: "relay/model-a",
              providerModelId: "model-a",
              modelName: "model-a",
              supportsStreaming: true,
              supportsTools: true,
              supportsJsonMode: false
            }
          ]
        }
      ]
    });

    repo.createAccount("relay", {
      accountKey: "key-b",
      encryptedApiKey: cipher.encrypt("key-b"),
      apiKeyHint: "...y-b"
    });

    repo.syncProviderModels("relay", {
      endpointKey: "openai",
      accountKey: "key-b",
      status: "success",
      models: [
        {
          modelKey: "relay/model-b",
          providerModelId: "model-b",
          modelName: "model-b",
          supportsStreaming: true,
          supportsTools: false,
          supportsJsonMode: false
        }
      ]
    });

    const bundles = repo.listEnabledProviderBundles();
    const defaultBundle = bundles.find((item) => item.credential.accountKey === "default");
    const keyBBundle = bundles.find((item) => item.credential.accountKey === "key-b");

    expect(defaultBundle?.models.map((model) => model.modelName)).toEqual(["model-a"]);
    expect(keyBBundle?.models.map((model) => model.modelName)).toEqual(["model-b"]);

    const details = repo.getProviderDetails("relay");
    const accountModelNames = new Map(
      details?.accounts.map((account) => [
        account.accountKey,
        details.accountModels
          .find((item) => item.accountId === account.id)
          ?.models.map((model) => model.modelName) ?? []
      ])
    );
    expect(accountModelNames.get("default")).toEqual(["model-a"]);
    expect(accountModelNames.get("key-b")).toEqual(["model-b"]);

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
    expect(Object.keys(snapshot.config.accounts).some((id) => id.endsWith("/default"))).toBe(true);
    expect(Object.keys(snapshot.config.accounts).some((id) => id.endsWith("/key-b"))).toBe(true);
    const modelNames = Object.values(snapshot.config.models).map((model) => model.model_name);
    expect(modelNames).toEqual(expect.arrayContaining(["model-a", "model-b"]));

    const candidates = snapshot.modelCatalog.getCandidates("model-a");
    expect(candidates.every((item) => item.account.endsWith("/default"))).toBe(true);
    expect(candidates.some((item) => item.account.endsWith("/key-b"))).toBe(false);

    const candidatesB = snapshot.modelCatalog.getCandidates("model-b");
    expect(candidatesB.every((item) => item.account.endsWith("/key-b"))).toBe(true);
    expect(candidatesB.some((item) => item.account.endsWith("/default"))).toBe(false);
  });

  it("elevates provider priority above the current maximum", () => {
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
    const repo = new ManagedProviderRepository(db.db);
    const cipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);

    repo.createProviderWithEndpointBundles({
      provider: {
        providerKey: "alpha",
        displayName: "Alpha",
        adapterType: "openai_compatible",
        baseUrl: "https://alpha.example.com/v1",
        priority: 3
      },
      encryptedApiKey: cipher.encrypt("alpha-key"),
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "openai",
            protocol: "openai",
            adapterType: "openai_compatible",
            baseUrl: "https://alpha.example.com/v1"
          },
          models: []
        }
      ]
    });

    repo.createProviderWithEndpointBundles({
      provider: {
        providerKey: "beta",
        displayName: "Beta",
        adapterType: "openai_compatible",
        baseUrl: "https://beta.example.com/v1",
        priority: 1
      },
      encryptedApiKey: cipher.encrypt("beta-key"),
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "openai",
            protocol: "openai",
            adapterType: "openai_compatible",
            baseUrl: "https://beta.example.com/v1"
          },
          models: []
        }
      ]
    });

    const updated = repo.elevateProviderPriority("beta");
    expect(updated?.provider.priority).toBe(4);
    expect(repo.getMaxProviderPriority()).toBe(4);

    const firstPage = repo.listProviderSummariesPage({
      sortBy: "priority",
      sortDir: "desc",
      page: 1,
      pageSize: 1
    });
    expect(firstPage.total).toBe(2);
    expect(firstPage.availableTotal).toBe(0);
    expect(firstPage.items.map((item) => item.provider.providerKey)).toEqual(["beta"]);
    expect(firstPage.page).toBe(1);
    expect(firstPage.pageSize).toBe(1);

    const secondPage = repo.listProviderSummariesPage({
      sortBy: "priority",
      sortDir: "desc",
      page: 2,
      pageSize: 1
    });
    expect(secondPage.availableTotal).toBe(0);
    expect(secondPage.items.map((item) => item.provider.providerKey)).toEqual(["alpha"]);
  });

  it("replaces a provider with more models than one SQLite insert can bind", () => {
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
    const repo = new ManagedProviderRepository(db.db);
    const cipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);

    repo.createProviderWithEndpointBundles({
      provider: {
        providerKey: "large-catalog",
        displayName: "Large Catalog",
        adapterType: "openai_compatible",
        baseUrl: "https://old.example.com/v1",
        providerKind: "relay",
        modelAvailabilityScope: "per_account"
      },
      encryptedApiKey: cipher.encrypt("large-key"),
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "openai",
            protocol: "openai",
            adapterType: "openai_compatible",
            baseUrl: "https://old.example.com/v1"
          },
          models: []
        }
      ]
    });

    const models = Array.from({ length: 2_200 }, (_, index) => ({
      modelKey: `large-catalog/model-${index}`,
      providerModelId: `model-${index}`,
      modelName: `model-${index}`,
      supportsStreaming: true,
      supportsTools: false,
      supportsJsonMode: false
    }));

    const replaced = repo.replaceProviderWithEndpointBundles({
      providerKey: "large-catalog",
      provider: {
        providerKey: "large-catalog",
        displayName: "Large Catalog",
        adapterType: "openai_compatible",
        baseUrl: "https://new.example.com/v1",
        providerKind: "relay",
        modelAvailabilityScope: "per_account"
      },
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "openai",
            protocol: "openai",
            adapterType: "openai_compatible",
            baseUrl: "https://new.example.com/v1"
          },
          models
        }
      ]
    });

    expect(replaced?.provider.baseUrl).toBe("https://new.example.com/v1");
    expect(replaced?.models).toHaveLength(2_200);
    expect(replaced?.accountModels[0]?.models).toHaveLength(2_200);
  });
});
