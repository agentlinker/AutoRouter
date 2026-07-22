import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ProviderModelDiscoveryService } from "../../discovery/providerModelDiscovery.js";
import { ManagedProviderRepository, type ManagedDiscoveredModelInput } from "../../repositories/managedProviderRepository.js";
import { SecretCipher } from "../../security/secretCipher.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import { HttpError } from "../../utils/httpErrors.js";

const protocolSchema = z.enum(["openai", "anthropic"]);
const endpointAdapterSchema = z.enum(["openai_compatible", "openrouter", "anthropic"]);
const endpointKeySchema = z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/);

const createProviderBodySchema = z.object({
  provider_key: z.string().min(1),
  display_name: z.string().min(1),
  protocol: protocolSchema.optional(),
  base_url: z.string().url().optional(),
  endpoints: z.array(z.object({
    endpoint_key: endpointKeySchema,
    protocol: protocolSchema,
    base_url: z.string().url(),
    enabled: z.boolean().optional()
  }).strict()).min(1).optional(),
  website_url: z.string().url().optional().or(z.literal("")),
  api_key: z.string().min(1),
  trust_level: z.enum(["low", "medium", "high"]).default("low"),
  privacy_level: z.enum(["public_only", "normal", "private"]).default("normal"),
  usage_trust: z.enum(["low", "medium", "high"]).default("low")
}).strict();

const patchProviderBodySchema = z.object({
  enabled: z.boolean().optional(),
  display_name: z.string().min(1).optional(),
  protocol: protocolSchema.optional(),
  base_url: z.string().url().optional(),
  endpoints: z.array(z.object({
    endpoint_key: endpointKeySchema,
    protocol: protocolSchema,
    base_url: z.string().url(),
    enabled: z.boolean().optional()
  }).strict()).min(1).optional(),
  website_url: z.string().url().optional().or(z.literal("")),
  api_key: z.string().min(1).optional()
}).strict();

const createEndpointBodySchema = z.object({
  endpoint_key: endpointKeySchema,
  protocol: protocolSchema,
  adapter_type: endpointAdapterSchema,
  base_url: z.string().url(),
  enabled: z.boolean().optional(),
  api_key: z.string().min(1).optional()
}).strict();

const patchEndpointBodySchema = z.object({
  protocol: protocolSchema.optional(),
  adapter_type: endpointAdapterSchema.optional(),
  base_url: z.string().url().optional(),
  enabled: z.boolean().optional()
}).strict();

const patchModelCapabilitiesBodySchema = z.object({
  model_key: z.string().min(1),
  supports_streaming: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_json_mode: z.boolean().optional()
}).strict();

async function discoverModelsForEndpoint(
  discoveryService: ProviderModelDiscoveryService,
  input: {
    providerKey: string;
    endpointKey: string;
    protocol: "openai" | "anthropic";
    adapterType: "openai_compatible" | "openrouter" | "anthropic";
    baseUrl: string;
    apiKey: string;
  }
) {
  const discoveryInput = {
    providerKey: input.endpointKey === "default" ? input.providerKey : `${input.providerKey}/${input.endpointKey}`,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey
  };

  if (input.protocol === "anthropic" || input.adapterType === "anthropic") {
    const models = await discoveryService.listAnthropicModels(discoveryInput);
    return input.endpointKey === "default"
      ? models
      : models.map((model) => ({
          ...model,
          providerModelId: `${input.endpointKey}:${model.providerModelId}`
        }));
  }

  const models = await discoveryService.listOpenAiCompatibleModels(discoveryInput);
  return input.endpointKey === "default"
    ? models
    : models.map((model) => ({
        ...model,
        providerModelId: `${input.endpointKey}:${model.providerModelId}`
      }));
}

