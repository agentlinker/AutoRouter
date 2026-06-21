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
    "content-type": "application/json",
    "anthropic-version": "2023-06-01"
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  return headers;
}

function toAnthropicRequest(requestBody: NormalizedChatRequest, target: RouteTarget) {
  return {
    model: target.model.model_name,
    messages: requestBody.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content)
      })),
    system: requestBody.messages
      .filter((message) => message.role === "system")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content)
      )
      .join("\n"),
    stream: requestBody.stream,
    max_tokens: requestBody.max_tokens ?? 1024,
    temperature: requestBody.temperature
  };
}

function toOpenAiLikeResponse(body: Record<string, unknown>, modelName: string) {
  const text =
    Array.isArray(body.content) && body.content.length > 0
      ? (body.content[0] as { text?: string }).text ?? ""
      : "";

  return {
    id: body.id ?? "msg_anthropic",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text
        },
        finish_reason: body.stop_reason ?? "stop"
      }
    ],
    usage: {
      prompt_tokens:
        typeof body.usage === "object" &&
        body.usage !== null &&
        "input_tokens" in body.usage
          ? Number(body.usage.input_tokens)
          : undefined,
      completion_tokens:
        typeof body.usage === "object" &&
        body.usage !== null &&
        "output_tokens" in body.usage
          ? Number(body.usage.output_tokens)
          : undefined,
      total_tokens:
        typeof body.usage === "object" &&
        body.usage !== null &&
        "input_tokens" in body.usage &&
        "output_tokens" in body.usage
          ? Number(body.usage.input_tokens) + Number(body.usage.output_tokens)
          : undefined
    }
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  public readonly type = "anthropic";

  public async healthCheck(target: RouteTarget): Promise<HealthResult> {
    try {
      const response = await request(`${target.endpoint.base_url}/messages`, {
        method: "POST",
        headers: buildHeaders(target.credential),
        body: JSON.stringify({
          model: target.model.model_name,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }]
        })
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
    let response;
    try {
      response = await request(`${target.endpoint.base_url}/messages`, {
        method: "POST",
        headers: buildHeaders(target.credential),
        body: JSON.stringify(toAnthropicRequest(requestBody, target))
      });
    } catch (error) {
      throw new HttpError(
        503,
        "provider_unreachable",
        error instanceof Error ? error.message : "provider unreachable",
        true
      );
    }

    const body = (await response.body.json()) as Record<string, unknown>;
    if (response.statusCode >= 400) {
      const message =
        typeof body.error === "object" &&
        body.error !== null &&
        "message" in body.error
          ? String(body.error.message)
          : `Anthropic request failed with status ${response.statusCode}`;

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

    const translated = toOpenAiLikeResponse(body, target.model.model_name);

    return {
      status: response.statusCode,
      body: translated,
      usage: translated.usage
    };
  }

  public async *streamChatCompletion(
    requestBody: NormalizedChatRequest,
    target: RouteTarget
  ): AsyncIterable<ProviderStreamChunk> {
    let response;
    try {
      response = await request(`${target.endpoint.base_url}/messages`, {
        method: "POST",
        headers: buildHeaders(target.credential),
        body: JSON.stringify({
          ...toAnthropicRequest(requestBody, target),
          stream: true
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

    if (response.statusCode >= 400) {
      throw new HttpError(
        response.statusCode,
        "provider_error",
        `Anthropic streaming request failed with status ${response.statusCode}`,
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
