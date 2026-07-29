import { describe, expect, it } from "vitest";

import { formatAccountHashHint } from "../../src/admin/utils/accountHash.js";

describe("formatAccountHashHint", () => {
  it("formats selected account hashes like provider key hints", () => {
    expect(formatAccountHashHint("sha256:0123456789abcdefad19")).toBe("...ad19");
    expect(formatAccountHashHint("0123456789abcdefad19")).toBe("...ad19");
  });

  it("keeps empty values as not matched", () => {
    expect(formatAccountHashHint(null)).toBe("未命中");
  });
});
