/**
 * Anthropic Messages SSE → OpenAI Chat Completions SSE 的流式转换。
 *
 * 存在原因：调用方走 `/v1/chat/completions` 时期待 `chat.completion.chunk`，
 * 但路由可能把候选落到 anthropic 协议的 endpoint。非流式路径已有
 * `toOpenAiLikeResponse` 做同样的事，这里补齐流式的那一半。
 *
 * 与 StreamUsageTap 的分工：这里负责改写发给客户端的字节，usage 只是顺带
 * 透传到末尾 chunk 上；tap 仍独立观测自己那份，二者互不依赖。
 */

interface AnthropicUsage {
  promptTokens?: number;
  completionTokens?: number;
}

/** Anthropic stop_reason → OpenAI finish_reason */
function toFinishReason(stopReason: unknown): string {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export class AnthropicStreamTranslator {
  /** SSE 帧可能跨 chunk 边界，未消费完的尾部留在这里 */
  private buffer = "";
  private messageId = "chatcmpl_anthropic";
  private roleEmitted = false;
  private finished = false;
  private usage: AnthropicUsage = {};
  /**
   * content_block 的 index 是 Anthropic 的块序号，与 OpenAI 的 tool_calls index
   * 不同：文本块也占 Anthropic 的序号。这里只给 tool_use 块单独编号。
   */
  private toolCallIndexByBlock = new Map<number, number>();
  private nextToolCallIndex = 0;

  public constructor(private readonly modelName: string) {}

  /** 消费上游字节，返回应写给客户端的 OpenAI 格式 SSE（可能为空串） */
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

  /** 流结束时调用，冲掉残余帧并补 [DONE] */
  public finish(): string {
    let output = "";
    if (this.buffer.length > 0) {
      output += this.consumeSegment(this.buffer);
      this.buffer = "";
    }
    if (!this.finished) {
      this.finished = true;
      output += "data: [DONE]\n\n";
    }
    return output;
  }

  private consumeSegment(segment: string): string {
    let output = "";
    for (const line of segment.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const payload = trimmed.slice("data:".length).trim();
      if (payload.length === 0 || payload === "[DONE]") {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        // 上游可能发非 JSON 的心跳，跳过即可
        continue;
      }

      output += this.translateEvent(parsed);
    }
    return output;
  }

  private translateEvent(event: unknown): string {
    const record = asRecord(event);
    if (!record) {
      return "";
    }

    switch (record.type) {
      case "message_start":
        return this.onMessageStart(record);
      case "content_block_start":
        return this.onContentBlockStart(record);
      case "content_block_delta":
        return this.onContentBlockDelta(record);
      case "message_delta":
        return this.onMessageDelta(record);
      case "message_stop":
        return this.onMessageStop();
      default:
        // ping / content_block_stop / 未来新增事件都无需转换
        return "";
    }
  }

  private onMessageStart(record: Record<string, unknown>): string {
    const message = asRecord(record.message);
    if (typeof message?.id === "string") {
      this.messageId = message.id;
    }
    this.captureUsage(asRecord(message?.usage));

    this.roleEmitted = true;
    return this.emit({ delta: { role: "assistant" }, finishReason: null });
  }

  private onContentBlockStart(record: Record<string, unknown>): string {
    const block = asRecord(record.content_block);
    if (block?.type !== "tool_use") {
      return "";
    }

    const blockIndex = numberOrUndefined(record.index) ?? 0;
    const toolCallIndex = this.nextToolCallIndex++;
    this.toolCallIndexByBlock.set(blockIndex, toolCallIndex);

    return this.emit({
      delta: {
        tool_calls: [
          {
            index: toolCallIndex,
            id: typeof block.id === "string" ? block.id : `call_${toolCallIndex}`,
            type: "function",
            function: {
              name: typeof block.name === "string" ? block.name : "",
              arguments: ""
            }
          }
        ]
      },
      finishReason: null
    });
  }

  private onContentBlockDelta(record: Record<string, unknown>): string {
    const delta = asRecord(record.delta);
    if (!delta) {
      return "";
    }

    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return this.emit({ delta: { content: delta.text }, finishReason: null });
    }

    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const blockIndex = numberOrUndefined(record.index) ?? 0;
      const toolCallIndex = this.toolCallIndexByBlock.get(blockIndex) ?? 0;
      return this.emit({
        delta: {
          tool_calls: [
            {
              index: toolCallIndex,
              function: { arguments: delta.partial_json }
            }
          ]
        },
        finishReason: null
      });
    }

    return "";
  }

  private onMessageDelta(record: Record<string, unknown>): string {
    this.captureUsage(asRecord(record.usage));
    const delta = asRecord(record.delta);
    return this.emit({
      delta: {},
      finishReason: toFinishReason(delta?.stop_reason),
      includeUsage: true
    });
  }

  private onMessageStop(): string {
    if (this.finished) {
      return "";
    }
    this.finished = true;
    return "data: [DONE]\n\n";
  }

  private captureUsage(usage: Record<string, unknown> | null): void {
    if (!usage) {
      return;
    }
    const promptTokens = numberOrUndefined(usage.input_tokens);
    const completionTokens = numberOrUndefined(usage.output_tokens);
    if (promptTokens !== undefined) {
      this.usage.promptTokens = promptTokens;
    }
    // output_tokens 在 message_start 里是 0，message_delta 才是最终值
    if (completionTokens !== undefined) {
      this.usage.completionTokens = completionTokens;
    }
  }

  private emit(input: {
    delta: Record<string, unknown>;
    finishReason: string | null;
    includeUsage?: boolean;
  }): string {
    if (!this.roleEmitted) {
      // 上游没发 message_start 时也要保证首个 chunk 带 role
      this.roleEmitted = true;
      input.delta = { role: "assistant", ...input.delta };
    }

    const chunk: Record<string, unknown> = {
      id: this.messageId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.modelName,
      choices: [
        {
          index: 0,
          delta: input.delta,
          finish_reason: input.finishReason
        }
      ]
    };

    if (input.includeUsage) {
      const { promptTokens, completionTokens } = this.usage;
      if (promptTokens !== undefined || completionTokens !== undefined) {
        chunk.usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens:
            promptTokens !== undefined && completionTokens !== undefined
              ? promptTokens + completionTokens
              : undefined
        };
      }
    }

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }
}