function normalizeEndpointInputs(input: {
  protocol?: "openai" | "anthropic";
  baseUrl?: string;
  endpoints?: Array<{
    endpoint_key: string;
    protocol: "openai" | "anthropic";
    base_url: string;
    enabled?: boolean;
  }>;
}): Array<{
  endpoint_key: string;
  protocol: "openai" | "anthropic";
  base_url: string;
  enabled?: boolean;
}> {
  if (input.endpoints && input.endpoints.length > 0) {
    return input.endpoints;
  }

  if (input.baseUrl !== undefined || input.protocol !== undefined) {
    if (!input.baseUrl) {
      throw new HttpError(400, "invalid_request", "Base URL is required");
    }

    return [
      {
        endpoint_key: "default",
        protocol: input.protocol ?? "openai",
        base_url: input.baseUrl,
        enabled: true
      }
    ];
  }

  return [];
}

function toAdapterType(protocol: "openai" | "anthropic"): "openai_compatible" | "anthropic" {
  return protocol === "anthropic" ? "anthropic" : "openai_compatible";
}

function buildProviderInput(input: {
  provider_key: string;
  display_name: string;
  website_url?: string | null;
  trust_level: "low" | "medium" | "high";
  privacy_level: "public_only" | "normal" | "private";
  usage_trust: "low" | "medium" | "high";
  enabled?: boolean;
}, endpointInputs: Array<{
  endpoint_key: string;
  protocol: "openai" | "anthropic";
  base_url: string;
  enabled?: boolean;
}>): {
  providerKey: string;
  displayName: string;
  adapterType: "openai_compatible" | "openrouter" | "anthropic";
  baseUrl: string;
  websiteUrl: string | null;
  enabled?: boolean;
  trustLevel: "low" | "medium" | "high";
  privacyLevel: "public_only" | "normal" | "private";
  usageTrust: "low" | "medium" | "high";
} {
  const representativeEndpoint = endpointInputs[0];

  return {
    providerKey: input.provider_key,
    displayName: input.display_name,
    adapterType: representativeEndpoint ? toAdapterType(representativeEndpoint.protocol) : "openai_compatible",
    baseUrl: representativeEndpoint?.base_url ?? "",
    websiteUrl: input.website_url || null,
    enabled: input.enabled,
    trustLevel: input.trust_level,
    privacyLevel: input.privacy_level,
    usageTrust: input.usage_trust
  };
}

function ensureUniqueEndpointKeys(
  endpoints: Array<{
    endpoint_key: string;
    protocol: "openai" | "anthropic";
    base_url: string;
    enabled?: boolean;
  }>
) {
  const seen = new Set<string>();

  for (const endpoint of endpoints) {
    if (seen.has(endpoint.endpoint_key)) {
      throw new HttpError(400, "invalid_request", "Endpoint Key must be unique");
    }

    seen.add(endpoint.endpoint_key);
  }
}

async function discoverEndpointBundles(
  discoveryService: ProviderModelDiscoveryService,
  input: {
    providerKey: string;
    apiKey: string;
    endpoints: Array<{
      endpoint_key: string;
      protocol: "openai" | "anthropic";
      base_url: string;
      enabled?: boolean;
    }>;
  }
) {
  return Promise.all(
    input.endpoints.map(async (endpoint) => {
      let models: ManagedDiscoveredModelInput[];
      try {
        models = await discoverModelsForEndpoint(discoveryService, {
          providerKey: input.providerKey,
          endpointKey: endpoint.endpoint_key,
          protocol: endpoint.protocol,
          adapterType: toAdapterType(endpoint.protocol),
          baseUrl: endpoint.base_url,
          apiKey: input.apiKey
        });
      } catch {
        models = [];
      }

      return {
        endpoint: {
          endpointKey: endpoint.endpoint_key,
          protocol: endpoint.protocol,
          adapterType: toAdapterType(endpoint.protocol),
          baseUrl: endpoint.base_url,
          enabled: endpoint.enabled
        },
        models
      };
    })
  );
}

