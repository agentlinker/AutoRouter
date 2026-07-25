import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

import { buildProviderRegistry } from "../../src/catalog/providerRegistry.js";
import { PriceTable } from "../../src/catalog/priceTable.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { createDatabaseClient } from "../../src/db/client.js";
import { AdapterRegistry } from "../../src/providers/registry.js";
import { RouteTraceRepository } from "../../src/repositories/routeTraceRepository.js";
import { StickySessionStore } from "../../src/routing/stickySession.js";
import { createServer } from "../../src/server/createServer.js";
import type { RouterState } from "../../src/state/routerState.js";
import { TraceStore } from "../../src/trace/traceStore.js";
import { createLogger } from "../../src/utils/logger.js";

describe("server body limit", () => {
  const traceDatabasePath = "/tmp/auto-router-body-limit-traces.db";

  beforeEach(() => {
    vi.stubEnv("AUTO_ROUTER_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(traceDatabasePath, { force: true });
  });

  it("rejects oversized request bodies with HTTP 413 before routing", async () => {
    const config = loadConfig({
      override: {
        server: {
          body_limit_bytes: 2048
        },
        trace: {
          directory: "/tmp/auto-router-body-limit-traces",
          log_prompts: false
        },
        platforms: {
          openai: {
            protocol: "openai"
          }
        },
        providers: {
          demo: {
            display_name: "Demo",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
          }
        },
        endpoints: {
          "demo-openai": {
            provider: "demo",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://example.com/v1"
          }
        },
        accounts: {
          "demo-account": {
            endpoint: "demo-openai",
            account_type: "api_key",
            credential_env: "PRIMARY_API_KEY"
          }
        },
        models: {
          "demo-model": {
            endpoint: "demo-openai",
            model_name: "demo-model",
            context_window: 128000
          }
        },
        routes: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                account: "demo-account",
                model: "demo-model"
              }
            ]
          }
        },
        policies: {
          balanced: {
            min_trust_level: "low",
            fallback_enabled: true
          }
        }
      }
    });

    const registry = buildProviderRegistry(config);
    const databaseClient = createDatabaseClient(traceDatabasePath);
    const state: RouterState = {
      config,
      logger: createLogger(),
      platforms: registry.platforms,
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: new TraceStore(new RouteTraceRepository(databaseClient.db))
    };

    const gateway = await createServer(state);
    const oversizedContent = "x".repeat(4096);

    const response = await gateway.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json"
      },
      payload: {
        model: "auto",
        input: oversizedContent
      }
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: {
        message: expect.stringMatching(/body is too large/i)
      }
    });

    await gateway.close();
  });
});
