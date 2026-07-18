import type { FastifyInstance } from "fastify";

import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import { HttpError } from "../../utils/httpErrors.js";
import { serializeTrace } from "./adminRouteHelpers.js";

export async function registerAdminUsageRoutes(
  fastify: FastifyInstance,
  dependencies: {
    runtimeManager: RuntimeManagerLike;
  }
) {
  fastify.get("/admin/api/usage", async () => {
    const snapshot = dependencies.runtimeManager.getSnapshot();

    return {
      totals: snapshot.traceStore.getUsageTotals(),
      providers: snapshot.traceStore.listUsageByProvider(),
      recent_requests: snapshot.traceStore.listRecent(20).map(serializeTrace)
    };
  });

  fastify.get<{ Params: { traceId: string } }>("/admin/api/usage/:traceId", async (request) => {
    const snapshot = dependencies.runtimeManager.getSnapshot();
    const trace = snapshot.traceStore.getByTraceId(request.params.traceId);

    if (!trace) {
      throw new HttpError(404, "trace_not_found", "Trace not found");
    }

    return serializeTrace(trace);
  });
}
