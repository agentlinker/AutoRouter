import type { FastifyInstance } from "fastify";

import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";

export async function registerAdminTokensRoutes(
  fastify: FastifyInstance,
  dependencies: {
    runtimeManager: RuntimeManagerLike;
  }
) {
  fastify.get("/admin/api/tokens", async () => {
    const snapshot = dependencies.runtimeManager.getSnapshot();

    return {
      totals: snapshot.traceStore.getTokenTotals(),
      providers: snapshot.traceStore.listTokensByProvider(),
      models: snapshot.traceStore.listTokensByModel(20)
    };
  });
}
