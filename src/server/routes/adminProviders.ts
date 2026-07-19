import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ProviderModelDiscoveryService } from "../../discovery/providerModelDiscovery.js";
import { ManagedProviderRepository } from "../../repositories/managedProviderRepository.js";
import { SecretCipher } from "../../security/secretCipher.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import { HttpError } from "../../utils/httpErrors.js";

const createProviderBodySchema = z.object({
  provider_key: z.string().min(1),
  display_name: z.string().min(1),
  base_url: z.string().url(),
  website_url: z.string().url().optional().or(z.literal("")),
  api_key: z.string().min(1),
  trust_level: z.enum(["low", "medium", "high"]).default("low"),
  privacy_level: z.enum(["public_only", "normal", "private"]).default("normal"),
  usage_trust: z.enum(["low", "medium", "high"]).default("low")
}).strict();

const patchProviderBodySchema = z.object({
  enabled: z.boolean().optional(),
  display_name: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  website_url: z.string().url().optional().or(z.literal("")),
  api_key: z.string().min(1).optional()
}).strict();

const patchModelCapabilitiesBodySchema = z.object({
  model_key: z.string().min(1),
  supports_streaming: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_json_mode: z.boolean().optional()
}).strict();

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
      supports_json_mode: model.supportsJsonMode
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

    const discoveredModels = await dependencies.discoveryService.listOpenAiCompatibleModels({
      providerKey: body.provider_key,
      baseUrl: body.base_url,
      apiKey: body.api_key
    });

    const details = dependencies.repository.createProviderWithModels({
      provider: {
        providerKey: body.provider_key,
        displayName: body.display_name,
        adapterType: "openai_compatible",
        baseUrl: body.base_url,
        websiteUrl: body.website_url || null,
        trustLevel: body.trust_level,
        privacyLevel: body.privacy_level,
        usageTrust: body.usage_trust
      },
      encryptedApiKey: dependencies.secretCipher.encrypt(body.api_key),
      apiKeyHint: ManagedProviderRepository.toApiKeyHint(body.api_key),
      models: discoveredModels
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
      const discoveredModels = await dependencies.discoveryService.listOpenAiCompatibleModels({
        providerKey: details.provider.providerKey,
        baseUrl: details.provider.baseUrl,
        apiKey
      });

      const updated = dependencies.repository.syncProviderModels(details.provider.providerKey, {
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

      const baseUrlChanged =
        body.base_url !== undefined && body.base_url !== existing.provider.baseUrl;
      const credentialForSync = body.api_key
        ? body.api_key
        : existing.credential
          ? dependencies.secretCipher.decrypt(existing.credential.apiKeyEncrypted)
          : null;

      if (baseUrlChanged) {
        if (!credentialForSync) {
          throw new HttpError(
            400,
            "credential_required",
            "API key is required when changing Base URL"
          );
        }

        const discoveredModels = await dependencies.discoveryService.listOpenAiCompatibleModels({
          providerKey: existing.provider.providerKey,
          baseUrl: body.base_url!,
          apiKey: credentialForSync
        });

        dependencies.repository.updateProvider(request.params.providerKey, {
          enabled: body.enabled,
          displayName: body.display_name,
          baseUrl: body.base_url,
          websiteUrl: body.website_url === "" ? null : body.website_url
        });

        if (body.api_key) {
          dependencies.repository.updateCredential(
            request.params.providerKey,
            dependencies.secretCipher.encrypt(body.api_key),
            ManagedProviderRepository.toApiKeyHint(body.api_key)
          );
        }

        const updated = dependencies.repository.syncProviderModels(existing.provider.providerKey, {
          status: "success",
          models: discoveredModels
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
