import type { RouteTrace } from "./traceTypes.js";
import type {
  RouteTraceRepository,
  TokenModelSummary,
  TokenProviderSummary,
  UsageProviderSummary
} from "../repositories/routeTraceRepository.js";
import type { TraceArchiveWriter } from "./traceArchiveWriter.js";

const cleanupEveryAppends = 100;

export interface TraceStoreOptions {
  hotRetentionDays?: number;
  archiveWriter?: TraceArchiveWriter;
  logger?: {
    error: (input: unknown, message?: string) => void;
  };
}

export class TraceStore {
  private readonly hotRetentionDays: number;
  private readonly archiveWriter?: TraceArchiveWriter;
  private readonly logger?: TraceStoreOptions["logger"];
  private appendCount = 0;

  public constructor(
    private readonly repository: RouteTraceRepository,
    options: TraceStoreOptions = {}
  ) {
    this.hotRetentionDays = options.hotRetentionDays ?? 7;
    this.archiveWriter = options.archiveWriter;
    this.logger = options.logger;
    this.pruneExpired();
  }

  public append(trace: RouteTrace) {
    this.repository.append(trace);
    this.archiveWriter?.append(trace);
    this.appendCount += 1;

    if (this.appendCount % cleanupEveryAppends === 0) {
      this.pruneExpired();
    }
  }

  public latest(): RouteTrace | null {
    return this.repository.latest();
  }

  public getByTraceId(traceId: string): RouteTrace | null {
    return this.repository.getByTraceId(traceId);
  }

  public listRecent(limit = 100): RouteTrace[] {
    return this.repository.listRecent(limit);
  }

  public getUsageTotals() {
    return this.repository.getUsageTotals();
  }

  public listUsageByProvider(): UsageProviderSummary[] {
    return this.repository.listUsageByProvider();
  }

  public getTokenTotals() {
    return this.repository.getTokenTotals();
  }

  public listTokensByProvider(): TokenProviderSummary[] {
    return this.repository.listTokensByProvider();
  }

  public listTokensByModel(limit = 20): TokenModelSummary[] {
    return this.repository.listTokensByModel(limit);
  }

  public pruneExpired(): number {
    const cutoffDate = new Date();
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - this.hotRetentionDays);
    const deleted = this.repository.deleteOlderThan(cutoffDate.toISOString());

    return deleted;
  }

  public async close(): Promise<void> {
    try {
      await this.archiveWriter?.close();
    } catch (error) {
      this.logger?.error({ error }, "Failed to close trace archive writer");
    }
  }
}
