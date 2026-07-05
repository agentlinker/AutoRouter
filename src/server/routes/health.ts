import type { FastifyInstance } from "fastify";

import type { HealthResult } from "../../providers/adapter.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";

export async function registerHealthRoute(
  fastify: FastifyInstance,
  runtimeManager: RuntimeManagerLike
) {
  fastify.get("/v1/autorouter/health", async () => {
    const state = runtimeManager.getSnapshot();
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
        const apiKey = accountConfig
          ? state.credentialStore.resolve(accountState.id, accountConfig)
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
