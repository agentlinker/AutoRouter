import Fastify, { type FastifyInstance } from "fastify";

import { ModelCatalog } from "../catalog/modelCatalog.js";
import type { RouterState } from "../state/routerState.js";
import { registerExplainRoute } from "./routes/explain.js";
import { isHttpError } from "../utils/httpErrors.js";
import { requireGatewayToken } from "./auth.js";
import { registerChatCompletionsRoute } from "./routes/chatCompletions.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerModelsRoute } from "./routes/models.js";

export async function createServer(state: RouterState): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false,
    requestTimeout: state.config.server.request_timeout_ms
  });
  const modelCatalog = new ModelCatalog(state.config);

  fastify.addHook("onRequest", async (request, reply) => {
    requireGatewayToken(
      request,
      reply,
      process.env[state.config.server.gateway_token_env]
    );
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

  await registerHealthRoute(fastify, state);
  await registerModelsRoute(fastify, modelCatalog);
  await registerChatCompletionsRoute(fastify, state, modelCatalog);
  await registerExplainRoute(fastify, state.traceStore);

  return fastify;
}
