import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

import { mergeObjects } from "../utils/mergeObjects.js";
import { HttpError } from "../utils/httpErrors.js";
import { routerConfigSchema, type RouterConfig } from "./schema.js";

type ConfigSource = Record<string, unknown>;

interface ShorthandProviderAccountInput {
  id: string;
  account_type?: "api_key" | "local_model";
  credential_env?: string;
  enabled?: boolean;
  quota?: {
    monthly_usd_limit?: number;
    remaining_usd?: number;
    reset_at?: string;
  };
}

interface ShorthandProviderModelInput {
  id: string;
  model_name: string;
  context_window?: number;
  capabilities?: {
    streaming?: boolean;
    tools?: boolean;
    json_mode?: boolean;
  };
  pricing?: {
    input_per_1m?: number;
    output_per_1m?: number;
    cached_input_per_1m?: number;
    source?: "official" | "openrouter" | "manual" | "estimated";
    confidence?: "low" | "medium" | "high";
  };
}

interface ShorthandProviderEndpointInput {
  protocol: string;
  adapter: string;
  base_url: string;
  capabilities?: {
    streaming?: boolean;
    tools?: boolean;
    json_mode?: boolean;
  };
  accounts?: ShorthandProviderAccountInput[];
  models?: ShorthandProviderModelInput[];
}

interface ShorthandProviderInput {
  display_name?: string;
  trust_level?: "low" | "medium" | "high";
  privacy_level?: "public_only" | "normal" | "private";
  usage_trust?: "low" | "medium" | "high";
  protocol?: string;
  adapter?: string;
  base_url?: string;
  capabilities?: {
    streaming?: boolean;
    tools?: boolean;
    json_mode?: boolean;
  };
  accounts?: ShorthandProviderAccountInput[];
  models?: ShorthandProviderModelInput[];
  endpoints?: Record<string, ShorthandProviderEndpointInput>;
}

function expandHome(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return join(homedir(), filePath.slice(2));
  }

  return filePath;
}

