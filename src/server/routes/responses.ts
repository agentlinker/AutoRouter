import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";

import { selectRoute } from "../../routing/routeEngine.js";
import { sha256 } from "../../utils/hash.js";
import type { ChatCompletionsRequestBody, ChatMessage, ToolDefinition } from "../../routing/types.js";
import { HttpError } from "../../utils/httpErrors.js";
import { PROVIDER_AUTH_FAILED_CODE, PROVIDER_AUTH_FAILED_MESSAGE } from "../../utils/providerErrors.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";

interface ResponsesRequestBody {
  model?: string;
  input?: unknown;
  instructions?: string;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_output_tokens?: number;
  metadata?: Record<string, unknown>;
}

interface ChatCompletionResponseBody {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: unknown;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

type ResponsesOutputItem =
  | {
      id: string;
      type: "message";
      status: "completed";
      role: "assistant";
      content: Array<{
        type: "output_text";
        text: string;
        annotations: unknown[];
      }>;
    }
  | {
      id: string;
      type: "function_call";
      status: "completed";
      call_id: string;
      name: string;
      arguments: string;
    };

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          const text = record.text ?? record.input_text ?? record.output_text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    const text = record.text ?? record.input_text ?? record.output_text;
    if (typeof text === "string") {
      return text;
    }
  }

  return content == null ? "" : JSON.stringify(content);
}

function responsesInputToMessages(input: unknown, instructions?: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  if (!Array.isArray(input)) {
    throw new HttpError(400, "invalid_request", "input is required");
  }

  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const role = typeof record.role === "string" ? record.role : undefined;

    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        content: contentToText(record.output),
        tool_call_id: record.call_id
      });
      continue;
    }

    if (type === "function_call") {
      const callId = typeof record.call_id === "string"
        ? record.call_id
        : typeof record.id === "string"
          ? record.id
          : undefined;
      const name = typeof record.name === "string" ? record.name : undefined;
      if (!callId || !name) {
        continue;
      }

      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: {
              name,
              arguments: typeof record.arguments === "string" ? record.arguments : "{}"
            }
          }
        ]
      });
      continue;
    }

    if (type === "message" || role) {
      const messageRole =
        role === "assistant" || role === "system" || role === "tool" ? role : "user";
      messages.push({
        role: messageRole,
        content: contentToText(record.content)
      } as ChatMessage);
    }
  }

  if (messages.length === 0 || messages.every((message) => message.role === "system")) {
    throw new HttpError(400, "invalid_request", "input must contain at least one message");
  }

  return messages;
}

function responsesToolsToChatTools(tools: unknown[] | undefined): ToolDefinition[] {
  if (!tools) {
    return [];
  }

  return tools
    .map((tool): ToolDefinition | null => {
      if (!tool || typeof tool !== "object") {
        return null;
      }

      const record = tool as Record<string, unknown>;
      if (record.type !== "function" || typeof record.name !== "string") {
        return null;
      }

      return {
        type: "function",
        function: {
          name: record.name,
          description: typeof record.description === "string" ? record.description : undefined,
          parameters:
            record.parameters && typeof record.parameters === "object"
              ? (record.parameters as Record<string, unknown>)
              : undefined
        }
      };
    })
    .filter((tool): tool is ToolDefinition => tool !== null);
}

function chatToResponsesBody(chatBody: ChatCompletionResponseBody, requestedModel: string) {
  const responseId = `resp_${randomUUID()}`;
  const message = chatBody.choices?.[0]?.message;
  const output: ResponsesOutputItem[] = [];
  const text = contentToText(message?.content);

  if (text) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text,
          annotations: []
        }
      ]
    });
  }

  for (const toolCall of message?.tool_calls ?? []) {
    if (toolCall.function?.name) {
      output.push({
        id: toolCall.id ?? `fc_${randomUUID()}`,
        type: "function_call",
        status: "completed",
        call_id: toolCall.id ?? `call_${randomUUID()}`,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments ?? "{}"
      });
    }
  }

  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: chatBody.model ?? requestedModel,
    output,
    output_text: text,
    usage: chatBody.usage
      ? {
          input_tokens: chatBody.usage.prompt_tokens,
          output_tokens: chatBody.usage.completion_tokens,
          total_tokens: chatBody.usage.total_tokens
        }
      : undefined
  };
}

