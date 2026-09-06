import { wireProtocolSchema, type WireProtocol } from "../config/schema.js";
import type { ProtocolAdapters, ProviderAdapter } from "./adapter.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAiChatCompletionsAdapter, OpenAiResponsesAdapter } from "./openaiCompatible.js";

export class AdapterRegistry {
  private readonly adapters: ProtocolAdapters = {
    "openai-responses": new OpenAiResponsesAdapter(),
    "openai-chat-completions": new OpenAiChatCompletionsAdapter(),
    "anthropic-messages": new AnthropicAdapter()
  };

  public forProtocol<P extends WireProtocol>(protocol: P): ProtocolAdapters[P];
  public forProtocol(protocol: string): ProviderAdapter;
  public forProtocol(protocol: string): ProviderAdapter {
    return this.adapters[wireProtocolSchema.parse(protocol)];
  }
}