function serializeProviderDetails(details: ReturnType<ManagedProviderRepository["getProviderDetails"]>) {
  if (!details) {
    return null;
  }

  return {
    provider_key: details.provider.providerKey,
    display_name: details.provider.displayName,
    adapter_type: details.provider.adapterType,
    base_url: details.provider.baseUrl,
    website_url: details.provider.websiteUrl,
    enabled: details.provider.enabled,
    trust_level: details.provider.trustLevel,
    privacy_level: details.provider.privacyLevel,
    usage_trust: details.provider.usageTrust,
    key_hint: details.credential?.keyHint ?? null,
    endpoints: details.endpoints.map((endpoint) => ({
      endpoint_key: endpoint.endpointKey,
      protocol: endpoint.protocol,
      adapter_type: endpoint.adapterType,
      base_url: endpoint.baseUrl,
      enabled: endpoint.enabled,
      supports_streaming: endpoint.supportsStreaming,
      supports_tools: endpoint.supportsTools,
      supports_json_mode: endpoint.supportsJsonMode
    })),
    latest_sync: details.latestSync
      ? {
          status: details.latestSync.status,
          error_message: details.latestSync.errorMessage,
          started_at: details.latestSync.startedAt,
          finished_at: details.latestSync.finishedAt,
          discovered_count: details.latestSync.discoveredCount
        }
      : null,
    models: details.models.map((model) => ({
      model_key: model.modelKey,
      provider_model_id: model.providerModelId,
      model_name: model.modelName,
      context_window: model.contextWindow,
      supports_streaming: model.supportsStreaming,
      supports_tools: model.supportsTools,
      supports_json_mode: model.supportsJsonMode,
      endpoint_key:
        details.endpoints.find((endpoint) => endpoint.id === model.endpointId)?.endpointKey ?? "default"
    }))
  };
}

