import type { ProviderAdapter } from "./adapter.js";
import { OpenAiCompatibleAdapter } from "./openaiCompatible.js";

export class OllamaAdapter implements ProviderAdapter {
  public readonly type = "ollama" as const;
  private readonly delegate = new OpenAiCompatibleAdapter();

  public async healthCheck(...args: Parameters<OpenAiCompatibleAdapter["healthCheck"]>) {
    return this.delegate.healthCheck(...args);
  }

  public async chatCompletion(
    ...args: Parameters<OpenAiCompatibleAdapter["chatCompletion"]>
  ) {
    return this.delegate.chatCompletion(...args);
  }
}
