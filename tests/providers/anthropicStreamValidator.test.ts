import { describe, expect, it } from "vitest";

import { AnthropicStreamValidator } from "../../src/providers/anthropicStreamValidator.js";

describe("AnthropicStreamValidator", () => {
  it("accepts a complete Anthropic message stream across chunk boundaries", () => {
    const validator = new AnthropicStreamValidator();
    validator.observe('event: message_start\ndata: {"type":"message_');
    validator.observe('start","message":{"id":"msg_1"}}\n\n');
    validator.observe('event: message_stop\ndata: {"type":"message_stop"}\n\n');

    expect(validator.finish()).toEqual({
      completed: true,
      terminalEvent: "message_stop"
    });
  });

  it("rejects a stream that ends without message_stop", () => {
    const validator = new AnthropicStreamValidator();
    validator.observe('event: message_start\ndata: {"type":"message_start"}\n\n');
    validator.observe(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0}\n\n'
    );

    expect(() => validator.finish()).toThrow("Anthropic stream ended without message_stop");
    expect(validator.result()).toEqual({
      completed: false,
      terminalEvent: "content_block_delta"
    });
  });
});
