import type { FastifyInstance } from "fastify";

import type { ManagedProviderRepository } from "../../repositories/managedProviderRepository.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import { HttpError } from "../../utils/httpErrors.js";
import { getApiKeyDetail, listApiKeys } from "./adminRouteHelpers.js";

export async function registerAdminApiKeysRoutes(
  fastify: FastifyInstance,
  dependencies: {
    runtimeManager: RuntimeManagerLike;
    repository: ManagedProviderRepository;
  }
) {
  fastify.get("/admin/api/api-keys", async () => {
    const snapshot = dependencies.runtimeManager.getSnapshot();
    return listApiKeys(dependencies.repository, snapshot.config);
  });

  fastify.get<{ Params: { keyScope: string; entryId: string } }>(
    "/admin/api/api-keys/:keyScope/:entryId",
    async (request) => {
      const snapshot = dependencies.runtimeManager.getSnapshot();
      const detail = getApiKeyDetail(
        dependencies.repository,
        snapshot.config,
        request.params.keyScope,
        request.params.entryId
      );

      if (!detail) {
        throw new HttpError(404, "api_key_not_found", "API key entry not found");
      }

      return detail;
    }
  );
}
