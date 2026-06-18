import type { FastifyInstance } from "fastify";

import type { ModelCatalog } from "../../catalog/modelCatalog.js";

export async function registerModelsRoute(
  fastify: FastifyInstance,
  modelCatalog: ModelCatalog
) {
  fastify.get("/v1/models", async () => {
    return {
      object: "list",
      data: modelCatalog.listEntries()
    };
  });
}
