import type { FastifyInstance } from "fastify";

import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";

export async function registerModelsRoute(
  fastify: FastifyInstance,
  runtimeManager: RuntimeManagerLike
) {
  fastify.get("/v1/models", async () => {
    const { modelCatalog } = runtimeManager.getSnapshot();
    return {
      object: "list",
      data: modelCatalog.listEntries()
    };
  });
}
