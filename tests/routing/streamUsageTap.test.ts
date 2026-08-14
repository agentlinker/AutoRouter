import { describe, expect, it } from "vitest";

import { StreamUsageTap } from "../../src/routing/streamUsageTap.js";

describe("StreamUsageTap", () => {
  it("captures usage from the final OpenAI chunk", () => {
    const tap = new StreamUsageTap();
    tap.observe('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    tap.observe(
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}\n\n'
    );
    tap.observe("data: [DONE]\n\n");
    tap.finish();

    expect(tap.result()).toEqual({
      prompt_tokens: 11,
      completion_tokens: 3,
      total_tokens: 14
    });
  });

  it("reassembles SSE frames split across chunk boundaries", () => {
    const tap = new StreamUsageTap();
    // 上游 chunk 边界不保证对齐 \n\n，透传实现绕过了这个坑，旁路必须自己缓冲
    tap.observe('data: {"choices":[],"usage":{"prompt_to');
    tap.observe('kens":7,"completion_tokens":2}}');
    tap.observe("\n\n");
    tap.finish();

    expect(tap.result()).toMatchObject({
      prompt_tokens: 7,
      completion_tokens: 2,
      // 上游没给 total 时自行相加
      total_tokens: 9
    });
  });

  it("reads Anthropic usage from message_start and message_delta", () => {
    const tap = new StreamUsageTap();
    tap.observe(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":0}}}\n\n'
    );
    tap.observe(
      'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":25,"output_tokens":8}}\n\n'
    );
    tap.finish();

    // 后到的 usage 覆盖先前的：output_tokens 在流末尾才完整
    expect(tap.result()).toMatchObject({
      prompt_tokens: 25,
      completion_tokens: 8
    });
  });

  it("reads usage nested in an OpenAI Responses completed event", () => {
    const tap = new StreamUsageTap();
    tap.observe(
      'event: response.completed\ndata: {"type":"response.completed","response":' +
        '{"id":"resp_1","usage":{"input_tokens":31,"output_tokens":9,"total_tokens":40}}}\n\n'
    );
    tap.finish();

    expect(tap.result()).toEqual({
      prompt_tokens: 31,
      completion_tokens: 9,
      total_tokens: 40
    });
  });

  it("returns undefined when upstream never sends usage", () => {
    const tap = new StreamUsageTap();
    tap.observe('data: {"choices":[{"delta":{"content":"no usage here"}}]}\n\n');
    tap.observe("data: [DONE]\n\n");
    tap.finish();

    // 中转站不支持 stream_options.include_usage 时的预期行为
    expect(tap.result()).toBeUndefined();
  });

  it("never throws on malformed or non-JSON payloads", () => {
    const tap = new StreamUsageTap();
    expect(() => {
      tap.observe("data: {not json at all\n\n");
      tap.observe(": this is an SSE comment\n\n");
      tap.observe("data:\n\n");
      tap.observe('data: {"usage":"not-an-object"}\n\n');
      tap.observe("garbage without a data prefix\n\n");
      tap.finish();
    }).not.toThrow();

    expect(tap.result()).toBeUndefined();
  });

  it("handles a final event that is not terminated by a blank line", () => {
    const tap = new StreamUsageTap();
    tap.observe('data: {"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}');
    // 没有结尾的 \n\n，finish() 必须把残留 buffer 消费掉
    expect(tap.result()).toBeUndefined();

    tap.finish();
    expect(tap.result()).toEqual({
      prompt_tokens: 4,
      completion_tokens: 1,
      total_tokens: 5
    });
  });
});
