import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/admin/styles.css", "utf8");

describe("theme styles", () => {
  it("keeps literal colors in theme definitions so shared components cannot leak dark colors", () => {
    const componentRules = css.replace(/:root(?:\[data-theme="wise"\])?\s*\{[^}]*\}/g, "");
    expect(componentRules.match(/#[\da-f]{3,8}\b|rgba?\(\s*\d/gi)).toBeNull();
  });

  it("defines every referenced color and surface token", () => {
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
    const references = [...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]);
    expect([...new Set(references)].filter((name) => !defined.has(name))).toEqual([]);
  });
});
