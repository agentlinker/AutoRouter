import { request } from "undici";

import type { NormalizedChatRequest } from "../routing/types.js";
import { HttpError } from "../utils/httpErrors.js";
import type {
  HealthResult,
  ProviderAdapter,
  ProviderResponse,
  ProviderStreamChunk,
  RouteTarget
} from "./adapter.js";

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  public readonly type = "openai_compatible";

  public async healthCheck(target: RouteTarget): Promise<HealthResult> {
    try {
      const response = await request(`${target.endpointConfig.base_url}/models`, {
        method: "GET",
        headers: buildHeaders(target.apiKey)
      });

      if (response.statusCode >= 200 && response.statusCode < 400) {
        return { status: "healthy" };
      }

      return { status: "degraded", detail: `status:${response.statusCode}` };
    } catch (error) {
      return {
        status: "down",
        detail: error instanceof Error ? error.message : "health_check_failed"
      };
    }
  }

  public async chatCompletion(
    requestBody: NormalizedChatRequest,
    target: RouteTarget
  ): Promise<ProviderResponse> {
    const upstreamPayload = {
      ...requestBody,
      model: target.model
    };

    let response;
    try {
      response = await request(`${target.endpointConfig.base_url}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(target.apiKey),
        body: JSON.stringify(upstreamPayload)
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
      const message =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "object" &&
        body.error !== null &&
        "message" in body.error &&
        typeof body.error.message === "string"
          ? body.error.message
          : `Provider request failed with status ${response.statusCode}`;

      if (response.statusCode === 401 || response.statusCode === 403) {
        throw new HttpError(response.statusCode, "provider_auth_failed", message, false);
      }

      if (response.statusCode === 404) {
        throw new HttpError(response.statusCode, "provider_invalid_model", message, true);
      }

      if (response.statusCode === 408) {
        throw new HttpError(response.statusCode, "provider_timeout", message, true);
      }

      if (response.statusCode === 429) {
        throw new HttpError(response.statusCode, "provider_rate_limited", message, true);
      }

      if (response.statusCode >= 500) {
        throw new HttpError(response.statusCode, "provider_server_error", message, true);
      }

      throw new HttpError(response.statusCode, "request_invalid", message, false);
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
    const upstreamPayload = {
      ...requestBody,
      model: target.model,
      stream: true
    };

    let response;
    try {
      response = await request(`${target.endpointConfig.base_url}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(target.apiKey),
        body: JSON.stringify(upstreamPayload)
      });
    } catch (error) {
      throw new HttpError(
        503,
        "provider_unreachable",
        error instanceof Error ? error.message : "provider unreachable",
        true
      );
    }

    if (response.statusCode >= 400) {
      throw new HttpError(
        response.statusCode,
        "provider_error",
        `Streaming provider request failed with status ${response.statusCode}`,
        response.statusCode >= 500 || response.statusCode === 429
      );
    }

    for await (const chunk of response.body) {
      yield {
        raw: Buffer.from(chunk).toString("utf8")
      };
    }
  }
}
