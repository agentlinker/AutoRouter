import { describe, expect, it } from "vitest";

import { AnthropicStreamTranslator } from "../../src/providers/anthropicStreamTranslator.js";

/** 把 Anthropic SSE 事件拼成上游会发出的字节形态 */
function sse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map((item) => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`)
    .join("");
}

const textStream = sse([
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } }
    }
  },
  {
    event: "content_block_start",
    data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
  },
  {
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }
  },
  {
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }
  },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 5 }
    }
  },
  { event: "message_stop", data: { type: "message_stop" } }
]);

/** 解析译出的 SSE，返回除 [DONE] 外的 JSON 事件 */
function parseChunks(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n\n")
    .map((segment) => segment.replace(/^data: /, "").trim())
    .filter((payload) => payload.length > 0 && payload !== "[DONE]")
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

describe("AnthropicStreamTranslator", () => {
  it("translates text deltas into OpenAI chat completion chunks", () => {
    const translator = new AnthropicStreamTranslator("glm-5.2");
    const raw = translator.push(textStream) + translator.finish();
    const chunks = parseChunks(raw);

    expect(chunks.every((chunk) => chunk.object === "chat.completion.chunk")).toBe(true);
    expect(chunks.every((chunk) => chunk.model === "glm-5.2")).toBe(true);
    expect(chunks[0]).toMatchObject({
      id: "msg_1",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
    });

    const text = chunks
      .map((chunk) => {
        const choice = (chunk.choices as Array<{ delta?: { content?: unknown } }>)[0];
        return typeof choice?.delta?.content === "string" ? choice.delta.content : "";
      })
      .join("");
    expect(text).toBe("Hello world");
    expect(raw.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("maps anthropic stop_reason onto OpenAI finish_reason", () => {
    const translator = new AnthropicStreamTranslator("glm-5.2");
    const chunks = parseChunks(translator.push(textStream) + translator.finish());
    const finishReasons = chunks
      .map((chunk) => (chunk.choices as Array<{ finish_reason?: unknown }>)[0]?.finish_reason)
      .filter((reason) => reason !== null && reason !== undefined);

    expect(finishReasons).toEqual(["stop"]);
  });

  it("preserves usage from message_start and message_delta so trace can account tokens", () => {
    const translator = new AnthropicStreamTranslator("glm-5.2");
    const chunks = parseChunks(translator.push(textStream) + translator.finish());
    const withUsage = chunks.filter((chunk) => chunk.usage !== undefined);

    expect(withUsage.at(-1)).toMatchObject({
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });
  });

  it("translates tool_use blocks into tool_calls deltas", () => {
    const translator = new AnthropicStreamTranslator("glm-5.2");
    const raw =
      translator.push(
        sse([
          { event: "message_start", data: { type: "message_start", message: { id: "msg_2" } } },
          {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" }
            }
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"city":' }
            }
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '"SH"}' }
            }
          },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
          {
            event: "message_delta",
            data: { type: "message_delta", delta: { stop_reason: "tool_use" } }
          }
        ])
      ) + translator.finish();
    const chunks = parseChunks(raw);
    const toolCallDeltas = chunks.flatMap((chunk) => {
      const choice = (chunk.choices as Array<{ delta?: { tool_calls?: unknown[] } }>)[0];
      return choice?.delta?.tool_calls ?? [];
    }) as Array<Record<string, unknown>>;

    expect(toolCallDeltas[0]).toMatchObject({
      index: 0,
      id: "toolu_1",
      type: "function",
      function: { name: "get_weather" }
    });
    const args = toolCallDeltas
      .map((call) => (call.function as { arguments?: unknown } | undefined)?.arguments)
      .filter((value): value is string => typeof value === "string")
      .join("");
    expect(args).toBe('{"city":"SH"}');

    const finishReasons = chunks
      .map((chunk) => (chunk.choices as Array<{ finish_reason?: unknown }>)[0]?.finish_reason)
      .filter((reason) => reason !== null && reason !== undefined);
    expect(finishReasons).toEqual(["tool_calls"]);
  });

  it("reassembles SSE frames split across chunk boundaries", () => {
    const translator = new AnthropicStreamTranslator("glm-5.2");
    const midpoint = Math.floor(textStream.length / 2);
    const raw =
      translator.push(textStream.slice(0, midpoint)) +
      translator.push(textStream.slice(midpoint)) +
      translator.finish();
    const chunks = parseChunks(raw);
    const text = chunks
      .map((chunk) => {
        const choice = (chunk.choices as Array<{ delta?: { content?: unknown } }>)[0];
        return typeof choice?.delta?.content === "string" ? choice.delta.content : "";
      })
      .join("");

    expect(text).toBe("Hello world");
  });

  it("emits [DONE] exactly once even when upstream sends no message_stop", () => {
    const translator = new AnthropicStreamTranslator("glm-5.2");
    const raw =
      translator.push(
        sse([{ event: "message_start", data: { type: "message_start", message: { id: "msg_3" } } }])
      ) + translator.finish();

    expect(raw.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("ignores ping and unknown events instead of forwarding them raw", () => {
    const translator = new AnthropicStreamTranslator("glm-5.2");
    const raw =
      translator.push(
        sse([
          { event: "ping", data: { type: "ping" } },
          { event: "future_event", data: { type: "future_event" } }
        ])
      ) + translator.finish();

    expect(parseChunks(raw)).toHaveLength(0);
    expect(raw).toBe("data: [DONE]\n\n");
  });
});