export async function registerAdminProvidersRoutes(
  fastify: FastifyInstance,
  dependencies: {
    runtimeManager: RuntimeManagerLike;
    repository: ManagedProviderRepository;
    discoveryService: ProviderModelDiscoveryService;
    secretCipher: SecretCipher;
  }
) {
  fastify.get("/admin/api/providers", async () => {
    return {
      data: dependencies.repository.listProviderSummaries().map((item) => serializeProviderDetails(item))
    };
  });

  fastify.get<{ Params: { providerKey: string } }>("/admin/api/providers/:providerKey", async (request) => {
    const details = dependencies.repository.getProviderDetails(request.params.providerKey);
    if (!details) {
      throw new HttpError(404, "provider_not_found", "Provider not found");
    }

    return serializeProviderDetails(details);
  });

  fastify.post<{ Body: unknown }>("/admin/api/providers", async (request, reply) => {
    const body = createProviderBodySchema.parse(request.body);

    if (dependencies.repository.getProviderDetails(body.provider_key)) {
      throw new HttpError(409, "provider_exists", "Provider already exists");
    }

    const endpointInputs = normalizeEndpointInputs({
      protocol: body.protocol,
      baseUrl: body.base_url,
      endpoints: body.endpoints
    });
    if (endpointInputs.length === 0) {
      throw new HttpError(400, "invalid_request", "At least one endpoint is required");
    }
    ensureUniqueEndpointKeys(endpointInputs);

    const endpointBundles = await discoverEndpointBundles(dependencies.discoveryService, {
      providerKey: body.provider_key,
      apiKey: body.api_key,
      endpoints: endpointInputs
    });

    const details = dependencies.repository.createProviderWithEndpointBundles({
      provider: buildProviderInput(body, endpointInputs),
      encryptedApiKey: dependencies.secretCipher.encrypt(body.api_key),
      apiKeyHint: ManagedProviderRepository.toApiKeyHint(body.api_key),
      endpointBundles
    });

    await dependencies.runtimeManager.reload();
    reply.status(201);
    return serializeProviderDetails(details);
  });

  fastify.post<{ Params: { providerKey: string } }>(
    "/admin/api/providers/:providerKey/sync-models",
    async (request) => {
      const details = dependencies.repository.getProviderDetails(request.params.providerKey);
      if (!details || !details.credential) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }

      const apiKey = dependencies.secretCipher.decrypt(details.credential.apiKeyEncrypted);
      const endpoint = details.endpoints.find((item) => item.endpointKey === "default") ?? details.endpoints[0];
      if (!endpoint) {
        throw new HttpError(404, "endpoint_not_found", "Provider endpoint not found");
      }

      const discoveredModels = await discoverModelsForEndpoint(dependencies.discoveryService, {
        providerKey: details.provider.providerKey,
        endpointKey: endpoint.endpointKey,
        protocol: endpoint.protocol as "openai" | "anthropic",
        adapterType: endpoint.adapterType as "openai_compatible" | "openrouter" | "anthropic",
        baseUrl: endpoint.baseUrl,
        apiKey
      });

      const updated = dependencies.repository.syncProviderModels(details.provider.providerKey, {
        endpointKey: endpoint.endpointKey,
        status: "success",
        models: discoveredModels
      });

      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(updated);
    }
  );

  fastify.patch<{ Params: { providerKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey",
    async (request) => {
      const body = patchProviderBodySchema.parse(request.body);
      const existing = dependencies.repository.getProviderDetails(request.params.providerKey);
      if (!existing) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }

      const credentialForSync = body.api_key
        ? body.api_key
        : existing.credential
          ? dependencies.secretCipher.decrypt(existing.credential.apiKeyEncrypted)
          : null;
      const endpointInputs = normalizeEndpointInputs({
        protocol: body.protocol,
        baseUrl: body.base_url,
        endpoints: body.endpoints
      });
      const shouldReplaceEndpoints =
        body.endpoints !== undefined || body.base_url !== undefined || body.protocol !== undefined;

      if (shouldReplaceEndpoints) {
        if (endpointInputs.length === 0) {
          throw new HttpError(400, "invalid_request", "At least one endpoint is required");
        }
        ensureUniqueEndpointKeys(endpointInputs);
        if (!credentialForSync) {
          throw new HttpError(400, "credential_required", "API key is required when changing endpoints");
        }

        const endpointBundles = await discoverEndpointBundles(dependencies.discoveryService, {
          providerKey: existing.provider.providerKey,
          apiKey: credentialForSync,
          endpoints: endpointInputs
        });

        const updated = dependencies.repository.replaceProviderWithEndpointBundles({
          providerKey: existing.provider.providerKey,
          provider: buildProviderInput(
            {
              provider_key: existing.provider.providerKey,
              display_name: body.display_name ?? existing.provider.displayName,
              website_url: body.website_url === "" ? null : body.website_url ?? existing.provider.websiteUrl,
              trust_level: existing.provider.trustLevel as "low" | "medium" | "high",
              privacy_level: existing.provider.privacyLevel as "public_only" | "normal" | "private",
              usage_trust: existing.provider.usageTrust as "low" | "medium" | "high",
              enabled: body.enabled ?? existing.provider.enabled
            },
            endpointInputs
          ),
          encryptedApiKey: body.api_key ? dependencies.secretCipher.encrypt(body.api_key) : undefined,
          apiKeyHint: body.api_key ? ManagedProviderRepository.toApiKeyHint(body.api_key) : undefined,
          endpointBundles
        });

        await dependencies.runtimeManager.reload();
        return serializeProviderDetails(updated);
      }

      dependencies.repository.updateProvider(request.params.providerKey, {
        enabled: body.enabled,
        displayName: body.display_name,
        websiteUrl: body.website_url === "" ? null : body.website_url
      });

      if (body.api_key) {
        dependencies.repository.updateCredential(
          request.params.providerKey,
          dependencies.secretCipher.encrypt(body.api_key),
          ManagedProviderRepository.toApiKeyHint(body.api_key)
        );
      }

      const updated = dependencies.repository.getProviderDetails(request.params.providerKey);
      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(updated);
    }
  );

  fastify.post<{ Params: { providerKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey/endpoints",
    async (request, reply) => {
      const body = createEndpointBodySchema.parse(request.body);
      const existing = dependencies.repository.getProviderDetails(request.params.providerKey);
      if (!existing || !existing.credential) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }

      if (dependencies.repository.getProviderEndpoint(request.params.providerKey, body.endpoint_key)) {
        throw new HttpError(409, "endpoint_exists", "Provider endpoint already exists");
      }

      const apiKey = body.api_key ?? dependencies.secretCipher.decrypt(existing.credential.apiKeyEncrypted);
      const discoveredModels = await discoverModelsForEndpoint(dependencies.discoveryService, {
        providerKey: existing.provider.providerKey,
        endpointKey: body.endpoint_key,
        protocol: body.protocol,
        adapterType: body.adapter_type,
        baseUrl: body.base_url,
        apiKey
      });

      const endpoint = dependencies.repository.createProviderEndpoint(request.params.providerKey, {
        endpointKey: body.endpoint_key,
        protocol: body.protocol,
        adapterType: body.adapter_type,
        baseUrl: body.base_url,
        enabled: body.enabled
      });

      if (!endpoint) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }

      const updated = dependencies.repository.syncProviderModels(existing.provider.providerKey, {
        endpointKey: endpoint.endpointKey,
        status: "success",
        models: discoveredModels
      });

      if (body.api_key) {
        dependencies.repository.updateCredential(
          request.params.providerKey,
          dependencies.secretCipher.encrypt(body.api_key),
          ManagedProviderRepository.toApiKeyHint(body.api_key)
        );
      }

      await dependencies.runtimeManager.reload();
      reply.status(201);
      return serializeProviderDetails(updated);
    }
  );

  fastify.patch<{ Params: { providerKey: string; endpointKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey/endpoints/:endpointKey",
    async (request) => {
      const body = patchEndpointBodySchema.parse(request.body);
      const updated = dependencies.repository.updateProviderEndpoint(
        request.params.providerKey,
        request.params.endpointKey,
        {
          protocol: body.protocol,
          adapterType: body.adapter_type,
          baseUrl: body.base_url,
          enabled: body.enabled
        }
      );

      if (!updated) {
        throw new HttpError(404, "endpoint_not_found", "Provider endpoint not found");
      }

      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(updated);
    }
  );

  fastify.post<{ Params: { providerKey: string; endpointKey: string } }>(
    "/admin/api/providers/:providerKey/endpoints/:endpointKey/sync-models",
    async (request) => {
      const details = dependencies.repository.getProviderDetails(request.params.providerKey);
      const endpoint = dependencies.repository.getProviderEndpoint(
        request.params.providerKey,
        request.params.endpointKey
      );
      if (!details || !details.credential || !endpoint) {
        throw new HttpError(404, "endpoint_not_found", "Provider endpoint not found");
      }

      const apiKey = dependencies.secretCipher.decrypt(details.credential.apiKeyEncrypted);
      const discoveredModels = await discoverModelsForEndpoint(dependencies.discoveryService, {
        providerKey: details.provider.providerKey,
        endpointKey: endpoint.endpointKey,
        protocol: endpoint.protocol as "openai" | "anthropic",
        adapterType: endpoint.adapterType as "openai_compatible" | "openrouter" | "anthropic",
        baseUrl: endpoint.baseUrl,
        apiKey
      });

      const updated = dependencies.repository.syncProviderModels(details.provider.providerKey, {
        endpointKey: endpoint.endpointKey,
        status: "success",
        models: discoveredModels
      });

      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(updated);
    }
  );

  fastify.patch<{ Params: { providerKey: string }; Body: unknown }>(
    "/admin/api/providers/:providerKey/models",
    async (request) => {
      const body = patchModelCapabilitiesBodySchema.parse(request.body);
      const updated = dependencies.repository.updateModelCapabilities(request.params.providerKey, {
        modelKey: body.model_key,
        supportsStreaming: body.supports_streaming,
        supportsTools: body.supports_tools,
        supportsJsonMode: body.supports_json_mode
      });

      if (!updated) {
        throw new HttpError(404, "model_not_found", "Provider model not found");
      }

      await dependencies.runtimeManager.reload();
      return serializeProviderDetails(updated);
    }
  );

  fastify.delete<{ Params: { providerKey: string } }>(
    "/admin/api/providers/:providerKey",
    async (request, reply) => {
      const deleted = dependencies.repository.deleteProvider(request.params.providerKey);
      if (!deleted) {
        throw new HttpError(404, "provider_not_found", "Provider not found");
      }

      await dependencies.runtimeManager.reload();
      reply.status(204);
      return null;
    }
  );
}
