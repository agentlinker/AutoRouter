import type { FastifyInstance, FastifyReply } from "fastify";

import { HttpError } from "../../utils/httpErrors.js";
import type {
  ChatCompletionsRequestBody,
  ChatMessage,
  ToolDefinition
} from "../../routing/types.js";

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicMessagesRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>;
  tool_choice?: {
    type?: string;
    name?: string;
  };
  metadata?: Record<string, unknown>;
}

interface OpenAiChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{
        id?: string;
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
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }

  return content === undefined || content === null ? "" : JSON.stringify(content);
}

function systemToMessage(system: AnthropicMessagesRequestBody["system"]): ChatMessage | null {
  if (system === undefined) {
    return null;
  }

  return {
    role: "system",
    content: contentToText(system)
  };
}

function toChatMessages(messages: AnthropicMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }

    const textBlocks = message.content.filter((block) => block.type === "text");
    const toolUseBlocks = message.content.filter((block) => block.type === "tool_use");
    const toolResultBlocks = message.content.filter((block) => block.type === "tool_result");

    if (message.role === "assistant" && toolUseBlocks.length > 0) {
      result.push({
        role: "assistant",
        content: textBlocks.map((block) => block.text ?? "").join("\n"),
        tool_calls: toolUseBlocks.map((block) => ({
          id: block.id ?? "tool_call",
          type: "function",
          function: {
            name: block.name ?? "tool",
            arguments: JSON.stringify(block.input ?? {})
          }
        }))
      });
    } else if (textBlocks.length > 0) {
      result.push({
        role: message.role,
        content: textBlocks.map((block) => block.text ?? "").join("\n")
      });
    }

    for (const block of toolResultBlocks) {
      result.push({
        role: "tool",
        tool_call_id: block.tool_use_id ?? "tool_call",
        content: contentToText(block.content)
      });
    }

    if (textBlocks.length === 0 && toolUseBlocks.length === 0 && toolResultBlocks.length === 0) {
      result.push({
        role: message.role,
        content: contentToText(message.content)
      });
    }
  }

  return result;
}

function toChatTools(tools: AnthropicMessagesRequestBody["tools"]): ToolDefinition[] | undefined {
  return tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? {}
    }
  }));
}

function toChatToolChoice(toolChoice: AnthropicMessagesRequestBody["tool_choice"]): unknown {
  if (!toolChoice?.type || toolChoice.type === "auto") {
    return toolChoice?.type;
  }
  if (toolChoice.type === "any") {
    return "required";
  }
  if (toolChoice.type === "tool" && toolChoice.name) {
    return {
      type: "function",
      function: {
        name: toolChoice.name
      }
    };
  }
  return undefined;
}

function toChatRequest(body: AnthropicMessagesRequestBody): ChatCompletionsRequestBody {
  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, "invalid_request", "model and messages are required");
  }

  const systemMessage = systemToMessage(body.system);

  return {
    model: body.model,
    messages: [
      ...(systemMessage ? [systemMessage] : []),
      ...toChatMessages(body.messages)
    ],
    stream: false,
    tools: toChatTools(body.tools),
    tool_choice: toChatToolChoice(body.tool_choice),
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    metadata: body.metadata
  };
}

function parseToolArguments(value: string | undefined): unknown {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function toAnthropicResponse(body: OpenAiChatResponse, requestedModel: string) {
  const choice = body.choices?.[0];
  const message = choice?.message;
  const content: Array<Record<string, unknown>> = [];
  const text = contentToText(message?.content);

  if (text.length > 0) {
    content.push({ type: "text", text });
  }

  for (const toolCall of message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: toolCall.id ?? "tool_call",
      name: toolCall.function?.name ?? "tool",
      input: parseToolArguments(toolCall.function?.arguments)
    });
  }

  const stopReason =
    (message?.tool_calls?.length ?? 0) > 0
      ? "tool_use"
      : choice?.finish_reason === "length"
        ? "max_tokens"
        : "end_turn";

  return {
    id: body.id ?? "msg_autorouter",
    type: "message",
    role: "assistant",
    model: body.model ?? requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0
    }
  };
}

function writeSse(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeAnthropicStream(reply: FastifyReply, response: ReturnType<typeof toAnthropicResponse>) {
  reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("cache-control", "no-cache");
  reply.raw.setHeader("connection", "keep-alive");

  writeSse(reply, "message_start", {
    type: "message_start",
    message: {
      ...response,
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: 0
      }
    }
  });

  response.content.forEach((block, index) => {
    writeSse(reply, "content_block_start", {
      type: "content_block_start",
      index,
      content_block:
        block.type === "tool_use"
          ? { ...block, input: {} }
          : { type: "text", text: "" }
    });

    if (block.type === "tool_use") {
      writeSse(reply, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input ?? {})
        }
      });
    } else {
      writeSse(reply, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "text_delta",
          text: block.text ?? ""
        }
      });
    }

    writeSse(reply, "content_block_stop", {
      type: "content_block_stop",
      index
    });
  });

  writeSse(reply, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: response.stop_reason,
      stop_sequence: null
    },
    usage: {
      output_tokens: response.usage.output_tokens
    }
  });
  writeSse(reply, "message_stop", { type: "message_stop" });
  reply.raw.end();
}

export async function registerAnthropicMessagesRoute(fastify: FastifyInstance) {
  fastify.post<{ Body: AnthropicMessagesRequestBody }>("/v1/messages", async (request, reply) => {
    const authorization =
      request.headers.authorization ??
      (typeof request.headers["x-api-key"] === "string"
        ? `Bearer ${request.headers["x-api-key"]}`
        : undefined);
    const chatResponse = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        ...(authorization ? { authorization } : {}),
        "content-type": "application/json"
      },
      payload: toChatRequest(request.body)
    });

    const responseBody = chatResponse.json() as OpenAiChatResponse | {
      error?: {
        code?: string;
        message?: string;
      };
    };
    if (chatResponse.statusCode >= 400) {
      throw new HttpError(
        chatResponse.statusCode,
        "error" in responseBody ? responseBody.error?.code ?? "request_error" : "request_error",
        "error" in responseBody ? responseBody.error?.message ?? "Request failed" : "Request failed"
      );
    }

    const response = toAnthropicResponse(
      responseBody as OpenAiChatResponse,
      request.body.model
    );
    const traceId = chatResponse.headers["x-autorouter-trace-id"];
    const normalizedModel = chatResponse.headers["x-autorouter-normalized-model"];
    if (traceId) {
      reply.header("x-autorouter-trace-id", traceId);
    }
    if (normalizedModel) {
      reply.header("x-autorouter-normalized-model", normalizedModel);
    }

    if (request.body.stream) {
      writeAnthropicStream(reply, response);
      return reply;
    }

    return response;
  });
}
