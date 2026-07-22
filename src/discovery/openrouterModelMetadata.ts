import { request } from "undici";

import { HttpError } from "../utils/httpErrors.js";

export interface OpenRouterModelMetadata {
  id: string;
  name?: string;
  contextLength?: number;
  pricing?: {
    input_per_1m?: number;
    output_per_1m?: number;
    cached_input_per_1m?: number;
    source: "openrouter";
    confidence: "medium" | "high";
  };
  supportsTools?: boolean;
  inputModalities?: string[];
  raw: Record<string, unknown>;
}

function toPerMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  // OpenRouter public pricing is usually USD per token.
  return parsed * 1_000_000;
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function modelBasename(value: string): string {
  const trimmed = value.trim();
  return trimmed.split("/").filter(Boolean).at(-1) ?? trimmed;
}

function canonicalId(value: string): string {
  return normalizeId(modelBasename(value)).replace(/[^a-z0-9]+/g, "");
}

export class OpenRouterModelMetadataService {
  public async listModels(): Promise<OpenRouterModelMetadata[]> {
    let response;
    try {
      response = await request("https://openrouter.ai/api/v1/models", {
        method: "GET",
        headers: {
          accept: "application/json"
        }
      });
    } catch (error) {
      throw new HttpError(
        503,
        "openrouter_unreachable",
        error instanceof Error ? error.message : "openrouter unreachable",
        true
      );
    }

    const body = await response.body.json();
    if (response.statusCode >= 400) {
      throw new HttpError(
        response.statusCode,
        "openrouter_discovery_failed",
        `OpenRouter model metadata fetch failed with status ${response.statusCode}`,
        response.statusCode >= 500 || response.statusCode === 429
      );
    }

    const data =
      typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data)
        ? body.data
        : [];

    const models: OpenRouterModelMetadata[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const raw = item as Record<string, unknown>;
      const id = typeof raw.id === "string" ? raw.id : null;
      if (!id) {
        continue;
      }

      const architecture =
        typeof raw.architecture === "object" && raw.architecture !== null
          ? (raw.architecture as Record<string, unknown>)
          : {};
      const pricingRaw =
        typeof raw.pricing === "object" && raw.pricing !== null
          ? (raw.pricing as Record<string, unknown>)
          : {};
      const supportedParams = Array.isArray(raw.supported_parameters)
        ? raw.supported_parameters.filter((value): value is string => typeof value === "string")
        : [];
      const inputModalities = Array.isArray(architecture.input_modalities)
        ? architecture.input_modalities.filter((value): value is string => typeof value === "string")
        : undefined;

      const input = toPerMillion(pricingRaw.prompt);
      const output = toPerMillion(pricingRaw.completion);
      const cached = toPerMillion(pricingRaw.input_cache_read);

      models.push({
        id,
        name: typeof raw.name === "string" ? raw.name : undefined,
        contextLength:
          typeof raw.context_length === "number"
            ? raw.context_length
            : typeof raw.top_provider === "object" &&
                raw.top_provider !== null &&
                typeof (raw.top_provider as Record<string, unknown>).context_length === "number"
              ? ((raw.top_provider as Record<string, unknown>).context_length as number)
              : undefined,
        pricing:
          input !== undefined || output !== undefined || cached !== undefined
            ? {
                input_per_1m: input,
                output_per_1m: output,
                cached_input_per_1m: cached,
                source: "openrouter",
                confidence: "high"
              }
            : undefined,
        supportsTools:
          supportedParams.includes("tools") || supportedParams.includes("tool_choice")
            ? true
            : supportedParams.length > 0
              ? false
              : undefined,
        inputModalities,
        raw
      });
    }

    return models;
  }

  public matchModel(
    models: OpenRouterModelMetadata[],
    input: { logicalName: string; openrouterSlug?: string | null }
  ): { match: OpenRouterModelMetadata | null; candidates: OpenRouterModelMetadata[] } {
    if (input.openrouterSlug) {
      const exact = models.find(
        (model) => normalizeId(model.id) === normalizeId(input.openrouterSlug!)
      );
      if (exact) {
        return { match: exact, candidates: [exact] };
      }
    }

    const logical = normalizeId(input.logicalName);
    const exactId = models.find((model) => normalizeId(model.id) === logical);
    if (exactId) {
      return { match: exactId, candidates: [exactId] };
    }

    const suffixMatches = models.filter((model) => {
      const id = normalizeId(model.id);
      return id.endsWith(`/${logical}`) || id.endsWith(`:${logical}`);
    });
    if (suffixMatches.length === 1) {
      return { match: suffixMatches[0], candidates: suffixMatches };
    }
    if (suffixMatches.length > 1) {
      return { match: null, candidates: suffixMatches.slice(0, 20) };
    }

    const fuzzy = models.filter((model) => {
      const id = normalizeId(model.id);
      const name = model.name ? normalizeId(model.name) : "";
      return id.includes(logical) || name.includes(logical);
    });
    if (fuzzy.length === 1) {
      return { match: fuzzy[0], candidates: fuzzy };
    }

    const canonicalLogical = canonicalId(input.logicalName);
    const canonicalIdMatches = models.filter((model) => {
      const id = canonicalId(model.id);
      return id === canonicalLogical;
    });
    if (canonicalIdMatches.length === 1) {
      return { match: canonicalIdMatches[0], candidates: canonicalIdMatches };
    }
    if (canonicalIdMatches.length > 1) {
      return { match: null, candidates: canonicalIdMatches.slice(0, 20) };
    }

    const canonicalNameMatches = models.filter((model) => {
      const name = model.name ? canonicalId(model.name) : "";
      return name === canonicalLogical || name.includes(canonicalLogical);
    });
    if (canonicalNameMatches.length === 1) {
      return { match: canonicalNameMatches[0], candidates: canonicalNameMatches };
    }
    if (canonicalNameMatches.length > 1) {
      return { match: null, candidates: canonicalNameMatches.slice(0, 20) };
    }

    return { match: null, candidates: fuzzy.slice(0, 20) };
  }
}
