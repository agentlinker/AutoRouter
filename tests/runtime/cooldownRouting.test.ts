import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/**
 * cooling_down 是新增的第 5 个运行态，routeEngine / projector 里多处判断原本只枚举
 * disabled|abnormal|rate_limited —— 漏掉新态会 fail-open（冷却写进 DB 但调度照样选它）。
 * 这组用例专门盯这些点：断言的是 selectRoute 的真实过滤结果，而不只是 DB 字段。
 */
function createHarness(tempDir: string) {
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
  const databaseClient = createDatabaseClient(config.database.path);
  const managedProviders = new ManagedProviderRepository(databaseClient.db);
  const appSettings = new AppSettingsRepository(databaseClient.db);
  const traceStore = new TraceStore(new RouteTraceRepository(databaseClient.db));
  const secretCipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);

  managedProviders.createProviderWithEndpointBundles({
    provider: {
      providerKey: "demo",
      displayName: "Demo",
      adapterType: "openai_compatible",
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
          adapterType: "openai_compatible",
          baseUrl: "https://demo.example.com/v1",
          supportsStreaming: true,
          supportsTools: true,
          supportsJsonMode: true
        },
        models: [
          {
            modelKey: "demo-model",
            providerModelId: "demo-model",
            modelName: "demo-model",
            contextWindow: 128000,
            supportsStreaming: true,
            supportsTools: true,
            supportsJsonMode: true
          },
          {
            modelKey: "demo-model-b",
            providerModelId: "demo-model-b",
            modelName: "demo-model-b",
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

  /** 从持久化状态重建快照后再跑一次真实路由选择 */
  async function routeAfterReload(model: string) {
    const snapshot = await runtimeManager.reload();
    try {
      const decision = selectRoute(
        snapshot.config,
        snapshot.modelCatalog,
        snapshot.priceTable,
        snapshot.platforms,
        snapshot.providers,
        snapshot.endpoints,
        snapshot.accounts,
        model,
        false,
        false,
        10,
        "normal",
        null,
        snapshot.modelStatuses
      );
      return { ok: true as const, decision, error: undefined };
    } catch (error) {
      return { ok: false as const, decision: undefined, error: error as HttpError };
    }
  }

  return {
    managedProviders,
    appSettings,
    runtimeManager,
    routeAfterReload,
    service: new RuntimeStatusService(managedProviders, appSettings)
  };
}

function transientError(status = 502) {
  return new HttpError(
    status,
    "provider_error",
    `Streaming responses request failed with status ${status}`,
    true
  );
}

describe("cooling_down routing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autorouter-cooldown-"));
    vi.stubEnv(
      "AUTO_ROUTER_MASTER_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("cools the whole account down on the first upstream 5xx", async () => {
    const harness = createHarness(tempDir);

    harness.service.recordFailure({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo-model",
      accountId: "demo/openai/default",
      error: transientError(502)
    });

    const account = harness.managedProviders.getAccount("demo", "default");
    expect(account?.runtimeStatus).toBe("cooling_down");
    expect(account?.statusReason).toBe("error_cooldown");
    expect(account?.cooldownStrike).toBe(1);
    expect(account?.statusCooldownUntil).toBeTruthy();

    // 同一次请求内立刻生效：内存快照里该 account 已不可用
    const live = harness.runtimeManager
      .getSnapshot()
      .accounts.find((item) => item.id === "demo/openai/default");
    expect(live?.available).toBe(false);
  });

  it("filters cooled-down candidates in selectRoute after a reload", async () => {
    const harness = createHarness(tempDir);

    expect((await harness.routeAfterReload("demo-model")).ok).toBe(true);

    harness.service.recordFailure({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo-model",
      accountId: "demo/openai/default",
      error: transientError(503)
    });

    // 关键断言：状态从 DB 重新投影之后，路由必须真的把候选过滤掉
    const routed = await harness.routeAfterReload("demo-model");
    if (routed.ok) {
      throw new Error("expected cooled-down model to be filtered");
    }
    expect(routed.error.statusCode).toBe(503);
    expect(routed.error.code).toBe("endpoint_unavailable");
  });

  it("skips every model under the cooled-down account, not just the failing one", async () => {
    const harness = createHarness(tempDir);

    harness.service.recordFailure({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo-model",
      accountId: "demo/openai/default",
      error: transientError(530)
    });

    // 节点级故障：同 account 下的另一个模型也应被跳过，不必各自再踩一次坑
    const routed = await harness.routeAfterReload("demo-model-b");
    if (routed.ok) {
      throw new Error("expected sibling model to be filtered by account cooldown");
    }
    expect(routed.error.code).toBe("endpoint_unavailable");
  });

  it("lets traffic through again once the cooldown expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    const harness = createHarness(tempDir);

    harness.service.recordFailure({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo-model",
      accountId: "demo/openai/default",
      error: transientError(502)
    });
    expect((await harness.routeAfterReload("demo-model")).ok).toBe(false);

    // 首档冷却 15s
    vi.setSystemTime(new Date("2026-07-27T00:00:20.000Z"));
    expect((await harness.routeAfterReload("demo-model")).ok).toBe(true);
  });

  it("clears the cooldown on the next success", async () => {
    const harness = createHarness(tempDir);

    harness.service.recordFailure({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo-model",
      accountId: "demo/openai/default",
      error: transientError(502)
    });
    expect(harness.managedProviders.getAccount("demo", "default")?.runtimeStatus).toBe(
      "cooling_down"
    );

    harness.service.recordSuccess({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo-model",
      accountId: "demo/openai/default"
    });

    const account = harness.managedProviders.getAccount("demo", "default");
    expect(account?.runtimeStatus).toBe("normal");
    expect(account?.cooldownStrike).toBe(0);
    expect((await harness.routeAfterReload("demo-model")).ok).toBe(true);
  });

  it("escalates the account cooldown ladder on repeated failures", () => {
    const harness = createHarness(tempDir);
    harness.appSettings.setRuntimeStatusSettings({ error_backoff_seconds: [10, 60] });

    for (let index = 0; index < 3; index += 1) {
      harness.service.recordFailure({
        snapshot: harness.runtimeManager.getSnapshot(),
        providerKey: "demo",
        modelKey: "demo-model",
        accountId: "demo/openai/default",
        error: transientError(502)
      });
    }

    const account = harness.managedProviders.getAccount("demo", "default");
    // 阶梯只有两档，第三次越界后按默认设置循环使用最后一档而不是转永久
    expect(account?.cooldownStrike).toBe(3);
    expect(account?.runtimeStatus).toBe("cooling_down");
    expect(account?.statusReason).toBe("error_cooldown");
  });

  it("pins the blame on the model once it exceeds the accumulated error threshold", () => {
    const harness = createHarness(tempDir);
    harness.appSettings.setRuntimeStatusSettings({ error_threshold: 2 });

    for (let index = 0; index < 2; index += 1) {
      harness.service.recordFailure({
        snapshot: harness.runtimeManager.getSnapshot(),
        providerKey: "demo",
        modelKey: "demo-model",
        accountId: "demo/openai/default",
        error: transientError(500)
      });
    }

    const model = harness.managedProviders.getModelByProviderAndKey("demo", "demo-model");
    expect(model?.runtimeStatus).toBe("abnormal");
    expect(model?.statusReason).toBe("error_threshold");
    expect(model?.recentErrorCount).toBe(2);

    // 永久熔断不能被一次成功自动清掉
    harness.service.recordSuccess({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo-model",
      accountId: "demo/openai/default"
    });
    expect(
      harness.managedProviders.getModelByProviderAndKey("demo", "demo-model")?.runtimeStatus
    ).toBe("abnormal");
  });

  it("cools only the model down for 404/410 and keeps siblings schedulable", async () => {
    const harness = createHarness(tempDir);

    harness.service.recordFailure({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo-model",
      accountId: "demo/openai/default",
      error: new HttpError(410, "provider_error", "Streaming responses request failed with status 410")
    });

    const model = harness.managedProviders.getModelByProviderAndKey("demo", "demo-model");
    expect(model?.runtimeStatus).toBe("cooling_down");
    expect(model?.statusReason).toBe("model_unavailable");
    expect(model?.cooldownStrike).toBe(1);
    // 独立长阶梯首档 1800s
    const cooldownMs = Date.parse(model!.statusCooldownUntil!) - Date.now();
    expect(cooldownMs).toBeGreaterThan(1700_000);
    expect(cooldownMs).toBeLessThanOrEqual(1800_000);

    // account 未被牵连
    expect(harness.managedProviders.getAccount("demo", "default")?.runtimeStatus).toBe("normal");

    const blocked = await harness.routeAfterReload("demo-model");
    if (blocked.ok) {
      throw new Error("expected unavailable model to be filtered");
    }
    expect(blocked.error.code).toBe("endpoint_unavailable");

    const sibling = await harness.routeAfterReload("demo-model-b");
    expect(sibling.ok).toBe(true);
  });

  it("keeps request-shaped 4xx from punishing the provider", async () => {
    const harness = createHarness(tempDir);

    for (const status of [400, 413, 422]) {
      harness.service.recordFailure({
        snapshot: harness.runtimeManager.getSnapshot(),
        providerKey: "demo",
        modelKey: "demo-model",
        accountId: "demo/openai/default",
        error: new HttpError(status, "request_invalid", `rejected with ${status}`)
      });
    }

    const account = harness.managedProviders.getAccount("demo", "default");
    const model = harness.managedProviders.getModelByProviderAndKey("demo", "demo-model");
    expect(account?.runtimeStatus).toBe("normal");
    expect(account?.cooldownStrike).toBe(0);
    expect(account?.recentErrorCount).toBe(0);
    expect(model?.runtimeStatus).toBe("normal");
    expect(model?.recentErrorCount).toBe(0);
    // 但要留痕，便于在 Admin 里看出这个节点老是拒绝请求
    expect(model?.lastErrorCode).toBe("request_invalid");
    expect(model?.lastErrorMessage).toBe("rejected with 422");

    expect((await harness.routeAfterReload("demo-model")).ok).toBe(true);
  });

  it("disables the account on 402 billing failures", async () => {
    const harness = createHarness(tempDir);

    harness.service.recordFailure({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo-model",
      accountId: "demo/openai/default",
      error: new HttpError(402, "request_invalid", "Insufficient balance")
    });

    const account = harness.managedProviders.getAccount("demo", "default");
    expect(account?.runtimeStatus).toBe("disabled");
    expect(account?.statusReason).toBe("billing_failed");

    const routed = await harness.routeAfterReload("demo-model");
    expect(routed.ok).toBe(false);

    // 需人工恢复：一次成功不应把它放回来
    harness.service.recordSuccess({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo-model",
      accountId: "demo/openai/default"
    });
    expect(harness.managedProviders.getAccount("demo", "default")?.runtimeStatus).toBe("disabled");
  });

  it("keeps 429 on the existing model-level rate limit ladder", async () => {
    const harness = createHarness(tempDir);

    harness.service.recordFailure({
      snapshot: harness.runtimeManager.getSnapshot(),
      providerKey: "demo",
      modelKey: "demo-model",
      accountId: "demo/openai/default",
      error: new HttpError(429, "provider_rate_limited", "Too many requests")
    });

    const model = harness.managedProviders.getModelByProviderAndKey("demo", "demo-model");
    expect(model?.runtimeStatus).toBe("rate_limited");
    expect(model?.rateLimitStrike).toBe(1);
    expect(model?.statusCooldownUntil).toBeTruthy();
    // 429 不牵连 account
    expect(harness.managedProviders.getAccount("demo", "default")?.runtimeStatus).toBe("normal");

    const routed = await harness.routeAfterReload("demo-model");
    expect(routed.ok).toBe(false);
  });
});
