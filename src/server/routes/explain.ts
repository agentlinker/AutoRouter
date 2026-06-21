import type { FastifyInstance } from "fastify";

import type { TraceStore } from "../../trace/traceStore.js";

export async function registerExplainRoute(
  fastify: FastifyInstance,
  traceStore: TraceStore
) {
  fastify.get("/v1/autorouter/explain/latest", async () => {
    const latestTrace = traceStore.latest();
    if (!latestTrace) {
      return {
        trace_id: null,
        request: null,
        selected: null,
        filtered: [],
        fallbacks: []
      };
    }

      return {
        trace_id: latestTrace.trace_id,
        request: {
          model: latestTrace.request.model,
          normalized_model: latestTrace.request.normalized_model
        },
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
