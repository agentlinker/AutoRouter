import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";

import type { ChatCompletionsRequestBody, ChatMessage, ToolDefinition } from "../../routing/types.js";
import { HttpError } from "../../utils/httpErrors.js";

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
      } as ChatMessage);
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

export async function registerResponsesRoute(fastify: FastifyInstance) {
  fastify.post<{ Body: ResponsesRequestBody }>("/v1/responses", async (request, reply) => {
    if (!request.body.model) {
      throw new HttpError(400, "invalid_request", "model is required");
    }

    const chatPayload: ChatCompletionsRequestBody = {
      model: request.body.model,
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
      request.body.model
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
  });
}
