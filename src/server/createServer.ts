import Fastify, { type FastifyInstance } from "fastify";

import { registerExplainRoute } from "./routes/explain.js";
import { isHttpError } from "../utils/httpErrors.js";
import { requireAdminToken, requireGatewayToken } from "./auth.js";
import { registerChatCompletionsRoute } from "./routes/chatCompletions.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerModelsRoute } from "./routes/models.js";
import { registerResponsesRoute } from "./routes/responses.js";
import { registerAdminApiKeysRoutes } from "./routes/adminApiKeys.js";
import { registerAdminPoliciesRoutes } from "./routes/adminPolicies.js";
import { registerAdminSettingsRoutes } from "./routes/adminSettings.js";
import { registerAdminTokensRoutes } from "./routes/adminTokens.js";
import { registerAdminTraceRoutes } from "./routes/adminTraces.js";
import { registerAdminUsageRoutes } from "./routes/adminUsage.js";
import type { RuntimeManagerLike } from "../runtime/runtimeTypes.js";
import { createStaticRuntimeManager } from "../runtime/runtimeManager.js";
import { registerAdminProvidersRoutes } from "./routes/adminProviders.js";
import { registerAdminUiRoutes } from "./routes/adminUi.js";
import type { ManagedProviderRepository } from "../repositories/managedProviderRepository.js";
import type { ProviderModelDiscoveryService } from "../discovery/providerModelDiscovery.js";
import type { SecretCipher } from "../security/secretCipher.js";
import type { RouterState } from "../state/routerState.js";

function toRuntimeManagerLike(input: RuntimeManagerLike | RouterState): RuntimeManagerLike {
  if ("getSnapshot" in input && typeof input.getSnapshot === "function") {
    return input;
  }

  return createStaticRuntimeManager(input as RouterState);
}

export async function createServer(
  runtimeInput: RuntimeManagerLike | RouterState,
  dependencies?: {
    managedProviderRepository?: ManagedProviderRepository;
    discoveryService?: ProviderModelDiscoveryService;
    secretCipher?: SecretCipher;
  }
): Promise<FastifyInstance> {
  const runtimeManager = toRuntimeManagerLike(runtimeInput);
  const initialState = runtimeManager.getSnapshot();
  const fastify = Fastify({
    logger: false,
    requestTimeout: initialState.config.server.request_timeout_ms
  });

  fastify.addHook("onRequest", async (request, reply) => {
    const snapshot = runtimeManager.getSnapshot();
    const adminApiPath = request.url.startsWith("/admin/api");

    if (adminApiPath) {
      requireAdminToken(request, reply, process.env[snapshot.config.server.admin_token_env]);
      return;
    }

    if (request.url.startsWith("/admin")) {
      return;
    }

    requireGatewayToken(request, reply, process.env[snapshot.config.server.gateway_token_env]);
  });

  fastify.setErrorHandler((error, _request, reply) => {
    if (isHttpError(error)) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message
        }
      });
      return;
    }

    reply.status(500).send({
      error: {
        code: "internal_error",
        message: "Internal server error"
      }
    });
  });

  fastify.addHook("onClose", async () => {
    await runtimeManager.getSnapshot().traceStore.close();
  });

  await registerAdminUiRoutes(fastify);
  if (
    dependencies?.managedProviderRepository &&
    dependencies.discoveryService &&
    dependencies.secretCipher
  ) {
    await registerAdminProvidersRoutes(fastify, {
      runtimeManager,
      repository: dependencies.managedProviderRepository,
      discoveryService: dependencies.discoveryService,
      secretCipher: dependencies.secretCipher
    });
    await registerAdminApiKeysRoutes(fastify, {
      runtimeManager,
      repository: dependencies.managedProviderRepository
    });
    await registerAdminUsageRoutes(fastify, {
      runtimeManager
    });
    await registerAdminTraceRoutes(fastify, {
      runtimeManager
    });
    await registerAdminTokensRoutes(fastify, {
      runtimeManager
    });
    await registerAdminPoliciesRoutes(fastify, {
      runtimeManager
    });
    await registerAdminSettingsRoutes(fastify, {
      runtimeManager,
    });
  }

  await registerHealthRoute(fastify, runtimeManager);
  await registerModelsRoute(fastify, runtimeManager);
  await registerChatCompletionsRoute(fastify, runtimeManager);
  await registerResponsesRoute(fastify);
  await registerExplainRoute(fastify, runtimeManager.getSnapshot().traceStore);

  return fastify;
}
