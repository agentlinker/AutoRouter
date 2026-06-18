import type { FastifyInstance } from "fastify";

import type { RouterState } from "../../state/routerState.js";
import type { HealthResult } from "../../providers/adapter.js";

export async function registerHealthRoute(
  fastify: FastifyInstance,
  state: RouterState
) {
  fastify.get("/v1/auto-router/health", async () => {
    const checkedEndpoints = await Promise.all(
      state.endpoints.map(async (endpointState) => {
        const endpointConfig = state.config.endpoints[endpointState.id];
        const accountState = state.accounts.find(
          (account) => account.endpoint_id === endpointState.id && account.available
        );

        if (!endpointConfig || !accountState) {
          return endpointState;
        }

        const accountConfig = endpointConfig.accounts.find(
          (account) => account.id === accountState.id
        );
        const apiKey = accountConfig?.api_key_env
          ? process.env[accountConfig.api_key_env]
          : undefined;
        const adapter = state.adapters.get(endpointConfig.protocol);
        let healthResult: HealthResult = { status: "down" };

        try {
          healthResult = await adapter.healthCheck({
            endpointId: endpointState.id,
            platformId: endpointConfig.platform,
            accountId: accountState.id,
            model: "health-check",
            endpointConfig,
            apiKey
          });
        } catch {
          healthResult = { status: "down" };
        }

        endpointState.health = healthResult.status;
        return {
          ...endpointState,
          health_detail: healthResult.detail
        };
      })
    );

    return {
      status: "ok",
      gateway: {
        host: state.config.server.host,
        port: state.config.server.port
      },
      platforms: state.platforms,
      endpoints: checkedEndpoints,
      accounts: state.accounts
    };
  });
}
