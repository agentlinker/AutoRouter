export interface TraceCandidate {
  route_id?: string;
  endpoint: string;
  platform: string;
  provider?: string;
  account: string;
  model_id?: string;
  model: string;
  reason?: string;
  score?: number;
  sticky?: boolean;
}

export interface TraceAttempt extends TraceCandidate {
  status: "success" | "failed";
  error?: string;
  retryable?: boolean;
  /** Total attempt duration in ms. */
  latency_ms?: number;
  /** Time to first token/response body in ms. */
  first_token_ms?: number;
  /** Exact URL used for this upstream attempt. */
  actual_upstream_url?: string;
  /** Whether the client-facing stream reached its protocol terminal event. */
  stream_completed?: boolean;
  /** Last protocol event observed before completion or failure. */
  stream_terminal_event?: string | null;
  required_protocol?: string;
  actual_protocol?: string;
  operation?: string;
  failure_kind?: string;
  failure_scope?: string;
  failure_confidence?: string;
  status_code?: number;
  provider_code?: string;
  provider_type?: string;
}

export interface TraceFeedbackLabel {
  feedback_label?: string | null;
  feedback_source?: string | null;
  feedback_at?: string | null;
  training_split?: "train" | "eval" | "test" | null;
  tags?: string[];
}

export interface RouteTrace {
  trace_id: string;
  timestamp: string;
  session_id: string | null;
  request: {
    model: string;
    normalized_model: string;
    prompt_hash: string;
    stream: boolean;
    has_tools: boolean;
    privacy_level: string;
    context_tokens_est: number;
    /** 调用方通过 selector 后缀显式要求的上下文窗口（如 `[1m]` → 1000000） */
    requested_context_window?: number | null;
    required_protocol?: string | null;
  };
  candidates: TraceCandidate[];
  filtered: TraceCandidate[];
  selected: {
    route_id?: string;
    endpoint: string;
    platform: string;
    provider?: string;
    account_hash: string;
    model_id?: string;
    model: string;
    score?: number;
  } | null;
  policy_hits: string[];
  execution: {
    status: "success" | "success_with_fallback" | "failed";
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
  attempts?: TraceAttempt[];
  fallbacks: TraceCandidate[];
  feedback?: TraceFeedbackLabel | null;
}
