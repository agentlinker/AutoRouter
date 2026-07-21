import { HttpError } from "../utils/httpErrors.js";
import { estimateChatContextTokens } from "../utils/contextTokens.js";
import type {
  ChatCompletionsRequestBody,
  NormalizedChatRequest
} from "./types.js";

export function normalizeChatRequest(
  body: ChatCompletionsRequestBody
): NormalizedChatRequest {
  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, "invalid_request", "model and messages are required");
  }

  const metadata = body.metadata ?? {};
  const tools = body.tools ?? [];

  return {
    model: body.model,
    messages: body.messages,
    stream: body.stream ?? false,
    tools,
    tool_choice: body.tool_choice,
    response_format: body.response_format,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    metadata,
    context_tokens_est: estimateChatContextTokens({
      messages: body.messages,
      tools,
      metadata
    })
  };
}
