import { request } from "undici";

import type { NormalizedChatRequest } from "../routing/types.js";
import { PROVIDER_AUTH_FAILED_CODE } from "../utils/providerErrors.js";
import { HttpError } from "../utils/httpErrors.js";
import { mergeCustomHeaders, pickForwardedRequestHeaders } from "./customHeaders.js";
import type {
  ProviderAdapter,
  ProviderResponse,
  ProviderResponsesRequest,
  ProviderStreamChunk,
  RouteTarget
} from "./adapter.js";

function buildHeaders(target: RouteTarget): Record<string, string> {
  const headers = mergeCustomHeaders(
    mergeCustomHeaders(
      { "content-type": "application/json" },
      pickForwardedRequestHeaders(target.request_headers)
    ),
    target.endpoint.custom_headers
  );

  if (target.credential) {
    headers.authorization = `Bearer ${target.credential}`;
  }

  return headers;
}

function applyUpstreamMetadata(
  payload: Record<string, unknown>,
  upstreamMetadata: unknown
): Record<string, unknown> {
  if (
    upstreamMetadata &&
    typeof upstreamMetadata === "object" &&
    !Array.isArray(upstreamMetadata)
  ) {
    return {
      ...payload,
      metadata: upstreamMetadata
    };
  }

  return payload;
}

function toChatCompletionsPayload(
  requestBody: NormalizedChatRequest,
  target: RouteTarget,
  stream: boolean
): Record<string, unknown> {
  const {
    metadata: _metadata,
    upstream_metadata: upstreamMetadata,
    context_tokens_est: _contextTokensEst,
    ...payloadWithoutInternalFields
  } = requestBody;

  return applyUpstreamMetadata({
    ...payloadWithoutInternalFields,
    model: target.model.model_name,
    stream
  }, upstreamMetadata);
}

function toResponsesPayload(
  requestBody: ProviderResponsesRequest,
  target: RouteTarget,
  stream: boolean
): Record<string, unknown> {
  const {
    metadata: _metadata,
    upstream_metadata: upstreamMetadata,
    ...payloadWithoutInternalFields
  } = requestBody;

  return applyUpstreamMetadata({
    ...payloadWithoutInternalFields,
    model: target.model.model_name,
    stream
  }, upstreamMetadata);
}

/**
 * 解析上游响应用于只读记账；原始文本另行透传，所以解析失败不应中断请求。
 */
export function parseJsonSafely(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  public readonly type = "openai_compatible";

  public async chatCompletion(
    requestBody: NormalizedChatRequest,
    target: RouteTarget
  ): Promise<ProviderResponse> {
    const upstreamPayload = toChatCompletionsPayload(requestBody, target, false);

    let response;
    try {
      response = await request(`${target.endpoint.base_url}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(target),
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

    const raw = await response.body.text();
    const body = parseJsonSafely(raw);

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

    return {
      status: response.statusCode,
      body,
      raw,
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
    const basePayload = toChatCompletionsPayload(requestBody, target, true);

    const sendStream = (includeUsage: boolean) =>
      request(`${target.endpoint.base_url}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(target),
        body: JSON.stringify(
          // 请求上游在流末尾带 usage，否则流式请求记不到 token 数
          includeUsage
            ? { ...basePayload, stream_options: { include_usage: true } }
            : basePayload
        )
      });

    let response;
    try {
      response = await sendStream(true);

      // 部分 OpenAI 兼容中转站不认 stream_options，会直接 400。
      // 这种情况去掉该字段在同一候选上重试一次：宁可丢 usage，
      // 也不能因为记账把原本可用的上游变成失败。
      if (response.statusCode === 400) {
        response.body.destroy();
        response = await sendStream(false);
      }
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
          `Streaming provider request failed with status ${response.statusCode}`,
          false
        );
      }

      throw new HttpError(
        response.statusCode,
        response.statusCode === 429 ? "provider_rate_limited" : "provider_error",
        `Streaming provider request failed with status ${response.statusCode}`,
        response.statusCode >= 500 || response.statusCode === 429 || response.statusCode === 408
      );
    }

    for await (const chunk of response.body) {
      yield {
        raw: Buffer.from(chunk).toString("utf8")
      };
    }
  }

  public async responseCompletion(
    requestBody: ProviderResponsesRequest,
    target: RouteTarget
  ): Promise<ProviderResponse> {
    const upstreamPayload = toResponsesPayload(requestBody, target, false);

    let response;
    try {
      response = await request(`${target.endpoint.base_url}/responses`, {
        method: "POST",
        headers: buildHeaders(target),
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

    const raw = await response.body.text();
    const body = parseJsonSafely(raw);
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
          : `Provider responses request failed with status ${response.statusCode}`;

      if (response.statusCode === 401 || response.statusCode === 403) {
        throw new HttpError(response.statusCode, PROVIDER_AUTH_FAILED_CODE, message, false);
      }

      if (response.statusCode === 429) {
        throw new HttpError(response.statusCode, "provider_rate_limited", message, true);
      }

      if (response.statusCode >= 500 || response.statusCode === 408 || response.statusCode === 404) {
        throw new HttpError(response.statusCode, "provider_error", message, true);
      }

      throw new HttpError(response.statusCode, "request_invalid", message, false);
    }

    return {
      status: response.statusCode,
      body,
      raw,
      usage:
        typeof body === "object" && body !== null && "usage" in body
          ? (body.usage as ProviderResponse["usage"])
          : undefined
    };
  }

  public async *streamResponse(
    requestBody: ProviderResponsesRequest,
    target: RouteTarget
  ): AsyncIterable<ProviderStreamChunk> {
    const upstreamPayload = toResponsesPayload(requestBody, target, true);

    let response;
    try {
      response = await request(`${target.endpoint.base_url}/responses`, {
        method: "POST",
        headers: buildHeaders(target),
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
      if (response.statusCode === 401 || response.statusCode === 403) {
        throw new HttpError(
          response.statusCode,
          PROVIDER_AUTH_FAILED_CODE,
          `Streaming responses request failed with status ${response.statusCode}`,
          false
        );
      }

      throw new HttpError(
        response.statusCode,
        response.statusCode === 429 ? "provider_rate_limited" : "provider_error",
        `Streaming responses request failed with status ${response.statusCode}`,
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
