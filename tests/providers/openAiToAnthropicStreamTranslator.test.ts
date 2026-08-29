import { describe, expect, it } from "vitest";

import { OpenAiToAnthropicStreamTranslator } from "../../src/providers/openAiToAnthropicStreamTranslator.js";

function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("OpenAiToAnthropicStreamTranslator", () => {
  it("reassembles split SSE frames and preserves text, stop reason, and usage", () => {
    const translator = new OpenAiToAnthropicStreamTranslator("claude-opus-5");
    const frame = data({
      id: "chatcmpl_text",
      choices: [
        {
          delta: { role: "assistant", content: "hello" },
          finish_reason: null
        }
      ]
    });

    const first = translator.push(frame.slice(0, 24));
    const second = translator.push(frame.slice(24));
    const final =
      translator.push(
        data({
          choices: [{ delta: {}, finish_reason: "length" }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 3,
            total_tokens: 14
          }
        }) + "data: [DONE]\n\n"
      ) + translator.finish();

    expect(first).toBe("");
    expect(second).toContain("event: message_start");
    expect(second).toContain('"model":"claude-opus-5"');
    expect(second).toContain('"type":"text_delta","text":"hello"');
    expect(final).toContain('"stop_reason":"max_tokens"');
    expect(final).toContain('"input_tokens":11,"output_tokens":3');
    expect(final.match(/event: message_stop/g)).toHaveLength(1);
  });

  it("streams split tool arguments as Anthropic tool_use blocks", () => {
    const translator = new OpenAiToAnthropicStreamTranslator("claude-opus-5");
    const output =
      translator.push(
        data({
          id: "chatcmpl_tool",
          choices: [
            {
              delta: {
                role: "assistant",
                content: "checking",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_weather",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: '{"city":'
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        })
      ) +
      translator.push(
        data({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"Shanghai"}' }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ]
        }) + "data: [DONE]\n\n"
      );

    expect(output).toContain(
      '"type":"tool_use","id":"call_weather","name":"get_weather","input":{}'
    );
    const textStop = output.indexOf(
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}'
    );
    const toolStart = output.indexOf(
      'event: content_block_start\ndata: {"type":"content_block_start","index":1'
    );
    expect(textStop).toBeGreaterThan(-1);
    expect(toolStart).toBeGreaterThan(textStop);
    expect(output).toContain('"partial_json":"{\\"city\\":"');
    expect(output).toContain('"partial_json":"\\"Shanghai\\"}"');
    expect(output).toContain('"stop_reason":"tool_use"');
    expect(output).toContain("event: content_block_stop");
    expect(output).toContain("event: message_stop");
  });
});
