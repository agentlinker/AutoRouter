import type { RouterState } from "../state/routerState.js";

import { RuntimeConfigProjector, type RuntimeProjectorOptions } from "./runtimeConfigProjector.js";
import type { RuntimeManagerLike, RuntimeSnapshot } from "./runtimeTypes.js";
import { CredentialStore } from "./credentialStore.js";
import { ModelCatalog } from "../catalog/modelCatalog.js";

export class RuntimeManager implements RuntimeManagerLike {
  private readonly projector: RuntimeConfigProjector;
  private snapshot: RuntimeSnapshot;

  public constructor(options: RuntimeProjectorOptions) {
    this.projector = new RuntimeConfigProjector(options);
    this.snapshot = this.projector.project();
  }

  public getSnapshot(): RuntimeSnapshot {
    return this.snapshot;
  }

  public async reload(): Promise<RuntimeSnapshot> {
    this.snapshot = this.projector.project();
    return this.snapshot;
  }
}

export function createStaticRuntimeManager(state: RouterState): RuntimeManagerLike {
  const snapshot: RuntimeSnapshot = {
    ...state,
    modelStatuses: state.modelStatuses ?? {},
    runtimeStatusSettings: state.runtimeStatusSettings ?? {
      error_threshold: 10,
      rate_limit_backoff_seconds: [30, 60, 120, 300, 600, 3600, 86400],
      permanent_after_final_backoff: true,
      clear_counters_on_success: true,
      auth_disables_provider: true
    },
    modelCatalog: new ModelCatalog(state.config),
    credentialStore: new CredentialStore(new Map())
  };

  return {
    getSnapshot() {
      return snapshot;
    },
    async reload() {
      return snapshot;
    }
  };
}
