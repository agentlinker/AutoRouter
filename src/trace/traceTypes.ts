export interface TraceCandidate {
  endpoint: string;
  platform?: string;
  account: string;
  model: string;
  reason?: string;
}

export interface RouteTrace {
  trace_id: string;
  timestamp: string;
  session_id: string | null;
  request: {
    model: string;
    prompt_hash: string;
    stream: boolean;
    has_tools: boolean;
    privacy_level: string;
  };
  candidates: TraceCandidate[];
  filtered: TraceCandidate[];
  selected: {
    endpoint: string;
    platform: string;
    account_hash: string;
    model: string;
  } | null;
  policy_hits: string[];
  execution: {
    status: "success" | "failed";
    latency_ms: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    error?: string;
  };
  cost: {
    estimated_usd: number | null;
    actual_usd: number | null;
    price_confidence: "low" | "medium" | "high" | "unknown";
  };
  fallbacks: TraceCandidate[];
}
