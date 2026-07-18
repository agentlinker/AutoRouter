import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import { HttpError } from "../../utils/httpErrors.js";
import { serializeTrace } from "./adminRouteHelpers.js";

const traceListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional().default(100)
});

export async function registerAdminTraceRoutes(
  fastify: FastifyInstance,
  dependencies: {
    runtimeManager: RuntimeManagerLike;
  }
) {
  fastify.get<{ Querystring: { limit?: string } }>("/admin/api/traces", async (request) => {
    const query = traceListQuerySchema.parse(request.query);
    const snapshot = dependencies.runtimeManager.getSnapshot();

    return {
      data: snapshot.traceStore.listRecent(query.limit).map(serializeTrace)
    };
  });

  fastify.get<{ Params: { traceId: string } }>("/admin/api/traces/:traceId", async (request) => {
    const snapshot = dependencies.runtimeManager.getSnapshot();
    const trace = snapshot.traceStore.getByTraceId(request.params.traceId);

    if (!trace) {
      throw new HttpError(404, "trace_not_found", "Trace not found");
    }

    return serializeTrace(trace);
  });
}