function writeSse(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function wrapResponseEvent(
  type: "response.created" | "response.in_progress" | "response.completed",
  response: ReturnType<typeof chatToResponsesBody>,
  sequenceNumber: number
) {
  return {
    type,
    response,
    sequence_number: sequenceNumber
  };
}

function estimateResponsesContextTokens(body: ResponsesRequestBody): number {
  return JSON.stringify({
    input: body.input,
    instructions: body.instructions
  }).length;
}

function responsesUsageToChatUsage(usage: unknown): {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
} | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;
  const promptTokens = record.prompt_tokens ?? record.input_tokens;
  const completionTokens = record.completion_tokens ?? record.output_tokens;
  const totalTokens = record.total_tokens;

  return {
    prompt_tokens: typeof promptTokens === "number" ? promptTokens : undefined,
    completion_tokens: typeof completionTokens === "number" ? completionTokens : undefined,
    total_tokens: typeof totalTokens === "number" ? totalTokens : undefined
  };
}

async function fallbackResponsesViaChat(
  fastify: FastifyInstance,
  request: { body: ResponsesRequestBody; headers: { authorization?: string } },
  reply: FastifyReply
) {
  const chatPayload: ChatCompletionsRequestBody = {
    model: request.body.model!,
    messages: responsesInputToMessages(request.body.input, request.body.instructions),
    stream: false,
    tools: responsesToolsToChatTools(request.body.tools),
    tool_choice: request.body.tool_choice,
    temperature: request.body.temperature,
    max_tokens: request.body.max_output_tokens,
    metadata: request.body.metadata
  };

  const chatResponse = await fastify.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      authorization: request.headers.authorization ?? ""
    },
    payload: chatPayload
  });

  reply.status(chatResponse.statusCode);
  for (const [key, value] of Object.entries(chatResponse.headers)) {
    if (key.startsWith("x-autorouter-") && value !== undefined) {
      reply.header(key, value);
    }
  }

  if (chatResponse.statusCode >= 400) {
    return JSON.parse(chatResponse.body);
  }

  const responseBody = chatToResponsesBody(
    JSON.parse(chatResponse.body) as ChatCompletionResponseBody,
    request.body.model!
  );

  if (request.body.stream) {
    reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("connection", "keep-alive");

    let sequenceNumber = 1;
    const inProgressResponse = { ...responseBody, status: "in_progress", output: [] };
    writeSse(
      reply,
      "response.created",
      wrapResponseEvent("response.created", inProgressResponse, sequenceNumber++)
    );
    writeSse(
      reply,
      "response.in_progress",
      wrapResponseEvent("response.in_progress", inProgressResponse, sequenceNumber++)
    );
    for (const item of responseBody.output) {
      writeSse(reply, "response.output_item.added", {
        type: "response.output_item.added",
        item,
        output_index: 0,
        sequence_number: sequenceNumber++
      });
      if (item.type === "message") {
        const content = item.content[0];
        const contentText = content?.text ?? "";
        writeSse(reply, "response.content_part.added", {
          type: "response.content_part.added",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
          sequence_number: sequenceNumber++
        });
        writeSse(reply, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: contentText,
          sequence_number: sequenceNumber++
        });
        writeSse(reply, "response.output_text.done", {
          type: "response.output_text.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: contentText,
          sequence_number: sequenceNumber++
        });
        writeSse(reply, "response.content_part.done", {
          type: "response.content_part.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: content ?? { type: "output_text", text: "", annotations: [] },
          sequence_number: sequenceNumber++
        });
      }
      writeSse(reply, "response.output_item.done", {
        type: "response.output_item.done",
        item,
        output_index: 0,
        sequence_number: sequenceNumber++
      });
    }
    writeSse(
      reply,
      "response.completed",
      wrapResponseEvent("response.completed", { ...responseBody, status: "completed" }, sequenceNumber++)
    );
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return reply;
  }

  return responseBody;
}

