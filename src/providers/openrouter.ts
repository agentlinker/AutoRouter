import { request } from "undici";

import type {
  HealthResult,
  ProviderAdapter,
  ProviderResponse,
  ProviderStreamChunk,
  RouteTarget
} from "./adapter.js";
import { OpenAiCompatibleAdapter } from "./openaiCompatible.js";
import type { NormalizedChatRequest } from "../routing/types.js";
import { HttpError } from "../utils/httpErrors.js";

export class OpenRouterAdapter implements ProviderAdapter {
  public readonly type = "openrouter" as const;
  private readonly delegate = new OpenAiCompatibleAdapter();

  public async healthCheck(
    ...args: Parameters<OpenAiCompatibleAdapter["healthCheck"]>
  ): Promise<HealthResult> {
    return this.delegate.healthCheck(...args);
  }

  public async chatCompletion(
    requestBody: NormalizedChatRequest,
    target: RouteTarget
  ): Promise<ProviderResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-title": "autorouter",
      "http-referer": "https://autorouter.local"
    };

    if (target.credential) {
      headers.authorization = `Bearer ${target.credential}`;
    }

    let response;
    try {
      response = await request(`${target.endpoint.base_url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...requestBody,
          model: target.model.model_name
        })
      });
    } catch (error) {
      throw new HttpError(
        503,
        "provider_unreachable",
        error instanceof Error ? error.message : "provider unreachable",
        true
      );
    }

    const body = await response.body.json();
    if (response.statusCode >= 400) {
      throw new HttpError(
        response.statusCode,
        response.statusCode === 429 ? "provider_rate_limited" : "provider_error",
        `OpenRouter request failed with status ${response.statusCode}`,
        response.statusCode >= 500 || response.statusCode === 429
      );
    }

    return {
      status: response.statusCode,
      body,
      usage:
        typeof body === "object" && body !== null && "usage" in body
          ? (body.usage as ProviderResponse["usage"])
          : undefined
    };
  }

  public async *streamChatCompletion(
    requestBody: NormalizedChatRequest,
    target: RouteTarget
  ): AsyncIterable<ProviderStreamChunk> {
    for await (const chunk of this.delegate.streamChatCompletion!(requestBody, target)) {
      yield chunk;
    }
  }
}
