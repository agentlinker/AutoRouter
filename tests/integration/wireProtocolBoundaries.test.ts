import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";

import { buildProviderRegistry } from "../../src/catalog/providerRegistry.js";
import { PriceTable } from "../../src/catalog/priceTable.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { createDatabaseClient } from "../../src/db/client.js";
import { AdapterRegistry } from "../../src/providers/registry.js";
import { RouteTraceRepository } from "../../src/repositories/routeTraceRepository.js";
import { StickySessionStore } from "../../src/routing/stickySession.js";
import { createServer } from "../../src/server/createServer.js";
import { TraceStore } from "../../src/trace/traceStore.js";
import { createLogger } from "../../src/utils/logger.js";

const protocols = ["openai-responses", "openai-chat-completions", "anthropic-messages"] as const;
const ingress = [
  { protocol: protocols[0], path: "/v1/responses", body: { input: "Hello" } },
  { protocol: protocols[1], path: "/v1/chat/completions", body: { messages: [{ role: "user", content: "Hello" }] } },
  { protocol: protocols[2], path: "/v1/messages", body: { messages: [{ role: "user", content: "Hello" }], max_tokens: 20 } }
];

describe("gateway wire protocol boundaries", () => {
  let upstream: MockAgent;
  const servers: Awaited<ReturnType<typeof createServer>>[] = [];
  const databases: ReturnType<typeof createDatabaseClient>[] = [];

  beforeEach(() => {
    vi.stubEnv("AUTO_ROUTER_TOKEN", "test-token");
    upstream = new MockAgent();
    upstream.disableNetConnect();
    setGlobalDispatcher(upstream);
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    databases.splice(0).forEach((database) => database.sqlite.close());
    await upstream.close();
    vi.unstubAllEnvs();
  });

  async function harness(available: readonly string[] = protocols) {
    const config = loadConfig({ override: {
      providers: Object.fromEntries(available.map((protocol) => [protocol, {
        protocol, base_url: `https://${protocol}.example/v1`, privacy_level: "normal",
        accounts: [{ id: "main", account_type: "local_model" }],
        models: [{ id: "model", model_name: "model" }]
      }])),
      routes: { auto: { policy: "balanced", candidates: available.map((protocol) => ({
        provider: protocol, account: "main", model: "model"
      })) } }
    } });
    const database = createDatabaseClient(":memory:");
    databases.push(database);
    const traceStore = new TraceStore(new RouteTraceRepository(database.db));
    const gateway = await createServer({ config, ...buildProviderRegistry(config),
      logger: createLogger(), priceTable: new PriceTable(config), adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(), traceStore });
    servers.push(gateway);
    return { gateway, traceStore };
  }

  it.each(ingress)("attempts only $protocol for $path", async ({ protocol, path, body }) => {
    upstream.get(`https://${protocol}.example`).intercept({ path, method: "POST" })
      .reply(200, { id: "native", object: "response", content: [], choices: [], output: [] });
    const { gateway, traceStore } = await harness();
    const response = await gateway.inject({ method: "POST", url: path,
      headers: { authorization: "Bearer test-token" }, payload: { model: "auto", ...body } });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe("native");
    expect(traceStore.latest()?.attempts?.map((attempt) => attempt.provider)).toEqual([protocol]);
    upstream.assertNoPendingInterceptors();
  });

  it.each(ingress)("fails without attempting another protocol when $protocol is absent", async ({ protocol, path, body }) => {
    const { gateway, traceStore } = await harness(protocols.filter((candidate) => candidate !== protocol));
    const response = await gateway.inject({ method: "POST", url: path,
      headers: { authorization: "Bearer test-token" }, payload: { model: "auto", ...body } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("required_protocol_unavailable");
    expect(traceStore.latest()?.attempts ?? []).toHaveLength(0);
  });

  it("preserves a Responses failure instead of restarting routing through Chat Completions", async () => {
    upstream.get("https://openai-responses.example").intercept({ path: "/v1/responses", method: "POST" })
      .reply(404, { error: { message: "unsupported responses" } });
    const { gateway, traceStore } = await harness();
    const response = await gateway.inject({ method: "POST", url: "/v1/responses",
      headers: { authorization: "Bearer test-token" }, payload: { model: "auto", input: "Hello" } });
    expect(response.statusCode).toBe(404);
    expect(traceStore.latest()?.attempts?.map((attempt) => attempt.provider)).toEqual(["openai-responses"]);
  });
});
