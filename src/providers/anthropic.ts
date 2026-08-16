import { request } from "undici";

import type { NormalizedChatRequest } from "../routing/types.js";
import { PROVIDER_AUTH_FAILED_CODE } from "../utils/providerErrors.js";
import { HttpError } from "../utils/httpErrors.js";
import { mergeCustomHeaders } from "./customHeaders.js";
import type {
  HealthResult,
  ProviderAdapter,
  ProviderMessagesRequest,
  ProviderResponse,
  ProviderStreamChunk,
  RouteTarget
} from "./adapter.js";
import { parseJsonSafely } from "./openaiCompatible.js";

function buildHeaders(target: RouteTarget): Record<string, string> {
  const headers = mergeCustomHeaders(
    {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    },
    target.endpoint.custom_headers
  );

  if (target.credential) {
    headers["x-api-key"] = target.credential;
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

/**
 * Anthropic 错误体 → HttpError，分类与 chatCompletion 路径保持一致。
 */
function toAnthropicHttpError(statusCode: number, body: unknown): HttpError {
  const record = (body ?? {}) as Record<string, unknown>;
  const message =
    typeof record.error === "object" && record.error !== null && "message" in record.error
      ? String((record.error as { message?: unknown }).message)
      : `Anthropic request failed with status ${statusCode}`;

  if (statusCode === 401 || statusCode === 403) {
    return new HttpError(statusCode, PROVIDER_AUTH_FAILED_CODE, message, false);
  }
  if (statusCode === 404) {
    return new HttpError(statusCode, "provider_invalid_model", message, true);
  }
  if (statusCode === 408) {
    return new HttpError(statusCode, "provider_timeout", message, true);
  }
  if (statusCode === 429) {
    return new HttpError(statusCode, "provider_rate_limited", message, true);
  }
  if (statusCode >= 500) {
    return new HttpError(statusCode, "provider_server_error", message, true);
  }
  return new HttpError(statusCode, "request_invalid", message, false);
}

/**
 * 只读提取 Anthropic usage 用于记账，不重建响应。
 */
function extractAnthropicUsage(body: unknown): ProviderResponse["usage"] {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;
  const inputTokens =
    typeof record.input_tokens === "number" ? record.input_tokens : undefined;
  const outputTokens =
    typeof record.output_tokens === "number" ? record.output_tokens : undefined;

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens:
      inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined
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
        headers: buildHeaders(target),
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
        headers: buildHeaders(target),
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
        throw new HttpError(response.statusCode, PROVIDER_AUTH_FAILED_CODE, message, false);
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
        headers: buildHeaders(target),
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

  /**
   * 原生 Anthropic Messages 直通：请求体只替换 model，响应按原始字节返回。
   * 零协议转换，因此 thinking blocks、cache_control、tool_use、server_tool_use
   * 等 Anthropic 独有字段全部保真。
   */
  public async messageCompletion(
    requestBody: ProviderMessagesRequest,
    target: RouteTarget
  ): Promise<ProviderResponse> {
    let response;
    try {
      response = await request(`${target.endpoint.base_url}/messages`, {
        method: "POST",
        headers: buildHeaders(target),
        body: JSON.stringify({
          ...requestBody,
          model: target.model.model_name,
          stream: false
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

    const raw = await response.body.text();
    const body = parseJsonSafely(raw);
    if (response.statusCode >= 400) {
      throw toAnthropicHttpError(response.statusCode, body);
    }

    return {
      status: response.statusCode,
      body,
      raw,
      usage: extractAnthropicUsage(body)
    };
  }

  public async *streamMessage(
    requestBody: ProviderMessagesRequest,
    target: RouteTarget
  ): AsyncIterable<ProviderStreamChunk> {
    let response;
    try {
      response = await request(`${target.endpoint.base_url}/messages`, {
        method: "POST",
        headers: buildHeaders(target),
        body: JSON.stringify({
          ...requestBody,
          model: target.model.model_name,
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
      if (response.statusCode === 401 || response.statusCode === 403) {
        throw new HttpError(
          response.statusCode,
          PROVIDER_AUTH_FAILED_CODE,
          `Anthropic streaming request failed with status ${response.statusCode}`,
          false
        );
      }

      throw new HttpError(
        response.statusCode,
        response.statusCode === 429 ? "provider_rate_limited" : "provider_error",
        `Anthropic streaming request failed with status ${response.statusCode}`,
        response.statusCode >= 500 || response.statusCode === 429 || response.statusCode === 408
      );
    }

    for await (const chunk of response.body) {
      yield {
        raw: Buffer.from(chunk).toString("utf8")
      };
    }
  }
}
