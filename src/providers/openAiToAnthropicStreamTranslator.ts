interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
}

interface ToolBlock {
  blockIndex: number;
  started: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toStopReason(finishReason: unknown): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

function emit(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * OpenAI Chat Completions SSE → Anthropic Messages SSE.
 *
 * Incomplete SSE frames are buffered. Text and tool argument deltas are
 * forwarded as soon as a complete upstream frame arrives.
 */
export class OpenAiToAnthropicStreamTranslator {
  private buffer = "";
  private messageId = "msg_autorouter";
  private modelName: string;
  private messageStarted = false;
  private textBlockIndex: number | undefined;
  private textBlockOpen = false;
  private nextBlockIndex = 0;
  private toolBlocks = new Map<number, ToolBlock>();
  private stopReason = "end_turn";
  private usage: StreamUsage = {};
  private finished = false;

  public constructor(requestedModel: string) {
    this.modelName = requestedModel;
  }

  public push(raw: string): string {
    this.buffer += raw;
    const segments = this.buffer.split("\n\n");
    this.buffer = segments.pop() ?? "";

    let output = "";
    for (const segment of segments) {
      output += this.consumeSegment(segment);
    }
    return output;
  }

  public finish(): string {
    let output = "";
    if (this.buffer.length > 0) {
      output += this.consumeSegment(this.buffer);
      this.buffer = "";
    }
    return output + this.finishMessage();
  }

  private consumeSegment(segment: string): string {
    let output = "";
    for (const line of segment.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const payload = trimmed.slice("data:".length).trim();
      if (payload === "[DONE]") {
        output += this.finishMessage();
        continue;
      }
      if (payload.length === 0) {
        continue;
      }

      try {
        output += this.translateChunk(JSON.parse(payload));
      } catch {
        // Ignore non-JSON heartbeats from OpenAI-compatible relays.
      }
    }
    return output;
  }

  private translateChunk(value: unknown): string {
    const chunk = asRecord(value);
    if (!chunk) {
      return "";
    }

    if (typeof chunk.id === "string") {
      this.messageId = chunk.id.replace(/^chatcmpl_/, "msg_");
    }
    if (typeof chunk.model === "string") {
      this.modelName = chunk.model;
    }
    this.captureUsage(asRecord(chunk.usage));

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = asRecord(choices[0]);
    if (!choice) {
      return "";
    }

    let output = this.startMessage();
    const delta = asRecord(choice.delta);
    if (typeof delta?.content === "string" && delta.content.length > 0) {
      output += this.emitText(delta.content);
    }
    if (Array.isArray(delta?.tool_calls)) {
      output += this.emitToolCalls(delta.tool_calls);
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      this.stopReason = toStopReason(choice.finish_reason);
    }
    return output;
  }

  private startMessage(): string {
    if (this.messageStarted) {
      return "";
    }
    this.messageStarted = true;
    return emit("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.modelName,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  private emitText(text: string): string {
    let output = "";
    if (this.textBlockIndex === undefined) {
      this.textBlockIndex = this.nextBlockIndex++;
      this.textBlockOpen = true;
      output += emit("content_block_start", {
        type: "content_block_start",
        index: this.textBlockIndex,
        content_block: { type: "text", text: "" }
      });
    }
    return output + emit("content_block_delta", {
      type: "content_block_delta",
      index: this.textBlockIndex,
      delta: { type: "text_delta", text }
    });
  }

  private emitToolCalls(values: unknown[]): string {
    let output = this.closeTextBlock();
    for (const value of values) {
      const toolCall = asRecord(value);
      const toolIndex = numberOrUndefined(toolCall?.index);
      if (!toolCall || toolIndex === undefined) {
        continue;
      }

      let block = this.toolBlocks.get(toolIndex);
      if (!block) {
        block = { blockIndex: this.nextBlockIndex++, started: false };
        this.toolBlocks.set(toolIndex, block);
      }

      const fn = asRecord(toolCall.function);
      if (!block.started) {
        block.started = true;
        output += emit("content_block_start", {
          type: "content_block_start",
          index: block.blockIndex,
          content_block: {
            type: "tool_use",
            id: typeof toolCall.id === "string" ? toolCall.id : `toolu_${toolIndex}`,
            name: typeof fn?.name === "string" ? fn.name : "tool",
            input: {}
          }
        });
      }

      if (typeof fn?.arguments === "string" && fn.arguments.length > 0) {
        output += emit("content_block_delta", {
          type: "content_block_delta",
          index: block.blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: fn.arguments
          }
        });
      }
    }
    return output;
  }

  private captureUsage(usage: Record<string, unknown> | null): void {
    if (!usage) {
      return;
    }
    this.usage.inputTokens =
      numberOrUndefined(usage.prompt_tokens) ?? this.usage.inputTokens;
    this.usage.outputTokens =
      numberOrUndefined(usage.completion_tokens) ?? this.usage.outputTokens;
  }

  private closeTextBlock(): string {
    if (this.textBlockIndex === undefined || !this.textBlockOpen) {
      return "";
    }
    this.textBlockOpen = false;
    return emit("content_block_stop", {
      type: "content_block_stop",
      index: this.textBlockIndex
    });
  }

  private finishMessage(): string {
    if (this.finished) {
      return "";
    }
    this.finished = true;

    let output = this.startMessage() + this.closeTextBlock();
    const blockIndices = Array.from(
      this.toolBlocks.values(),
      (block) => block.blockIndex
    ).sort((left, right) => left - right);

    for (const index of blockIndices) {
      output += emit("content_block_stop", {
        type: "content_block_stop",
        index
      });
    }
    output += emit("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: this.stopReason,
        stop_sequence: null
      },
      usage: {
        input_tokens: this.usage.inputTokens ?? 0,
        output_tokens: this.usage.outputTokens ?? 0
      }
    });
    return output + emit("message_stop", { type: "message_stop" });
  }
}
