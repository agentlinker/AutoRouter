import type { RouterState } from "../state/routerState.js";

import { RuntimeConfigProjector, type RuntimeProjectorOptions } from "./runtimeConfigProjector.js";
import { DEFAULT_RUNTIME_STATUS_SETTINGS } from "./runtimeStatus.js";
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
    runtimeStatusSettings: state.runtimeStatusSettings ?? DEFAULT_RUNTIME_STATUS_SETTINGS,
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
