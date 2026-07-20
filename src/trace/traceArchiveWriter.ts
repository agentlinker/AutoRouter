import { mkdirSync } from "node:fs";
import { join } from "node:path";

import parquet from "parquetjs-lite";

import { expandHome } from "../utils/path.js";
import type { RouteTrace } from "./traceTypes.js";

const flushDelayMs = 5_000;

const archiveSchema = new parquet.ParquetSchema({
  trace_id: { type: "UTF8" },
  timestamp: { type: "UTF8" },
  session_id: { type: "UTF8", optional: true },
  requested_model: { type: "UTF8" },
  normalized_model: { type: "UTF8" },
  prompt_hash: { type: "UTF8" },
  stream: { type: "BOOLEAN" },
  has_tools: { type: "BOOLEAN" },
  privacy_level: { type: "UTF8" },
  context_tokens_est: { type: "INT64" },
  selected_route_id: { type: "UTF8", optional: true },
  selected_endpoint: { type: "UTF8", optional: true },
  selected_platform: { type: "UTF8", optional: true },
  selected_provider: { type: "UTF8", optional: true },
  selected_account_hash: { type: "UTF8", optional: true },
  selected_model_id: { type: "UTF8", optional: true },
  selected_model: { type: "UTF8", optional: true },
  selected_score: { type: "DOUBLE", optional: true },
  policy_hits_json: { type: "UTF8" },
  candidates_json: { type: "UTF8" },
  filtered_json: { type: "UTF8" },
  attempts_json: { type: "UTF8" },
  fallbacks_json: { type: "UTF8" },
  execution_status: { type: "UTF8" },
  latency_ms: { type: "INT64" },
  input_tokens: { type: "INT64" },
  output_tokens: { type: "INT64" },
  total_tokens: { type: "INT64" },
  execution_error: { type: "UTF8", optional: true },
  estimated_cost_usd: { type: "DOUBLE", optional: true },
  actual_cost_usd: { type: "DOUBLE", optional: true },
  price_confidence: { type: "UTF8" },
  feedback_label: { type: "UTF8", optional: true },
  feedback_source: { type: "UTF8", optional: true },
  feedback_at: { type: "UTF8", optional: true },
  training_split: { type: "UTF8", optional: true },
  tags_json: { type: "UTF8", optional: true }
});

function toArchiveRow(trace: RouteTrace): Record<string, unknown> {
  const inputTokens = trace.execution.input_tokens ?? 0;
  const outputTokens = trace.execution.output_tokens ?? 0;
  const totalTokens = trace.execution.total_tokens ?? inputTokens + outputTokens;

  return {
    trace_id: trace.trace_id,
    timestamp: trace.timestamp,
    session_id: trace.session_id ?? undefined,
    requested_model: trace.request.model,
    normalized_model: trace.request.normalized_model,
    prompt_hash: trace.request.prompt_hash,
    stream: trace.request.stream,
    has_tools: trace.request.has_tools,
    privacy_level: trace.request.privacy_level,
    context_tokens_est: trace.request.context_tokens_est,
    selected_route_id: trace.selected?.route_id ?? undefined,
    selected_endpoint: trace.selected?.endpoint ?? undefined,
    selected_platform: trace.selected?.platform ?? undefined,
    selected_provider: trace.selected?.provider ?? undefined,
    selected_account_hash: trace.selected?.account_hash ?? undefined,
    selected_model_id: trace.selected?.model_id ?? undefined,
    selected_model: trace.selected?.model ?? undefined,
    selected_score: trace.selected?.score ?? undefined,
    policy_hits_json: JSON.stringify(trace.policy_hits),
    candidates_json: JSON.stringify(trace.candidates),
    filtered_json: JSON.stringify(trace.filtered),
    attempts_json: JSON.stringify(trace.attempts ?? []),
    fallbacks_json: JSON.stringify(trace.fallbacks),
    execution_status: trace.execution.status,
    latency_ms: trace.execution.latency_ms,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    execution_error: trace.execution.error ?? undefined,
    estimated_cost_usd: trace.cost.estimated_usd ?? undefined,
    actual_cost_usd: trace.cost.actual_usd ?? undefined,
    price_confidence: trace.cost.price_confidence,
    feedback_label: trace.feedback?.feedback_label ?? undefined,
    feedback_source: trace.feedback?.feedback_source ?? undefined,
    feedback_at: trace.feedback?.feedback_at ?? undefined,
    training_split: trace.feedback?.training_split ?? undefined,
    tags_json: trace.feedback?.tags ? JSON.stringify(trace.feedback.tags) : undefined
  };
}

export interface TraceArchiveWriterOptions {
  directory: string;
  flushBatchSize: number;
  logger?: {
    error: (input: unknown, message?: string) => void;
  };
}

export class TraceArchiveWriter {
  private readonly directory: string;
  private readonly flushBatchSize: number;
  private readonly logger?: TraceArchiveWriterOptions["logger"];
  private readonly buffer: RouteTrace[] = [];
  private flushTimer?: NodeJS.Timeout;
  private flushPromise: Promise<void> = Promise.resolve();
  private partCounter = 0;

  public constructor(options: TraceArchiveWriterOptions) {
    this.directory = expandHome(options.directory);
    this.flushBatchSize = options.flushBatchSize;
    this.logger = options.logger;
  }

  public append(trace: RouteTrace): void {
    this.buffer.push(trace);

    if (this.buffer.length >= this.flushBatchSize) {
      this.enqueueFlush();
      return;
    }

    this.ensureFlushTimer();
  }

  public async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    this.enqueueFlush();
    await this.flushPromise;
  }

  private ensureFlushTimer() {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.enqueueFlush();
    }, flushDelayMs);
  }

  private enqueueFlush() {
    this.flushPromise = this.flushPromise
      .then(async () => {
        await this.flushPending();
      })
      .catch((error) => {
        this.logger?.error({ error }, "Trace Parquet archive flush failed");
      });
  }

  private async flushPending(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const batch = this.buffer.splice(0, this.buffer.length);
    const groupedByDate = new Map<string, RouteTrace[]>();

    for (const trace of batch) {
      const dateKey = trace.timestamp.slice(0, 10);
      const group = groupedByDate.get(dateKey) ?? [];
      group.push(trace);
      groupedByDate.set(dateKey, group);
    }

    for (const [dateKey, traces] of groupedByDate.entries()) {
      const directory = join(this.directory, `date=${dateKey}`);
      mkdirSync(directory, { recursive: true });

      const filePath = join(directory, `part-${Date.now()}-${this.partCounter++}.parquet`);
      const writer = await parquet.ParquetWriter.openFile(archiveSchema, filePath);

      try {
        for (const trace of traces) {
          await writer.appendRow(toArchiveRow(trace));
        }
      } finally {
        await writer.close();
      }
    }
  }
}
