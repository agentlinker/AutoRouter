import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expandHome } from "../utils/path.js";
import type { RouteTrace } from "./traceTypes.js";

export class TraceStore {
  public constructor(private readonly directory: string) {}

  public append(trace: RouteTrace) {
    const date = trace.timestamp.slice(0, 10);
    const filePath = join(expandHome(this.directory), `${date}.jsonl`);
    if (!existsSync(dirname(filePath))) {
      mkdirSync(dirname(filePath), { recursive: true });
    }

    appendFileSync(filePath, `${JSON.stringify(trace)}\n`, "utf8");
  }

  public latest(): RouteTrace | null {
    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(expandHome(this.directory), `${today}.jsonl`);
    if (!existsSync(filePath)) {
      return null;
    }

    const lines = readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);

    if (lines.length === 0) {
      return null;
    }

    return JSON.parse(lines[lines.length - 1]) as RouteTrace;
  }
}
