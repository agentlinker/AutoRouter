import type pino from "pino";

import type { PriceTable } from "../catalog/priceTable.js";
import type { RouterConfig } from "../config/schema.js";
import type { AdapterRegistry } from "../providers/registry.js";
import type { StickySessionStore } from "../routing/stickySession.js";
import type { RuntimeStatus } from "../runtime/runtimeStatus.js";
import type { TraceStore } from "../trace/traceStore.js";

export interface PlatformRuntimeState {
  id: string;
  protocol: string;
}

export interface ProviderRuntimeState {
  id: string;
  display_name: string;
  priority?: number;
  trust_level: string;
  privacy_level: string;
  usage_trust: string;
}

export interface ModelRuntimeStatusState {
  provider_key: string;
  model_key: string;
  runtime_status: RuntimeStatus;
  status_reason?: string | null;
  status_message?: string | null;
  status_cooldown_until?: string | null;
  rate_limit_strike: number;
  recent_error_count: number;
}

export function accountModelStatusKey(accountId: string, modelKey: string): string {
  return `account:${accountId}|model:${modelKey}`;
}

export interface EndpointRuntimeState {
  id: string;
  provider_id: string;
  platform_id: string;
  base_url: string;
  custom_headers?: Record<string, string>;
  enabled: boolean;
  capabilities: {
    streaming: boolean;
    tools: boolean;
    json_mode: boolean;
  };
  recent_error_count: number;
}

export interface AccountRuntimeState {
  id: string;
  endpoint_id: string;
  provider_key?: string;
  endpoint_key?: string;
  account_key?: string;
  api_key_hint?: string;
  account_type: string;
  enabled: boolean;
  available: boolean;
  runtime_status?: RuntimeStatus;
  status_reason?: string | null;
  status_message?: string | null;
  status_cooldown_until?: string | null;
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
