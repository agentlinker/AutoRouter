import type {
  AccountConfig,
  EndpointConfig,
  PlatformConfig,
  ProviderConfig,
  PrivacyLevel,
  RouterConfig,
  TrustLevel,
  UsageTrust
} from "../config/schema.js";
import type {
  AccountRuntimeState,
  EndpointRuntimeState,
  PlatformRuntimeState,
  ProviderRuntimeState
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

  if (!account.credential_env) {
    return false;
  }

  return Boolean(process.env[account.credential_env]);
}

function mapPlatform(
  platformId: string,
  platform: PlatformConfig
): PlatformRuntimeState {
  return {
    id: platformId,
    protocol: platform.protocol
  };
}

function mapProvider(
  providerId: string,
  provider: ProviderConfig
): ProviderRuntimeState {
  return {
    id: providerId,
    display_name: provider.display_name,
    trust_level: normalizeTrustLevel(provider.trust_level),
    privacy_level: normalizePrivacyLevel(provider.privacy_level),
    usage_trust: normalizeUsageTrust(provider.usage_trust)
  };
}

function mapEndpoint(
  endpointId: string,
  endpoint: EndpointConfig
): EndpointRuntimeState {
  return {
    id: endpointId,
    provider_id: endpoint.provider,
    platform_id: endpoint.platform,
    adapter: endpoint.adapter,
    base_url: endpoint.base_url,
    enabled: endpoint.enabled,
    capabilities: endpoint.capabilities,
    health: "unknown",
    recent_error_count: 0
  };
}

function mapAccounts(
  accounts: Record<string, AccountConfig>
): AccountRuntimeState[] {
  return Object.entries(accounts).map(([accountId, account]) => ({
    id: accountId,
    endpoint_id: account.endpoint,
    account_type: account.account_type,
    enabled: account.enabled,
    available: isAccountAvailable(account),
    recent_error_count: 0,
    quota: account.quota
  }));
}

export function buildProviderRegistry(config: RouterConfig): {
  platforms: PlatformRuntimeState[];
  providers: ProviderRuntimeState[];
  endpoints: EndpointRuntimeState[];
  accounts: AccountRuntimeState[];
} {
  const platforms: PlatformRuntimeState[] = [];
  const providers: ProviderRuntimeState[] = [];
  const endpoints: EndpointRuntimeState[] = [];
  const accounts = mapAccounts(config.accounts);

  for (const [platformId, platformConfig] of Object.entries(config.platforms)) {
    platforms.push(mapPlatform(platformId, platformConfig));
  }

  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    providers.push(mapProvider(providerId, providerConfig));
  }

  for (const [endpointId, endpointConfig] of Object.entries(config.endpoints)) {
    endpoints.push(mapEndpoint(endpointId, endpointConfig));
  }

  return { platforms, providers, endpoints, accounts };
}
