import type { AdapterType } from "../config/schema.js";
import { HttpError } from "../utils/httpErrors.js";
import type { ProviderAdapter } from "./adapter.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OllamaAdapter } from "./ollama.js";
import { OpenAiCompatibleAdapter } from "./openaiCompatible.js";
import { OpenRouterAdapter } from "./openrouter.js";

export class AdapterRegistry {
  private readonly adapters: Map<AdapterType, ProviderAdapter>;

  public constructor() {
    this.adapters = new Map<AdapterType, ProviderAdapter>([
      ["openai_compatible", new OpenAiCompatibleAdapter()],
      ["openrouter", new OpenRouterAdapter()],
      ["ollama", new OllamaAdapter()],
      ["anthropic", new AnthropicAdapter()]
    ]);
  }

  public get(type: AdapterType): ProviderAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new HttpError(500, "adapter_not_found", `No adapter for ${type}`);
    }

    return adapter;
  }
}
