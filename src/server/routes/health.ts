import type { FastifyInstance } from "fastify";

import type { RouterState } from "../../state/routerState.js";
import type { HealthResult } from "../../providers/adapter.js";

export async function registerHealthRoute(
  fastify: FastifyInstance,
  state: RouterState
) {
  fastify.get("/v1/autorouter/health", async () => {
    const checkedEndpoints = await Promise.all(
      state.endpoints.map(async (endpointState) => {
        const endpointConfig = state.config.endpoints[endpointState.id];
        const accountState = state.accounts.find(
          (account) => account.endpoint_id === endpointState.id && account.available
        );

        if (!endpointConfig || !accountState) {
          return endpointState;
        }

        const accountConfig = state.config.accounts[accountState.id];
        const apiKey = accountConfig?.credential_env
          ? process.env[accountConfig.credential_env]
          : undefined;
        const adapter = state.adapters.get(endpointConfig.adapter);
        const providerState = state.providers.find(
          (provider) => provider.id === endpointState.provider_id
        );
        const platformState = state.platforms.find(
          (platform) => platform.id === endpointState.platform_id
        );
        const healthModel = Object.entries(state.config.models).find(
          ([, model]) => model.endpoint === endpointState.id
        );
        let healthResult: HealthResult = { status: "down" };

        if (providerState && platformState && healthModel) {
          healthResult = await adapter.healthCheck({
            platform: platformState,
            provider: providerState,
            endpoint: endpointState,
            account: accountState,
            modelId: healthModel[0],
            model: healthModel[1],
            credential: apiKey
          });
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
