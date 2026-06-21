import type {
  ModelDefinitionConfig,
  RouteCandidateConfig,
  RouteConfig,
  RouterConfig
} from "../config/schema.js";

export interface CatalogModelEntry {
  id: string;
  object: "model";
  owned_by: string;
}

export interface ResolvedRoute extends RouteConfig {
  id: string;
}

export interface ResolvedModelDefinition extends ModelDefinitionConfig {
  id: string;
}

export interface CandidateReference {
  routeId: string;
  account: string;
  modelId: string;
  endpoint: string;
  model: string;
}

export interface ResolvedRequestTarget {
  mode: "provider_model" | "auto_model" | "bare_model" | "route_alias";
  requested: string;
  normalized: string;
  candidates: CandidateReference[];
}

export class ModelCatalog {
  private readonly routes: Map<string, ResolvedRoute>;
  private readonly models: Map<string, ResolvedModelDefinition>;
  private readonly logicalModels: Map<string, ResolvedModelDefinition[]>;
  private readonly providerIds: Set<string>;

  public constructor(private readonly config: RouterConfig) {
    this.routes = new Map(
      Object.entries(config.routes).map(([routeId, routeConfig]) => [
        routeId,
        { id: routeId, ...routeConfig }
      ])
    );
    this.models = new Map(
      Object.entries(config.models).map(([modelId, modelConfig]) => [
        modelId,
        { id: modelId, ...modelConfig }
      ])
    );
    this.logicalModels = new Map();
    this.providerIds = new Set(Object.keys(config.providers));

    for (const model of this.models.values()) {
      const entries = this.logicalModels.get(model.model_name) ?? [];
      entries.push(model);
      this.logicalModels.set(model.model_name, entries);
    }
  }

  public resolveRoute(routeId: string): ResolvedRoute | null {
    return this.routes.get(routeId) ?? null;
  }

  public resolveModel(modelId: string): ResolvedModelDefinition | null {
    return this.models.get(modelId) ?? null;
  }

  public listEntries(): CatalogModelEntry[] {
    const entries = new Map<string, CatalogModelEntry>();

    for (const routeId of this.routes.keys()) {
      entries.set(routeId, {
        id: routeId,
        object: "model",
        owned_by: "autorouter"
      });
    }

    for (const [modelId, modelDefinition] of this.models.entries()) {
      entries.set(modelDefinition.model_name, {
        id: modelDefinition.model_name,
        object: "model",
        owned_by: "autorouter"
      });
      entries.set(modelId, {
        id: modelId,
        object: "model",
        owned_by: modelDefinition.endpoint
      });
    }

    return [...entries.values()];
  }

  public resolveRequestTarget(modelSelector: string): ResolvedRequestTarget | null {
    const autoScoped = this.resolveAutoScopedModel(modelSelector);
    if (autoScoped) {
      return autoScoped;
    }

    const providerScoped = this.resolveProviderScopedModel(modelSelector);
    if (providerScoped) {
      return providerScoped;
    }

    const route = this.resolveRoute(modelSelector);
    if (route) {
      return {
        mode: "route_alias",
        requested: modelSelector,
        normalized: modelSelector,
        candidates: route.candidates.map((candidate) =>
          this.expandCandidate(route.id, candidate)
        )
      };
    }

    const bareModelCandidates = this.resolveBareModelCandidates(modelSelector);
    if (bareModelCandidates.length > 0) {
      return {
        mode: "bare_model",
        requested: modelSelector,
        normalized: `auto/${modelSelector}`,
        candidates: bareModelCandidates
      };
    }

    return null;
  }

  public getCandidates(modelSelector: string): CandidateReference[] {
    return this.resolveRequestTarget(modelSelector)?.candidates ?? [];
  }

  private resolveProviderScopedModel(
    modelSelector: string
  ): ResolvedRequestTarget | null {
    const separatorIndex = modelSelector.indexOf("/");
    if (separatorIndex <= 0) {
      return null;
    }

    const providerId = modelSelector.slice(0, separatorIndex);
    if (providerId === "auto" || !this.providerIds.has(providerId)) {
      return null;
    }

    const requestedModel = modelSelector.slice(separatorIndex + 1);
    const matchedModels = [...this.models.values()].filter((model) => {
      if (this.config.endpoints[model.endpoint]?.provider !== providerId) {
        return false;
      }

      return (
        model.id === modelSelector ||
        model.id === `${providerId}/${requestedModel}` ||
        model.model_name === requestedModel
      );
    });

    return {
      mode: "provider_model",
      requested: modelSelector,
      normalized: modelSelector,
      candidates: this.expandConcreteModels(modelSelector, matchedModels)
    };
  }

  private resolveAutoScopedModel(
    modelSelector: string
  ): ResolvedRequestTarget | null {
    const separatorIndex = modelSelector.indexOf("/");
    if (separatorIndex <= 0) {
      return null;
    }

    const providerSelector = modelSelector.slice(0, separatorIndex);
    if (providerSelector !== "auto") {
      return null;
    }

    const requestedModel = modelSelector.slice(separatorIndex + 1);
    const logicalModels = this.logicalModels.get(requestedModel) ?? [];

    return {
      mode: "auto_model",
      requested: modelSelector,
      normalized: modelSelector,
      candidates: this.expandConcreteModels(modelSelector, logicalModels)
    };
  }

  private resolveBareModelCandidates(modelSelector: string): CandidateReference[] {
    const exactModel = this.resolveModel(modelSelector);
    if (exactModel) {
      return this.expandConcreteModels(modelSelector, [exactModel]);
    }

    const logicalModels = this.logicalModels.get(modelSelector) ?? [];
    return this.expandConcreteModels(modelSelector, logicalModels);
  }

  private expandConcreteModels(
    routeId: string,
    models: ResolvedModelDefinition[]
  ): CandidateReference[] {
    const candidates: CandidateReference[] = [];

    for (const model of models) {
      for (const [accountId, account] of Object.entries(this.config.accounts)) {
        if (account.endpoint !== model.endpoint) {
          continue;
        }

        candidates.push({
          routeId,
          account: accountId,
          modelId: model.id,
          endpoint: model.endpoint,
          model: model.model_name
        });
      }
    }

    return candidates;
  }

  private expandCandidate(
    routeId: string,
    candidate: RouteCandidateConfig
  ): CandidateReference {
    const modelDefinition = this.resolveModel(candidate.model);
    if (!modelDefinition) {
      return {
        routeId,
        account: candidate.account,
        modelId: candidate.model,
        endpoint: "unknown",
        model: candidate.model
      };
    }

    return {
      routeId,
      account: candidate.account,
      modelId: candidate.model,
      endpoint: modelDefinition.endpoint,
      model: modelDefinition.model_name
    };
  }
}
