import type { AdapterType } from "../config/schema.js";
import { HttpError } from "../utils/httpErrors.js";
import type { ProviderAdapter } from "./adapter.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAiCompatibleAdapter } from "./openaiCompatible.js";

/**
 * protocol → 内部 adapter 实现。adapter 不是用户可配置字段：
 * 用户只选 protocol，实现由这里唯一决定。
 * 上游的 header 差异（如 OpenRouter 的 X-Title）用 endpoint 的
 * custom_headers 表达，不需要单独的 adapter。
 */
export function adapterTypeForProtocol(protocol: string): AdapterType {
  return protocol === "anthropic" ? "anthropic" : "openai_compatible";
}

export class AdapterRegistry {
  private readonly adapters: Map<AdapterType, ProviderAdapter>;

  public constructor() {
    this.adapters = new Map<AdapterType, ProviderAdapter>([
      ["openai_compatible", new OpenAiCompatibleAdapter()],
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

  /** 按 endpoint 的 protocol 取 adapter */
  public forProtocol(protocol: string): ProviderAdapter {
    return this.get(adapterTypeForProtocol(protocol));
  }
}
