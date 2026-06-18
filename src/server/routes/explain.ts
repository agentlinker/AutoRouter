import type { FastifyInstance } from "fastify";

import type { TraceStore } from "../../trace/traceStore.js";

export async function registerExplainRoute(
  fastify: FastifyInstance,
  traceStore: TraceStore
) {
  fastify.get("/v1/auto-router/explain/latest", async () => {
    const latestTrace = traceStore.latest();
    if (!latestTrace) {
      return {
        trace_id: null,
        selected: null,
        filtered: [],
        fallbacks: []
      };
    }

      return {
        trace_id: latestTrace.trace_id,
        selected: latestTrace.selected
          ? {
            endpoint: latestTrace.selected.endpoint,
            platform: latestTrace.selected.platform,
            model: latestTrace.selected.model
          }
        : null,
      policy_hits: latestTrace.policy_hits,
      filtered: latestTrace.filtered,
      fallbacks: latestTrace.fallbacks
    };
  });
}
