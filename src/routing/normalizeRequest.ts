import { HttpError } from "../utils/httpErrors.js";
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

  return {
    model: body.model,
    messages: body.messages,
    stream: body.stream ?? false,
    tools: body.tools ?? [],
    tool_choice: body.tool_choice,
    response_format: body.response_format,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    metadata: body.metadata ?? {},
    context_tokens_est: JSON.stringify(body.messages).length
  };
}
