import type { ProviderResponse } from "../providers/adapter.js";

/**
 * 从流式响应里旁路读取 usage，**不参与响应写出**。
 *
 * 设计约束：调用方必须先把字节写给客户端，再调 `observe()`。观测失败只丢 usage，
 * 绝不影响透传保真度或响应本身。因此这里所有解析都吞掉异常。
 *
 * OpenAI 流式默认不发 usage，需要请求侧带 `stream_options.include_usage`；
 * 部分 OpenAI 兼容中转站不认这个字段，此时 `result()` 返回 undefined，
 * 行为与实现本特性之前一致（trace 无 token 数）。
 */
export class StreamUsageTap {
  /** SSE 帧可能跨 chunk 边界，未消费完的尾部留在这里 */
  private buffer = "";
  private usage: ProviderResponse["usage"];

  public observe(raw: string): void {
    try {
      this.buffer += raw;

      // 按 SSE 事件分隔符切分，最后一段可能不完整，留回 buffer
      const segments = this.buffer.split("\n\n");
      this.buffer = segments.pop() ?? "";

      for (const segment of segments) {
        this.consumeSegment(segment);
      }
    } catch {
      // 观测是 best-effort，任何异常都不应影响响应
    }
  }

  /**
   * 流结束时调用，处理最后一个可能没有以空行结尾的事件。
   */
  public finish(): void {
    try {
      if (this.buffer.length > 0) {
        this.consumeSegment(this.buffer);
        this.buffer = "";
      }
    } catch {
      // 同上
    }
  }

  public result(): ProviderResponse["usage"] {
    return this.usage;
  }

  private consumeSegment(segment: string): void {
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
        continue;
      }

      this.captureUsage(parsed);
    }
  }

  /**
   * usage 在三种协议里的位置各不相同：
   *
   * - OpenAI Chat Completions：顶层 `usage`（末尾 chunk，需 include_usage）
   * - Anthropic Messages：`message.usage`（message_start）与顶层 `usage`（message_delta）
   * - OpenAI Responses：`response.usage`（response.completed），且字段名是
   *   input_tokens / output_tokens
   *
   * 逐层找到第一个像 usage 的对象即可。
   */
  private extractRawUsage(event: unknown): Record<string, unknown> | null {
    if (!event || typeof event !== "object") {
      return null;
    }

    const record = event as Record<string, unknown>;
    for (const candidate of [record.usage, asRecord(record.message)?.usage, asRecord(record.response)?.usage]) {
      if (candidate && typeof candidate === "object") {
        return candidate as Record<string, unknown>;
      }
    }

    return null;
  }

  /**
   * 同时兼容 OpenAI（prompt_tokens / completion_tokens）与
   * Anthropic / Responses（input_tokens / output_tokens）两种字段命名。
   * 后到的非空 usage 覆盖先前的：流式 usage 通常在最后一个事件才完整。
   */
  private captureUsage(event: unknown): void {
    const rawUsage = this.extractRawUsage(event);
    if (!rawUsage) {
      return;
    }

    const promptTokens = numberOrUndefined(rawUsage.prompt_tokens ?? rawUsage.input_tokens);
    const completionTokens = numberOrUndefined(
      rawUsage.completion_tokens ?? rawUsage.output_tokens
    );
    const totalTokens = numberOrUndefined(rawUsage.total_tokens);

    if (promptTokens === undefined && completionTokens === undefined) {
      return;
    }

    this.usage = {
      prompt_tokens: promptTokens ?? this.usage?.prompt_tokens,
      completion_tokens: completionTokens ?? this.usage?.completion_tokens,
      total_tokens:
        totalTokens ??
        (promptTokens !== undefined && completionTokens !== undefined
          ? promptTokens + completionTokens
          : this.usage?.total_tokens)
    };
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
