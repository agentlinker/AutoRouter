import type { FastifyInstance } from "fastify";

import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import { HttpError } from "../../utils/httpErrors.js";
import { getPolicyDetail, listPolicies } from "./adminRouteHelpers.js";

export async function registerAdminPoliciesRoutes(
  fastify: FastifyInstance,
  dependencies: {
    runtimeManager: RuntimeManagerLike;
  }
) {
  fastify.get("/admin/api/policies", async () => {
    const snapshot = dependencies.runtimeManager.getSnapshot();

    return {
      data: listPolicies(snapshot.config)
    };
  });

  fastify.get<{ Params: { policyId: string } }>("/admin/api/policies/:policyId", async (request) => {
    const snapshot = dependencies.runtimeManager.getSnapshot();
    const detail = getPolicyDetail(snapshot.config, request.params.policyId);

    if (!detail) {
      throw new HttpError(404, "policy_not_found", "Policy not found");
    }

    return detail;
  });
}
