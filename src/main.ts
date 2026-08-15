import { config as loadEnvironment } from "dotenv";
import { fileURLToPath } from "node:url";

loadEnvironment({ path: fileURLToPath(new URL("../config/.env", import.meta.url)) });

import { createLogger } from "./utils/logger.js";
import { loadConfig } from "./config/loadConfig.js";
import { createDatabaseClient } from "./db/client.js";
import { ProviderModelDiscoveryService } from "./discovery/providerModelDiscovery.js";
import { AdapterRegistry } from "./providers/registry.js";
import { ManagedProviderRepository } from "./repositories/managedProviderRepository.js";
import { AppSettingsRepository } from "./repositories/appSettingsRepository.js";
import { RuntimeStatusService } from "./runtime/runtimeStatusService.js";
import { RouteTraceRepository } from "./repositories/routeTraceRepository.js";
import { StickySessionStore } from "./routing/stickySession.js";
import { RuntimeManager } from "./runtime/runtimeManager.js";
import { SecretCipher } from "./security/secretCipher.js";
import { createServer } from "./server/createServer.js";
import { TraceArchiveWriter } from "./trace/traceArchiveWriter.js";
import { TraceStore } from "./trace/traceStore.js";

async function main() {
  const logger = createLogger();
  const config = loadConfig();
  const databaseClient = createDatabaseClient(config.database.path);
  const managedProviderRepository = new ManagedProviderRepository(databaseClient.db);
  const appSettingsRepository = new AppSettingsRepository(databaseClient.db);
  const runtimeStatusService = new RuntimeStatusService(managedProviderRepository, appSettingsRepository);
  const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
  const adapters = new AdapterRegistry();
  const stickySessions = new StickySessionStore();
  const traceArchiveWriter = new TraceArchiveWriter({
    directory: config.trace.archive.directory,
    flushBatchSize: config.trace.archive.flush_batch_size,
    logger
  });
  const traceStore = new TraceStore(routeTraceRepository, {
    hotRetentionDays: config.trace.hot_retention_days,
    archiveWriter: traceArchiveWriter,
    logger
  });
  const secretCipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);
  const runtimeManager = new RuntimeManager({
    baseConfig: config,
    managedProviderRepository,
    appSettingsRepository,
    secretCipher,
    adapters,
    stickySessions,
    traceStore,
    logger
  });
  const discoveryService = new ProviderModelDiscoveryService();

  const server = await createServer(runtimeManager, {
    managedProviderRepository,
    discoveryService,
    secretCipher,
    appSettingsRepository,
    runtimeStatusService
  });
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
