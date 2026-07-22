import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { resolveEffectiveModelMetadata } from "../../catalog/effectiveModelMetadata.js";
import { CatalogRepository, type CatalogLogicalModelDetails } from "../../repositories/catalogRepository.js";
import { OpenRouterModelMetadataService } from "../../discovery/openrouterModelMetadata.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import { HttpError } from "../../utils/httpErrors.js";

const nullableBooleanSchema = z.boolean().nullable().optional();
const nullableNumberSchema = z.number().int().positive().nullable().optional();
const nullableStringSchema = z.string().nullable().optional();

const patchLogicalModelBodySchema = z.object({
  display_name: nullableStringSchema,
  openrouter_slug: nullableStringSchema,
  aliases_json: nullableStringSchema,
  context_window: nullableNumberSchema,
  supports_streaming: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_json_mode: z.boolean().optional(),
  input_modalities_json: nullableStringSchema,
  pricing_json: nullableStringSchema,
  notes: nullableStringSchema,
  metadata_source: z.string().min(1).optional(),
  metadata_confidence: z.string().min(1).optional()
}).strict();

const patchInstanceBodySchema = z.object({
  provider_key: z.string().min(1),
  model_key: z.string().min(1),
  enabled: z.boolean().optional(),
  context_window_override: nullableNumberSchema,
  supports_streaming_override: nullableBooleanSchema,
  supports_tools_override: nullableBooleanSchema,
  supports_json_mode_override: nullableBooleanSchema,
  pricing_json_override: nullableStringSchema
}).strict();

function serializeCatalogModel(details: CatalogLogicalModelDetails) {
  return {
    logical_name: details.logical.logicalName,
    display_name: details.logical.displayName,
    openrouter_slug: details.logical.openrouterSlug,
    aliases_json: details.logical.aliasesJson,
    context_window: details.logical.contextWindow,
    supports_streaming: details.logical.supportsStreaming,
    supports_tools: details.logical.supportsTools,
    supports_json_mode: details.logical.supportsJsonMode,
    input_modalities_json: details.logical.inputModalitiesJson,
    pricing_json: details.logical.pricingJson,
    metadata_source: details.logical.metadataSource,
    metadata_confidence: details.logical.metadataConfidence,
    notes: details.logical.notes,
    fetched_at: details.logical.fetchedAt,
    updated_at: details.logical.updatedAt,
    instances: details.instances.map((instance) => {
      const effective = resolveEffectiveModelMetadata(instance.model, details.logical);
      return {
        provider_key: instance.provider.providerKey,
        provider_display_name: instance.provider.displayName,
        endpoint_key: instance.endpoint?.endpointKey ?? "default",
        protocol: instance.endpoint?.protocol ?? null,
        model_key: instance.model.modelKey,
        provider_model_id: instance.model.providerModelId,
        model_name: instance.model.modelName,
        enabled: instance.model.enabled,
        context_window: instance.model.contextWindow,
        supports_streaming: instance.model.supportsStreaming,
        supports_tools: instance.model.supportsTools,
        supports_json_mode: instance.model.supportsJsonMode,
        pricing_json: instance.model.pricingJson,
        context_window_override: instance.model.contextWindowOverride,
        supports_streaming_override: instance.model.supportsStreamingOverride,
        supports_tools_override: instance.model.supportsToolsOverride,
        supports_json_mode_override: instance.model.supportsJsonModeOverride,
        pricing_json_override: instance.model.pricingJsonOverride,
        effective_context_window: effective.contextWindow ?? null,
        effective_supports_streaming: effective.supportsStreaming,
        effective_supports_tools: effective.supportsTools,
        effective_supports_json_mode: effective.supportsJsonMode,
        effective_pricing_json: effective.pricingJson ?? null,
        manual_override_json: instance.model.manualOverrideJson
      };
    })
  };
}

