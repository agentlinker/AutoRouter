import { createLogger } from "./utils/logger.js";
import { buildProviderRegistry } from "./catalog/providerRegistry.js";
import { PriceTable } from "./catalog/priceTable.js";
import { loadConfig } from "./config/loadConfig.js";
import { AdapterRegistry } from "./providers/registry.js";
import { StickySessionStore } from "./routing/stickySession.js";
import { createServer } from "./server/createServer.js";
import type { RouterState } from "./state/routerState.js";
import { TraceStore } from "./trace/traceStore.js";

async function main() {
  const logger = createLogger();
  const config = loadConfig();
  const registry = buildProviderRegistry(config);
  const priceTable = new PriceTable(config);
  const adapters = new AdapterRegistry();
  const stickySessions = new StickySessionStore();
  const traceStore = new TraceStore(config.trace.directory);

  const state: RouterState = {
    config,
    logger,
    platforms: registry.platforms,
    providers: registry.providers,
    endpoints: registry.endpoints,
    accounts: registry.accounts,
    priceTable,
    adapters,
    stickySessions,
    traceStore
  };

  const server = await createServer(state);
  const address = await server.listen({
    host: config.server.host,
    port: config.server.port
  });

  logger.info({ address }, "AutoRouter listening");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
