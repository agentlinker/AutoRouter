import type { PriceEntryConfig, RouterConfig } from "../config/schema.js";

export interface PriceEstimate {
  estimatedUsd: number | null;
  confidence: "low" | "medium" | "high" | "unknown";
}

export class PriceTable {
  public constructor(private readonly config: RouterConfig) {}

  private getPriceEntry(modelId: string): PriceEntryConfig | null {
    return this.config.models[modelId]?.pricing ?? null;
  }

  public estimateCost(
    modelId: string,
    inputTokens?: number,
    outputTokens?: number
  ): PriceEstimate {
    const entry = this.getPriceEntry(modelId);
    if (!entry || (!inputTokens && !outputTokens)) {
      return {
        estimatedUsd: null,
        confidence: "unknown"
      };
    }

    const inputCost =
      inputTokens && entry.input_per_1m
        ? (inputTokens / 1_000_000) * entry.input_per_1m
        : 0;
    const outputCost =
      outputTokens && entry.output_per_1m
        ? (outputTokens / 1_000_000) * entry.output_per_1m
        : 0;

    return {
      estimatedUsd: Number((inputCost + outputCost).toFixed(8)),
      confidence: entry.confidence
    };
  }
}
