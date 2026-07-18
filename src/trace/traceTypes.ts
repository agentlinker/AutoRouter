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
  feedback?: TraceFeedbackLabel | null;
}
