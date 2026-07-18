import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import parquet from "parquetjs-lite";
import { afterEach, describe, expect, it } from "vitest";

import { TraceArchiveWriter } from "../../src/trace/traceArchiveWriter.js";

describe("TraceArchiveWriter", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("writes trace batches into parquet files grouped by date", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "autorouter-trace-archive-"));
    const writer = new TraceArchiveWriter({
      directory: tempDir,
      flushBatchSize: 2
    });

    writer.append({
      trace_id: "trace-1",
      timestamp: "2026-07-07T01:00:00.000Z",
      session_id: "sess-1",
      request: {
        model: "auto",
        normalized_model: "auto/provider-model",
        prompt_hash: "sha256:trace-1",
        stream: false,
        has_tools: true,
        privacy_level: "normal",
        context_tokens_est: 321
      },
      candidates: [],
      filtered: [],
      selected: {
        route_id: "auto",
        endpoint: "provider/default",
        platform: "openai",
        provider: "provider",
        account_hash: "sha256:acc",
        model_id: "provider/model",
        model: "provider-model",
        score: 1.23
      },
      policy_hits: ["session_sticky"],
      execution: {
        status: "success",
        latency_ms: 90,
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15
      },
      cost: {
        estimated_usd: 0.001,
        actual_usd: null,
        price_confidence: "medium"
      },
      fallbacks: [],
      feedback: {
        feedback_label: "accepted",
        feedback_source: "human",
        feedback_at: "2026-07-07T01:01:00.000Z",
        training_split: "train",
        tags: ["golden"]
      }
    });

    writer.append({
      trace_id: "trace-2",
      timestamp: "2026-07-07T01:02:00.000Z",
      session_id: null,
      request: {
        model: "auto",
        normalized_model: "auto/provider-model",
        prompt_hash: "sha256:trace-2",
        stream: true,
        has_tools: false,
        privacy_level: "private",
        context_tokens_est: 111
      },
      candidates: [],
      filtered: [],
      selected: null,
      policy_hits: [],
      execution: {
        status: "failed",
        latency_ms: 10,
        error: "provider_failed"
      },
      cost: {
        estimated_usd: null,
        actual_usd: null,
        price_confidence: "unknown"
      },
      fallbacks: []
    });

    await writer.close();

    const dateDirectory = join(tempDir, "date=2026-07-07");
    expect(existsSync(dateDirectory)).toBe(true);

    const files = readdirSync(dateDirectory).filter((fileName) => fileName.endsWith(".parquet"));
    expect(files.length).toBe(1);

    const reader = await parquet.ParquetReader.openFile(join(dateDirectory, files[0]!));
    const cursor = reader.getCursor();
    const row1 = await cursor.next();
    const row2 = await cursor.next();
    await reader.close();

    expect(row1?.trace_id).toBe("trace-1");
    expect(Number(row1?.context_tokens_est)).toBe(321);
    expect(row1?.training_split).toBe("train");
    expect(row2?.trace_id).toBe("trace-2");
    expect(row2?.execution_status).toBe("failed");
  });
});
