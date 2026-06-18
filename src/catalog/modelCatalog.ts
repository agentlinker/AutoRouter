import type {
  ModelAliasConfig,
  ModelCandidateConfig,
  RouterConfig
} from "../config/schema.js";

export interface ResolvedModelAlias extends ModelAliasConfig {
  id: string;
}

export interface CatalogModelEntry {
  id: string;
  object: "model";
  owned_by: string;
}

export class ModelCatalog {
  private readonly aliases: Map<string, ResolvedModelAlias>;

  public constructor(private readonly config: RouterConfig) {
    this.aliases = new Map(
      Object.entries(config.models).map(([aliasId, aliasConfig]) => [
        aliasId,
        { id: aliasId, ...aliasConfig }
      ])
    );
  }

  public resolve(modelId: string): ResolvedModelAlias | null {
    return this.aliases.get(modelId) ?? null;
  }

  public listEntries(): CatalogModelEntry[] {
    const directModels = new Map<string, CatalogModelEntry>();

    for (const [aliasId, aliasConfig] of this.aliases.entries()) {
      directModels.set(aliasId, {
        id: aliasId,
        object: "model",
        owned_by: "autorouter"
      });

      for (const candidate of aliasConfig.candidates) {
        const key = `${candidate.endpoint}/${candidate.model}`;
        if (!directModels.has(key)) {
          directModels.set(key, {
            id: key,
            object: "model",
            owned_by: candidate.endpoint
          });
        }
      }
    }

    return [...directModels.values()];
  }

  public getCandidates(modelId: string): ModelCandidateConfig[] {
    const alias = this.resolve(modelId);
    if (alias) {
      return alias.candidates;
    }

    const [endpoint, ...rest] = modelId.split("/");
    if (rest.length === 0 || !this.config.endpoints[endpoint]) {
      return [];
    }

    const endpointConfig = this.config.endpoints[endpoint];
    const fallbackAccount = endpointConfig.accounts[0];
    return [
      {
        endpoint,
        account: fallbackAccount.id,
        model: rest.join("/")
      }
    ];
  }
}