export async function registerAdminCatalogRoutes(
  fastify: FastifyInstance,
  dependencies: {
    runtimeManager: RuntimeManagerLike;
    repository: CatalogRepository;
    openRouterMetadataService?: OpenRouterModelMetadataService;
  }
) {
  const openRouterMetadataService =
    dependencies.openRouterMetadataService ?? new OpenRouterModelMetadataService();

  fastify.get("/admin/api/catalog/models", async () => ({
    data: dependencies.repository.listLogicalModels().map((item) => serializeCatalogModel(item))
  }));

  fastify.get<{ Params: { logicalName: string } }>(
    "/admin/api/catalog/models/:logicalName",
    async (request) => {
      const details = dependencies.repository.getLogicalModel(
        decodeURIComponent(request.params.logicalName)
      );
      if (!details) {
        throw new HttpError(404, "logical_model_not_found", "Logical model not found");
      }

      return serializeCatalogModel(details);
    }
  );

  fastify.patch<{ Params: { logicalName: string }; Body: unknown }>(
    "/admin/api/catalog/models/:logicalName",
    async (request) => {
      const body = patchLogicalModelBodySchema.parse(request.body);
      const updated = dependencies.repository.updateLogicalModel(
        decodeURIComponent(request.params.logicalName),
        {
          displayName: body.display_name,
          openrouterSlug: body.openrouter_slug,
          aliasesJson: body.aliases_json,
          contextWindow: body.context_window,
          supportsStreaming: body.supports_streaming,
          supportsTools: body.supports_tools,
          supportsJsonMode: body.supports_json_mode,
          inputModalitiesJson: body.input_modalities_json,
          pricingJson: body.pricing_json,
          notes: body.notes,
          metadataSource: body.metadata_source,
          metadataConfidence: body.metadata_confidence
        }
      );
      if (!updated) {
        throw new HttpError(404, "logical_model_not_found", "Logical model not found");
      }

      await dependencies.runtimeManager.reload();
      return serializeCatalogModel(updated);
    }
  );

  fastify.patch<{ Params: { logicalName: string }; Body: unknown }>(
    "/admin/api/catalog/models/:logicalName/instances",
    async (request) => {
      const body = patchInstanceBodySchema.parse(request.body);
      const updated = dependencies.repository.updateManagedModelOverrides(
        body.provider_key,
        body.model_key,
        {
          enabled: body.enabled,
          contextWindowOverride: body.context_window_override,
          supportsStreamingOverride: body.supports_streaming_override,
          supportsToolsOverride: body.supports_tools_override,
          supportsJsonModeOverride: body.supports_json_mode_override,
          pricingJsonOverride: body.pricing_json_override
        }
      );
      if (!updated || updated.logical.logicalName !== decodeURIComponent(request.params.logicalName)) {
        throw new HttpError(404, "model_instance_not_found", "Catalog model instance not found");
      }

      await dependencies.runtimeManager.reload();
      return serializeCatalogModel(updated);
    }
  );

  fastify.post<{ Params: { logicalName: string } }>(
    "/admin/api/catalog/models/:logicalName/enrich/openrouter",
    async (request) => {
      const logicalName = decodeURIComponent(request.params.logicalName);
      const details = dependencies.repository.getLogicalModel(logicalName);
      if (!details) {
        throw new HttpError(404, "logical_model_not_found", "Logical model not found");
      }

      const models = await openRouterMetadataService.listModels();
      const result = openRouterMetadataService.matchModel(models, {
        logicalName: details.logical.logicalName,
        openrouterSlug: details.logical.openrouterSlug
      });
      if (!result.match) {
        throw new HttpError(404, "openrouter_model_not_found", "No unique OpenRouter metadata match found", false, {
          candidates: result.candidates.map((candidate) => ({
            id: candidate.id,
            name: candidate.name
          }))
        });
      }

      const updated = dependencies.repository.enrichLogicalModelFromOpenRouter(logicalName, result.match);
      if (!updated) {
        throw new HttpError(404, "logical_model_not_found", "Logical model not found");
      }

      await dependencies.runtimeManager.reload();
      return serializeCatalogModel(updated);
    }
  );
}
