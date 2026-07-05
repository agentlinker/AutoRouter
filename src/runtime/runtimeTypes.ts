import type { ModelCatalog } from "../catalog/modelCatalog.js";
import type { PriceTable } from "../catalog/priceTable.js";
import type { RouterConfig } from "../config/schema.js";
import type { AdapterRegistry } from "../providers/registry.js";
import type { StickySessionStore } from "../routing/stickySession.js";
import type {
  AccountRuntimeState,
  EndpointRuntimeState,
  PlatformRuntimeState,
  ProviderRuntimeState
} from "../state/routerState.js";
import type { TraceStore } from "../trace/traceStore.js";
import type pino from "pino";

import type { CredentialStore } from "./credentialStore.js";

export interface RuntimeSnapshot {
  config: RouterConfig;
  logger: pino.Logger;
  platforms: PlatformRuntimeState[];
  providers: ProviderRuntimeState[];
  endpoints: EndpointRuntimeState[];
  accounts: AccountRuntimeState[];
  priceTable: PriceTable;
  adapters: AdapterRegistry;
  stickySessions: StickySessionStore;
  traceStore: TraceStore;
  modelCatalog: ModelCatalog;
  credentialStore: CredentialStore;
}

export interface RuntimeManagerLike {
  getSnapshot(): RuntimeSnapshot;
  reload(): Promise<RuntimeSnapshot>;
}
