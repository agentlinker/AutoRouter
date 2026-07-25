import type pino from "pino";

import type { PriceTable } from "../catalog/priceTable.js";
import type { RouterConfig } from "../config/schema.js";
import type { AdapterRegistry } from "../providers/registry.js";
import type { StickySessionStore } from "../routing/stickySession.js";
import type { TraceStore } from "../trace/traceStore.js";

export interface PlatformRuntimeState {
  id: string;
  protocol: string;
}

export interface ProviderRuntimeState {
  id: string;
  display_name: string;
  trust_level: string;
  privacy_level: string;
  usage_trust: string;
  runtime_status?: "normal" | "disabled" | "rate_limited" | "abnormal";
  status_reason?: string;
  status_message?: string;
  status_cooldown_until?: string | null;
}

export interface ModelRuntimeStatusState {
  provider_key: string;
  model_key: string;
  runtime_status: "normal" | "disabled" | "rate_limited" | "abnormal";
  status_reason?: string | null;
  status_message?: string | null;
  status_cooldown_until?: string | null;
  rate_limit_strike: number;
  recent_error_count: number;
}

export interface EndpointRuntimeState {
  id: string;
  provider_id: string;
  platform_id: string;
  adapter: string;
  base_url: string;
  enabled: boolean;
  capabilities: {
    streaming: boolean;
    tools: boolean;
    json_mode: boolean;
  };
  health: "unknown" | "healthy" | "degraded" | "down";
  recent_error_count: number;
}

export interface AccountRuntimeState {
  id: string;
  endpoint_id: string;
  account_type: string;
  enabled: boolean;
  available: boolean;
  disabled_reason?: string;
  disabled_message?: string;
  recent_error_count: number;
  quota?: {
    monthly_usd_limit?: number;
    remaining_usd?: number;
    reset_at?: string;
  };
}

export interface RouterState {
  config: RouterConfig;
  logger: pino.Logger;
  platforms: PlatformRuntimeState[];
  providers: ProviderRuntimeState[];
  endpoints: EndpointRuntimeState[];
  accounts: AccountRuntimeState[];
  modelStatuses?: Record<string, ModelRuntimeStatusState>;
  runtimeStatusSettings?: import("../runtime/runtimeStatus.js").RuntimeStatusSettings;
  priceTable: PriceTable;
  adapters: AdapterRegistry;
  stickySessions: StickySessionStore;
  traceStore: TraceStore;
}
