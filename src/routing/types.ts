export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
}

export interface ToolDefinition {
  type: string;
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionsRequestBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  response_format?: unknown;
  temperature?: number;
  max_tokens?: number;
  metadata?: Record<string, unknown>;
}

export interface NormalizedChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  tools: ToolDefinition[];
  tool_choice?: unknown;
  response_format?: unknown;
  temperature?: number;
  max_tokens?: number;
  metadata: Record<string, unknown>;
  context_tokens_est: number;
}
