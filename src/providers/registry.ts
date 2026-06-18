import type { ProtocolType } from "../config/schema.js";
import { HttpError } from "../utils/httpErrors.js";
import type { ProviderAdapter } from "./adapter.js";
import { OllamaAdapter } from "./ollama.js";
import { OpenAiCompatibleAdapter } from "./openaiCompatible.js";
import { OpenRouterAdapter } from "./openrouter.js";

export class AdapterRegistry {
  private readonly adapters: Map<ProtocolType, ProviderAdapter>;

  public constructor() {
    this.adapters = new Map<ProtocolType, ProviderAdapter>([
      ["openai_compatible", new OpenAiCompatibleAdapter()],
      ["openrouter", new OpenRouterAdapter()],
      ["ollama", new OllamaAdapter()]
    ]);
  }

  public get(type: ProtocolType): ProviderAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new HttpError(500, "adapter_not_found", `No adapter for ${type}`);
    }

    return adapter;
  }
}
