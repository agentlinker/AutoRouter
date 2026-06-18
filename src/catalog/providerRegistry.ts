import type {
  AccountConfig,
  EndpointConfig,
  PlatformConfig,
  PrivacyLevel,
  RouterConfig,
  TrustLevel,
  UsageTrust
} from "../config/schema.js";
import type {
  AccountRuntimeState,
  EndpointRuntimeState,
  PlatformRuntimeState
} from "../state/routerState.js";

function normalizeTrustLevel(value: TrustLevel | undefined): TrustLevel {
  return value ?? "low";
}

function normalizePrivacyLevel(value: PrivacyLevel | undefined): PrivacyLevel {
  return value ?? "public_only";
}

function normalizeUsageTrust(value: UsageTrust | undefined): UsageTrust {
  return value ?? "low";
}

function isAccountAvailable(account: AccountConfig): boolean {
  if (!account.enabled) {
    return false;
  }

  if (account.account_type === "local_model") {
    return true;
  }

  if (!account.api_key_env) {
    return false;
  }

  return Boolean(process.env[account.api_key_env]);
}

function mapPlatform(
  platformId: string,
  platform: PlatformConfig
): PlatformRuntimeState {
  return {
    id: platformId,
    display_name: platform.display_name,
    trust_level: normalizeTrustLevel(platform.trust_level),
    privacy_level: normalizePrivacyLevel(platform.privacy_level),
    usage_trust: normalizeUsageTrust(platform.usage_trust)
  };
}

function mapEndpoint(
  endpointId: string,
  endpoint: EndpointConfig
): EndpointRuntimeState {
  return {
    id: endpointId,
    platform_id: endpoint.platform,
    protocol: endpoint.protocol,
    enabled: endpoint.enabled,
    health: "unknown",
    recent_error_count: 0
  };
}

function mapAccounts(
  endpointId: string,
  accounts: AccountConfig[]
): AccountRuntimeState[] {
  return accounts.map((account) => ({
    id: account.id,
    endpoint_id: endpointId,
    account_type: account.account_type,
    enabled: account.enabled,
    available: isAccountAvailable(account),
    recent_error_count: 0,
    quota: account.quota
  }));
}

export function buildProviderRegistry(config: RouterConfig): {
  platforms: PlatformRuntimeState[];
  endpoints: EndpointRuntimeState[];
  accounts: AccountRuntimeState[];
} {
  const platforms: PlatformRuntimeState[] = [];
  const endpoints: EndpointRuntimeState[] = [];
  const accounts: AccountRuntimeState[] = [];

  for (const [platformId, platformConfig] of Object.entries(config.platforms)) {
    platforms.push(mapPlatform(platformId, platformConfig));
  }

  for (const [endpointId, endpointConfig] of Object.entries(config.endpoints)) {
    endpoints.push(mapEndpoint(endpointId, endpointConfig));
    accounts.push(...mapAccounts(endpointId, endpointConfig.accounts));
  }

  return { platforms, endpoints, accounts };
}