function readConfigFile(filePath: string): ConfigSource {
  const resolvedPath = resolve(expandHome(filePath));
  if (!existsSync(resolvedPath)) {
    return {};
  }

  const fileContent = readFileSync(resolvedPath, "utf8");
  const parsed = YAML.parse(fileContent) as ConfigSource | null;
  return parsed ?? {};
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizeProviders(rawProviders: Record<string, unknown>): ConfigSource {
  const normalizedPlatforms: Record<string, unknown> = {};
  const normalizedProviders: Record<string, unknown> = {};
  const normalizedEndpoints: Record<string, unknown> = {};
  const normalizedAccounts: Record<string, unknown> = {};
  const normalizedModels: Record<string, unknown> = {};

  for (const [providerId, providerValue] of Object.entries(rawProviders)) {
    const provider = providerValue as ShorthandProviderInput;
    normalizedProviders[providerId] = {
      display_name: provider.display_name ?? providerId,
      trust_level: provider.trust_level ?? "low",
      privacy_level: provider.privacy_level ?? "public_only",
      usage_trust: provider.usage_trust ?? "low"
    };

    const explicitEndpoints = provider.endpoints ?? null;
    if (explicitEndpoints) {
      for (const [endpointKey, endpoint] of Object.entries(explicitEndpoints)) {
        const endpointId = `${providerId}/${endpointKey}`;
        normalizedPlatforms[endpoint.protocol] = {
          protocol: endpoint.protocol
        };
        normalizedEndpoints[endpointId] = {
          provider: providerId,
          platform: endpoint.protocol,
          adapter: endpoint.adapter,
          base_url: endpoint.base_url,
          capabilities: endpoint.capabilities ?? {}
        };

        for (const account of endpoint.accounts ?? []) {
          normalizedAccounts[`${providerId}/${account.id}`] = {
            endpoint: endpointId,
            account_type: account.account_type ?? "api_key",
            credential_env: account.credential_env,
            enabled: account.enabled ?? true,
            quota: account.quota
          };
        }

        for (const model of endpoint.models ?? []) {
          normalizedModels[`${providerId}/${model.id}`] = {
            endpoint: endpointId,
            model_name: model.model_name,
            context_window: model.context_window,
            capabilities: model.capabilities ?? {},
            pricing: model.pricing
          };
        }
      }

      continue;
    }

    if (!provider.protocol || !provider.adapter || !provider.base_url) {
      continue;
    }

    const endpointId = `${providerId}/default`;
    normalizedPlatforms[provider.protocol] = {
      protocol: provider.protocol
    };
    normalizedEndpoints[endpointId] = {
      provider: providerId,
      platform: provider.protocol,
      adapter: provider.adapter,
      base_url: provider.base_url,
      capabilities: provider.capabilities ?? {}
    };

    for (const account of provider.accounts ?? []) {
      normalizedAccounts[`${providerId}/${account.id}`] = {
        endpoint: endpointId,
        account_type: account.account_type ?? "api_key",
        credential_env: account.credential_env,
        enabled: account.enabled ?? true,
        quota: account.quota
      };
    }

    for (const model of provider.models ?? []) {
      normalizedModels[`${providerId}/${model.id}`] = {
        endpoint: endpointId,
        model_name: model.model_name,
        context_window: model.context_window,
        capabilities: model.capabilities ?? {},
        pricing: model.pricing
      };
    }
  }

  return {
    platforms: normalizedPlatforms,
    providers: normalizedProviders,
    endpoints: normalizedEndpoints,
    accounts: normalizedAccounts,
    models: normalizedModels
  };
}

function normalizeRoutes(rawRoutes: Record<string, unknown>): ConfigSource {
  const normalizedRoutes: Record<string, unknown> = {};

  for (const [routeId, routeValue] of Object.entries(rawRoutes)) {
    const route = routeValue as {
      policy: string;
      candidates: Array<
        | { account: string; model: string }
        | { provider: string; account: string; model: string }
      >;
    };

    normalizedRoutes[routeId] = {
      policy: route.policy,
      candidates: route.candidates.map((candidate) => {
        if ("provider" in candidate) {
          return {
            account: `${candidate.provider}/${candidate.account}`,
            model: `${candidate.provider}/${candidate.model}`
          };
        }

        return candidate;
      })
    };
  }

  return normalizedRoutes;
}

function normalizePolicies(rawPolicies: Record<string, unknown>): ConfigSource {
  const normalizedPolicies: Record<string, unknown> = {};

  for (const [policyId, policyValue] of Object.entries(rawPolicies)) {
    const policy = toRecord(policyValue);
    const thresholds = toRecord(policy.thresholds);
    const weights = toRecord(policy.weights);

    normalizedPolicies[policyId] = {
      thresholds: {
        min_trust_level:
          thresholds.min_trust_level ?? policy.min_trust_level ?? "low",
        allow_public_only_provider:
          thresholds.allow_public_only_provider ?? policy.allow_public_only_provider ?? false,
        require_tools: thresholds.require_tools ?? false,
        require_json_mode: thresholds.require_json_mode ?? false,
        min_context_window: thresholds.min_context_window
      },
      weights: {
        health: weights.health ?? 1,
        trust: weights.trust ?? 1,
        cost: weights.cost ?? 0,
        quality: weights.quality ?? 0,
        context: weights.context ?? 0,
        tools: weights.tools ?? 0,
        sticky: weights.sticky ?? (policy.sticky_session ? 1 : 0),
        error_penalty: weights.error_penalty ?? 1,
        quota_penalty: weights.quota_penalty ?? 1
      },
      min_trust_level: policy.min_trust_level ?? thresholds.min_trust_level ?? "low",
      allow_public_only_provider:
        policy.allow_public_only_provider ?? thresholds.allow_public_only_provider ?? false,
      fallback_enabled: policy.fallback_enabled ?? true,
      sticky_session: policy.sticky_session ?? false
    };
  }

  return normalizedPolicies;
}

function normalizeConfigShape(rawConfig: ConfigSource): ConfigSource {
  const providersBlock = toRecord(rawConfig.providers);
  const routesBlock = toRecord(rawConfig.routes);
  const policiesBlock = toRecord(rawConfig.policies);
  const platformsBlock = toRecord(rawConfig.platforms);
  const endpointsBlock = toRecord(rawConfig.endpoints);
  const accountsBlock = toRecord(rawConfig.accounts);
  const modelsBlock = toRecord(rawConfig.models);
  const traceBlock = toRecord(rawConfig.trace);
  const traceArchiveBlock = toRecord(traceBlock.archive);

  const normalizedProviderBlocks = normalizeProviders(providersBlock);
  const normalizedRoutes =
    Object.keys(routesBlock).length > 0 ? normalizeRoutes(routesBlock) : {};
  const normalizedPolicies =
    Object.keys(policiesBlock).length > 0 ? normalizePolicies(policiesBlock) : {};

  const rest = { ...rawConfig };
  delete rest.providers;
  delete rest.platforms;
  delete rest.endpoints;
  delete rest.accounts;
  delete rest.models;
  delete rest.routes;
  delete rest.policies;

  return {
    ...rest,
    trace: {
      ...traceBlock,
      hot_retention_days: traceBlock.hot_retention_days ?? 7,
      archive: {
        format: traceArchiveBlock.format ?? "parquet",
        directory: traceArchiveBlock.directory ?? traceBlock.directory ?? "./data/traces",
        flush_batch_size: traceArchiveBlock.flush_batch_size ?? 100
      }
    },
    platforms: mergeObjects({}, platformsBlock, toRecord(normalizedProviderBlocks.platforms)),
    providers: toRecord(normalizedProviderBlocks.providers),
    endpoints: mergeObjects({}, endpointsBlock, toRecord(normalizedProviderBlocks.endpoints)),
    accounts: mergeObjects({}, accountsBlock, toRecord(normalizedProviderBlocks.accounts)),
    models: mergeObjects({}, modelsBlock, toRecord(normalizedProviderBlocks.models)),
    routes: normalizedRoutes,
    policies: normalizedPolicies
  };
}

export function validateConfig(config: RouterConfig): RouterConfig {
  for (const [endpointId, endpoint] of Object.entries(config.endpoints)) {
    if (!config.providers[endpoint.provider]) {
      throw new HttpError(
        500,
        "invalid_config",
        `Endpoint ${endpointId} references missing provider ${endpoint.provider}`
      );
    }

    if (!config.platforms[endpoint.platform]) {
      throw new HttpError(
        500,
        "invalid_config",
        `Endpoint ${endpointId} references missing platform ${endpoint.platform}`
      );
    }
  }

  for (const [accountId, account] of Object.entries(config.accounts)) {
    if (!config.endpoints[account.endpoint]) {
      throw new HttpError(
        500,
        "invalid_config",
        `Account ${accountId} references missing endpoint ${account.endpoint}`
      );
    }
  }

  for (const [modelId, model] of Object.entries(config.models)) {
    if (!config.endpoints[model.endpoint]) {
      throw new HttpError(
        500,
        "invalid_config",
        `Model ${modelId} references missing endpoint ${model.endpoint}`
      );
    }
  }

  for (const [routeId, route] of Object.entries(config.routes)) {
    for (const candidate of route.candidates) {
      if (!config.accounts[candidate.account]) {
        throw new HttpError(
          500,
          "invalid_config",
          `Route ${routeId} references missing account ${candidate.account}`
        );
      }

      if (!config.models[candidate.model]) {
        throw new HttpError(
          500,
          "invalid_config",
          `Route ${routeId} references missing model ${candidate.model}`
        );
      }
    }
  }

  return config;
}

export function parseConfigSource(source: ConfigSource): RouterConfig {
  const normalizedInput = normalizeConfigShape(source);
  const config = routerConfigSchema.parse(normalizedInput);
  return validateConfig(config);
}

export interface LoadConfigOptions {
  cwd?: string;
  override?: ConfigSource;
  globalConfigPath?: string;
  projectConfigPath?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): RouterConfig {
  const cwd = options.cwd ?? process.cwd();
  const globalConfigPath =
    options.globalConfigPath ?? join(cwd, "config/config.yaml");
  const projectConfigPath =
    options.projectConfigPath ?? join(cwd, "config/config.yaml");

  const merged = mergeObjects(
    {},
    readConfigFile(globalConfigPath),
    readConfigFile(projectConfigPath),
    options.override ?? {}
  );
  return parseConfigSource(merged);
}
