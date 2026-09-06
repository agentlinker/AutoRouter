import { describe, expect, it } from "vitest";

import { normalizeProviderModelTestSelection } from "../../src/admin/utils/providerModelTestSelection.js";

describe("provider model test selection", () => {
  it("keeps a valid selection when refreshed provider data uses new arrays", () => {
    const result = normalizeProviderModelTestSelection({
      modelKey: "tabiai/chat",
      modelKeys: ["tabiai/chat"],
      endpointKey: "openai",
      endpointKeys: ["openai"],
      defaultEndpointKey: "openai"
    });

    expect(result).toEqual({
      modelKey: "tabiai/chat",
      endpointKey: "openai",
      changed: false
    });
  });

  it("changes the model when the selected account does not expose it", () => {
    const result = normalizeProviderModelTestSelection({
      modelKey: "tabiai/chat",
      modelKeys: ["tabiai/reasoning"],
      endpointKey: "openai",
      endpointKeys: ["openai"],
      defaultEndpointKey: "openai"
    });

    expect(result).toEqual({
      modelKey: "tabiai/reasoning",
      endpointKey: "openai",
      changed: true
    });
  });
});