export async function registerResponsesRoute(
  fastify: FastifyInstance,
  runtimeManager: RuntimeManagerLike
) {
  fastify.post<{ Body: ResponsesRequestBody }>("/v1/responses", async (request, reply) => {
    if (!request.body.model) {
      throw new HttpError(400, "invalid_request", "model is required");
    }

    const state = runtimeManager.getSnapshot();
    const privacyLevel =
      typeof request.body.metadata?.privacy_level === "string"
        ? request.body.metadata.privacy_level
        : state.config.defaults.privacy_level;
    const routeDecision = selectRoute(
      state.config,
      state.modelCatalog,
      state.priceTable,
      state.platforms,
      state.providers,
      state.endpoints,
      state.accounts,
      request.body.model,
      Array.isArray(request.body.tools) && request.body.tools.length > 0,
      false,
      estimateResponsesContextTokens(request.body),
      privacyLevel,
      null
    );

    const traceId = randomUUID();
    const startedAt = Date.now();
    const promptHash = sha256(JSON.stringify(request.body.input ?? null));
    const orderedCandidates = routeDecision.candidates
      .map((candidate) => {
        const provider = state.providers.find((item) => item.id === candidate.provider);
        const endpoint = state.endpoints.find((item) => item.id === candidate.endpoint);
        const platform = state.platforms.find((item) => item.id === candidate.platform);
        const account = state.accounts.find((item) => item.id === candidate.account);
        const model = state.modelCatalog.resolveModel(candidate.modelId);

        return {
          routeId: candidate.routeId,
          provider,
          endpoint,
          platform,
          account,
          modelId: candidate.modelId,
          model,
          modelName: candidate.model,
          score: candidate.score ?? 0,
          sticky: candidate.sticky ?? false
        };
      })
      .filter(
        (
          candidate
        ): candidate is {
          routeId: string;
          provider: NonNullable<(typeof candidate)["provider"]>;
          endpoint: NonNullable<(typeof candidate)["endpoint"]>;
          platform: NonNullable<(typeof candidate)["platform"]>;
          account: NonNullable<(typeof candidate)["account"]>;
          modelId: string;
          model: NonNullable<(typeof candidate)["model"]>;
          modelName: string;
          score: number;
          sticky: boolean;
        } =>
          Boolean(
            candidate.provider &&
              candidate.endpoint &&
              candidate.platform &&
              candidate.account &&
              candidate.model
          )
      )
      .sort((left, right) => right.score - left.score);

    const attempts: Array<{
      route_id: string;
      endpoint: string;
      platform: string;
      provider: string;
      account: string;
      model_id: string;
      model: string;
      status: "success" | "failed";
      error?: string;
      retryable?: boolean;
      score?: number;
      sticky?: boolean;
    }> = [];
    const fallbacks: Array<{
      route_id: string;
      endpoint: string;
      platform: string;
      provider: string;
      account: string;
      model_id: string;
      model: string;
      score?: number;
      sticky?: boolean;
    }> = [];

    let providerResponse;
    let selectedCandidate = orderedCandidates[0];
    let lastError: unknown;
    let sawNativeResponsesAdapter = false;

    for (const [index, candidate] of orderedCandidates.entries()) {
      const accountConfig = state.config.accounts[candidate.account.id];
      if (!accountConfig) {
        lastError = new HttpError(500, "account_not_found", "Configured account missing");
        continue;
      }

      const adapter = state.adapters.get(candidate.endpoint.adapter as never);
      const nativeMethod = request.body.stream ? adapter.streamResponse : adapter.responseCompletion;
      if (!nativeMethod) {
        continue;
      }
      sawNativeResponsesAdapter = true;

      const credential = state.credentialStore.resolve(candidate.account.id, accountConfig);
      const target = {
        platform: candidate.platform,
        provider: candidate.provider,
        endpoint: candidate.endpoint,
        account: candidate.account,
        modelId: candidate.modelId,
        model: candidate.model,
        credential
      };

      try {
        if (request.body.stream) {
          reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
          reply.raw.setHeader("cache-control", "no-cache");
          reply.raw.setHeader("connection", "keep-alive");
          reply.raw.setHeader("x-autorouter-trace-id", traceId);
          reply.raw.setHeader("x-autorouter-normalized-model", routeDecision.normalizedModel);

          for await (const chunk of adapter.streamResponse!({
            ...(request.body as Record<string, unknown>),
            model: request.body.model,
            stream: true
          }, target)) {
            reply.raw.write(chunk.raw);
          }
          reply.raw.end();
          providerResponse = { status: 200, body: null, usage: undefined };
        } else {
          providerResponse = await adapter.responseCompletion!({
            ...(request.body as Record<string, unknown>),
            model: request.body.model,
            stream: false
          }, target);
        }

        attempts.push({
          route_id: candidate.routeId,
          endpoint: candidate.endpoint.id,
          platform: candidate.platform.id,
          provider: candidate.provider.id,
          account: candidate.account.id,
          model_id: candidate.modelId,
          model: candidate.modelName,
          status: "success",
          score: candidate.score,
          sticky: candidate.sticky
        });
        selectedCandidate = candidate;
        break;
      } catch (error) {
        lastError = error;
        candidate.endpoint.recent_error_count += 1;
        candidate.account.recent_error_count += 1;
        const retryable = error instanceof HttpError && error.retryable;

        attempts.push({
          route_id: candidate.routeId,
          endpoint: candidate.endpoint.id,
          platform: candidate.platform.id,
          provider: candidate.provider.id,
          account: candidate.account.id,
          model_id: candidate.modelId,
          model: candidate.modelName,
          status: "failed",
          error: error instanceof Error ? error.message : "provider_responses_failed",
          retryable,
          score: candidate.score,
          sticky: candidate.sticky
        });

        if (error instanceof HttpError && error.code === PROVIDER_AUTH_FAILED_CODE) {
          candidate.account.available = false;
          candidate.account.disabled_reason = PROVIDER_AUTH_FAILED_CODE;
          candidate.account.disabled_message = error.message || PROVIDER_AUTH_FAILED_MESSAGE;
        }

        if (!retryable) {
          break;
        }

        if (index < orderedCandidates.length - 1) {
          fallbacks.push({
            route_id: candidate.routeId,
            endpoint: candidate.endpoint.id,
            platform: candidate.platform.id,
            provider: candidate.provider.id,
            account: candidate.account.id,
            model_id: candidate.modelId,
            model: candidate.modelName,
            score: candidate.score,
            sticky: candidate.sticky
          });
        }
      }
    }

    if (!sawNativeResponsesAdapter) {
      return fallbackResponsesViaChat(fastify, request, reply);
    }

    const latencyMs = Date.now() - startedAt;
    const usage = responsesUsageToChatUsage(providerResponse?.usage);
    const baseTrace = {
      trace_id: traceId,
      timestamp: new Date().toISOString(),
      session_id: null,
      request: {
        model: request.body.model,
        normalized_model: routeDecision.normalizedModel,
        prompt_hash: promptHash,
        stream: request.body.stream ?? false,
        has_tools: Array.isArray(request.body.tools) && request.body.tools.length > 0,
        privacy_level: privacyLevel,
        context_tokens_est: estimateResponsesContextTokens(request.body)
      },
      candidates: routeDecision.candidates.map((candidate) => ({
        route_id: candidate.routeId,
        endpoint: candidate.endpoint,
        platform: candidate.platform,
        provider: candidate.provider,
        account: candidate.account,
        model_id: candidate.modelId,
        model: candidate.model,
        score: candidate.score,
        sticky: candidate.sticky
      })),
      filtered: routeDecision.filtered.map((candidate) => ({
        route_id: candidate.routeId,
        endpoint: candidate.endpoint,
        platform: candidate.platform,
        provider: candidate.provider,
        account: candidate.account,
        model_id: candidate.modelId,
        model: candidate.model,
        reason: candidate.filteredReason,
        score: candidate.score,
        sticky: candidate.sticky
      })),
      selected: selectedCandidate
        ? {
            route_id: selectedCandidate.routeId,
            endpoint: selectedCandidate.endpoint.id,
            platform: selectedCandidate.platform.id,
            provider: selectedCandidate.provider.id,
            account_hash: sha256(selectedCandidate.account.id),
            model_id: selectedCandidate.modelId,
            model: selectedCandidate.modelName,
            score: selectedCandidate.score
          }
        : null,
      policy_hits: ["responses_native"],
      attempts,
      fallbacks,
      feedback: null
    };

    if (!providerResponse) {
      state.traceStore.append({
        ...baseTrace,
        execution: {
          status: "failed",
          latency_ms: latencyMs,
          error: lastError instanceof Error ? lastError.message : "provider_responses_failed"
        },
        cost: {
          estimated_usd: null,
          actual_usd: null,
          price_confidence: "unknown"
        }
      });

      throw lastError instanceof Error
        ? lastError
        : new HttpError(503, "all_candidates_failed", "All candidates failed", true);
    }

    state.traceStore.append({
      ...baseTrace,
      execution: {
        status: "success",
        latency_ms: latencyMs,
        input_tokens: usage?.prompt_tokens,
        output_tokens: usage?.completion_tokens,
        total_tokens: usage?.total_tokens
      },
      cost: {
        estimated_usd: null,
        actual_usd: null,
        price_confidence: "unknown"
      }
    });

    if (request.body.stream) {
      return reply;
    }

    reply.header("x-autorouter-trace-id", traceId);
    reply.header("x-autorouter-normalized-model", routeDecision.normalizedModel);
    return providerResponse.body;
  });
}
