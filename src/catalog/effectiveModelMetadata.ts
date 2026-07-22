import type { LogicalModelRow, ManagedModelRow } from "../db/schema.js";

export interface EffectiveModelMetadata {
  contextWindow?: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  pricingJson?: string | null;
}

function pickBoolean(
  override: boolean | null | undefined,
  managed: boolean,
  logical: boolean | undefined
): boolean {
  if (override !== null && override !== undefined) {
    return override;
  }
  // Prefer provider discovery when true; otherwise fill gaps from logical reference.
  if (managed) {
    return true;
  }
  return logical ?? managed;
}

export function resolveEffectiveModelMetadata(
  model: ManagedModelRow,
  logical: LogicalModelRow | null | undefined
): EffectiveModelMetadata {
  const contextWindow =
    model.contextWindowOverride ?? model.contextWindow ?? logical?.contextWindow ?? undefined;

  return {
    contextWindow: contextWindow ?? undefined,
    supportsStreaming: pickBoolean(
      model.supportsStreamingOverride,
      model.supportsStreaming,
      logical?.supportsStreaming
    ),
    supportsTools: pickBoolean(
      model.supportsToolsOverride,
      model.supportsTools,
      logical?.supportsTools
    ),
    supportsJsonMode: pickBoolean(
      model.supportsJsonModeOverride,
      model.supportsJsonMode,
      logical?.supportsJsonMode
    ),
    pricingJson:
      model.pricingJsonOverride ?? model.pricingJson ?? logical?.pricingJson ?? null
  };
}
