import { desc, eq, lt, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import {
  routeTracesTable,
  type RouteTraceRow,
  type schema
} from "../db/schema.js";
import type { RouteTrace } from "../trace/traceTypes.js";

type Db = BetterSQLite3Database<typeof schema>;

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function rowToTrace(row: RouteTraceRow): RouteTrace {
  return {
    trace_id: row.traceId,
    timestamp: row.timestamp,
    session_id: row.sessionId,
    request: {
      model: row.requestedModel,
      normalized_model: row.normalizedModel,
      prompt_hash: row.promptHash,
      stream: row.stream,
      has_tools: row.hasTools,
      privacy_level: row.privacyLevel,
      context_tokens_est: row.contextTokensEst
    },
    candidates: parseJson(row.candidatesJson),
    filtered: parseJson(row.filteredJson),
    selected: row.selectedEndpoint
      ? {
          route_id: row.selectedRouteId ?? undefined,
          endpoint: row.selectedEndpoint,
          platform: row.selectedPlatform ?? "unknown",
          provider: row.selectedProvider ?? undefined,
          account_hash: row.selectedAccountHash ?? "unknown",
          model_id: row.selectedModelId ?? undefined,
          model: row.selectedModel ?? row.normalizedModel,
          score: row.selectedScore ?? undefined
        }
      : null,
    policy_hits: parseJson(row.policyHitsJson),
    execution: {
      status: row.executionStatus as RouteTrace["execution"]["status"],
      latency_ms: row.latencyMs,
      input_tokens: row.inputTokens || undefined,
      output_tokens: row.outputTokens || undefined,
      total_tokens: row.totalTokens || undefined,
      error: row.executionError ?? undefined
    },
    cost: {
      estimated_usd: row.estimatedCostUsd ?? null,
      actual_usd: row.actualCostUsd ?? null,
      price_confidence: row.priceConfidence as RouteTrace["cost"]["price_confidence"]
    },
    fallbacks: parseJson(row.fallbacksJson),
    feedback:
      row.feedbackLabel ||
      row.feedbackSource ||
      row.feedbackAt ||
      row.trainingSplit ||
      row.tagsJson
        ? {
            feedback_label: row.feedbackLabel ?? null,
            feedback_source: row.feedbackSource ?? null,
            feedback_at: row.feedbackAt ?? null,
            training_split: (row.trainingSplit as "train" | "eval" | "test" | null) ?? null,
            tags: row.tagsJson ? parseJson<string[]>(row.tagsJson) : []
          }
        : null
  };
}

export interface UsageProviderSummary {
  provider_key: string;
  request_count: number;
  success_count: number;
  failure_count: number;
  avg_latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface TokenProviderSummary {
  provider_key: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface TokenModelSummary {
  provider_key: string | null;
  model: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export class RouteTraceRepository {
  public constructor(private readonly db: Db) {}

  public append(trace: RouteTrace): void {
    const inputTokens = trace.execution.input_tokens ?? 0;
    const outputTokens = trace.execution.output_tokens ?? 0;
    const totalTokens = trace.execution.total_tokens ?? inputTokens + outputTokens;

    this.db.insert(routeTracesTable).values({
      traceId: trace.trace_id,
      timestamp: trace.timestamp,
      sessionId: trace.session_id,
      requestedModel: trace.request.model,
      normalizedModel: trace.request.normalized_model,
      promptHash: trace.request.prompt_hash,
      stream: trace.request.stream,
      hasTools: trace.request.has_tools,
      privacyLevel: trace.request.privacy_level,
      contextTokensEst: trace.request.context_tokens_est,
      selectedRouteId: trace.selected?.route_id ?? null,
      selectedEndpoint: trace.selected?.endpoint ?? null,
      selectedPlatform: trace.selected?.platform ?? null,
      selectedProvider: trace.selected?.provider ?? null,
      selectedAccountHash: trace.selected?.account_hash ?? null,
      selectedModelId: trace.selected?.model_id ?? null,
      selectedModel: trace.selected?.model ?? null,
      selectedScore: trace.selected?.score ?? null,
      policyHitsJson: JSON.stringify(trace.policy_hits),
      candidatesJson: JSON.stringify(trace.candidates),
      filteredJson: JSON.stringify(trace.filtered),
      fallbacksJson: JSON.stringify(trace.fallbacks),
      executionStatus: trace.execution.status,
      latencyMs: trace.execution.latency_ms,
      inputTokens,
      outputTokens,
      totalTokens,
      executionError: trace.execution.error ?? null,
      estimatedCostUsd: trace.cost.estimated_usd,
      actualCostUsd: trace.cost.actual_usd,
      priceConfidence: trace.cost.price_confidence,
      feedbackLabel: trace.feedback?.feedback_label ?? null,
      feedbackSource: trace.feedback?.feedback_source ?? null,
      feedbackAt: trace.feedback?.feedback_at ?? null,
      trainingSplit: trace.feedback?.training_split ?? null,
      tagsJson: trace.feedback?.tags ? JSON.stringify(trace.feedback.tags) : null,
      createdAt: nowIso()
    }).run();
  }

  public latest(): RouteTrace | null {
    const row = this.db.select().from(routeTracesTable)
      .orderBy(desc(routeTracesTable.timestamp), desc(routeTracesTable.id))
      .limit(1)
      .get();

    return row ? rowToTrace(row) : null;
  }

  public getByTraceId(traceId: string): RouteTrace | null {
    const row = this.db.select().from(routeTracesTable)
      .where(eq(routeTracesTable.traceId, traceId))
      .get();

    return row ? rowToTrace(row) : null;
  }

  public listRecent(limit = 100): RouteTrace[] {
    return this.db.select().from(routeTracesTable)
      .orderBy(desc(routeTracesTable.timestamp), desc(routeTracesTable.id))
      .limit(limit)
      .all()
      .map(rowToTrace);
  }

  public deleteOlderThan(cutoffIso: string): number {
    const result = this.db.delete(routeTracesTable)
      .where(lt(routeTracesTable.timestamp, cutoffIso))
      .run();

    return result.changes;
  }

  public getUsageTotals() {
    const result = this.db.select({
      requests: sql<number>`count(*)`,
      successCount: sql<number>`sum(case when ${routeTracesTable.executionStatus} = 'success' then 1 else 0 end)`,
      failureCount: sql<number>`sum(case when ${routeTracesTable.executionStatus} = 'failed' then 1 else 0 end)`,
      avgLatencyMs: sql<number>`coalesce(round(avg(${routeTracesTable.latencyMs})), 0)`,
      inputTokens: sql<number>`coalesce(sum(${routeTracesTable.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${routeTracesTable.outputTokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${routeTracesTable.totalTokens}), 0)`,
      uniqueProviders: sql<number>`count(distinct ${routeTracesTable.selectedProvider})`,
      uniqueModels: sql<number>`count(distinct coalesce(${routeTracesTable.selectedModel}, ${routeTracesTable.normalizedModel}))`
    }).from(routeTracesTable).get();

    return {
      requests: Number(result?.requests ?? 0),
      success_count: Number(result?.successCount ?? 0),
      failure_count: Number(result?.failureCount ?? 0),
      success_rate:
        Number(result?.requests ?? 0) > 0
          ? Number(result?.successCount ?? 0) / Number(result?.requests ?? 0)
          : 0,
      avg_latency_ms: Number(result?.avgLatencyMs ?? 0),
      input_tokens: Number(result?.inputTokens ?? 0),
      output_tokens: Number(result?.outputTokens ?? 0),
      total_tokens: Number(result?.totalTokens ?? 0),
      unique_providers: Number(result?.uniqueProviders ?? 0),
      unique_models: Number(result?.uniqueModels ?? 0)
    };
  }

  public listUsageByProvider(): UsageProviderSummary[] {
    return this.db.select({
      providerKey: sql<string>`coalesce(${routeTracesTable.selectedProvider}, 'unassigned')`,
      requestCount: sql<number>`count(*)`,
      successCount: sql<number>`sum(case when ${routeTracesTable.executionStatus} = 'success' then 1 else 0 end)`,
      failureCount: sql<number>`sum(case when ${routeTracesTable.executionStatus} = 'failed' then 1 else 0 end)`,
      avgLatencyMs: sql<number>`coalesce(round(avg(${routeTracesTable.latencyMs})), 0)`,
      inputTokens: sql<number>`coalesce(sum(${routeTracesTable.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${routeTracesTable.outputTokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${routeTracesTable.totalTokens}), 0)`
    }).from(routeTracesTable)
      .groupBy(sql`coalesce(${routeTracesTable.selectedProvider}, 'unassigned')`)
      .orderBy(sql`count(*) desc`)
      .all()
      .map((row) => ({
        provider_key: row.providerKey,
        request_count: Number(row.requestCount ?? 0),
        success_count: Number(row.successCount ?? 0),
        failure_count: Number(row.failureCount ?? 0),
        avg_latency_ms: Number(row.avgLatencyMs ?? 0),
        input_tokens: Number(row.inputTokens ?? 0),
        output_tokens: Number(row.outputTokens ?? 0),
        total_tokens: Number(row.totalTokens ?? 0)
      }));
  }

  public getTokenTotals() {
    const result = this.db.select({
      inputTokens: sql<number>`coalesce(sum(${routeTracesTable.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${routeTracesTable.outputTokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${routeTracesTable.totalTokens}), 0)`
    }).from(routeTracesTable).get();

    return {
      input_tokens: Number(result?.inputTokens ?? 0),
      output_tokens: Number(result?.outputTokens ?? 0),
      total_tokens: Number(result?.totalTokens ?? 0)
    };
  }

  public listTokensByProvider(): TokenProviderSummary[] {
    return this.db.select({
      providerKey: sql<string>`coalesce(${routeTracesTable.selectedProvider}, 'unassigned')`,
      requestCount: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${routeTracesTable.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${routeTracesTable.outputTokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${routeTracesTable.totalTokens}), 0)`
    }).from(routeTracesTable)
      .groupBy(sql`coalesce(${routeTracesTable.selectedProvider}, 'unassigned')`)
      .orderBy(sql`coalesce(sum(${routeTracesTable.totalTokens}), 0) desc`)
      .all()
      .map((row) => ({
        provider_key: row.providerKey,
        request_count: Number(row.requestCount ?? 0),
        input_tokens: Number(row.inputTokens ?? 0),
        output_tokens: Number(row.outputTokens ?? 0),
        total_tokens: Number(row.totalTokens ?? 0)
      }));
  }

  public listTokensByModel(limit = 20): TokenModelSummary[] {
    return this.db.select({
      providerKey: routeTracesTable.selectedProvider,
      model: sql<string>`coalesce(${routeTracesTable.selectedModel}, ${routeTracesTable.normalizedModel})`,
      requestCount: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${routeTracesTable.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${routeTracesTable.outputTokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${routeTracesTable.totalTokens}), 0)`
    }).from(routeTracesTable)
      .groupBy(
        routeTracesTable.selectedProvider,
        sql`coalesce(${routeTracesTable.selectedModel}, ${routeTracesTable.normalizedModel})`
      )
      .orderBy(sql`coalesce(sum(${routeTracesTable.totalTokens}), 0) desc`)
      .limit(limit)
      .all()
      .map((row) => ({
        provider_key: row.providerKey,
        model: row.model,
        request_count: Number(row.requestCount ?? 0),
        input_tokens: Number(row.inputTokens ?? 0),
        output_tokens: Number(row.outputTokens ?? 0),
        total_tokens: Number(row.totalTokens ?? 0)
      }));
  }
}
