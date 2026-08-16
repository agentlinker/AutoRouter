import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  BarChart3,
  BookOpen,
  Cpu,
  DatabaseZap,
  Edit3,
  ExternalLink,
  FlaskConical,
  KeyRound,
  Lock,
  LogOut,
  Network,
  Plus,
  RefreshCw,
  Route,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useFieldArray, useForm, type Control } from "react-hook-form";
import { z } from "zod";

import {
  createProvider,
  createProviderAccount,
  deleteProvider,
  deleteProviderAccount,
  getProvider,
  listProviderTemplates,
  listProviders,
  mergeCheckProvider,
  promoteProviderPriority,
  setProviderEnabled,
  syncProvider,
  syncProviderAccount,
  testProviderModel,
  updateProvider,
  updateProviderAccount,
  updateProviderModelCapabilities,
  type CreateProviderPayload,
  type ProviderDetails,
  type ProviderListParams,
  type ProviderModel,
  type ProviderModelTestResult,
  type ProviderSortBy,
  type ProviderTemplate,
  type SortDirection,
  type UpdateProviderPayload
} from "../api/providers.js";
import { AppDialog } from "../components/Dialog.js";
import { Sidebar } from "../components/Sidebar.js";
import { providerKindLabel } from "../providerLabels.js";
import { readSidebarCollapsed, writeSidebarCollapsed } from "../utils/sidebarCollapse.js";

export const providerTokenStorageKey = "autorouter_admin_token";

// Form 内部状态：custom_headers 是 key-value 数组
interface ProviderFormData {
  provider_key: string;
  display_name: string;
  endpoints: Array<{
    endpoint_key: string;
    protocol: "openai" | "anthropic";
    base_url: string;
    custom_headers?: Array<{ key: string; value: string }>;
  }>;
  website_url?: string;
  api_key?: string;
  provider_kind?: "official" | "relay" | "custom";
  model_availability_scope?: "shared_by_provider" | "per_account";
  priority: string;
  template_id?: string;
  accounts: Array<{
    account_key: string;
    endpoint_key: string;
    api_key: string;
    expires_at: string;
    remaining_usd: string;
    enabled: boolean;
  }>;
}

const providerFormSchema = z.object({
  provider_key: z.string().trim().min(1, "请填写 Provider Key"),
  display_name: z.string().trim().min(1, "请填写 Display Name"),
  endpoints: z.array(z.object({
    endpoint_key: z.string().trim().min(1, "请填写 Endpoint Key"),
    protocol: z.enum(["openai", "anthropic"]),
    base_url: z.string().trim().url("Base URL 必须是有效网址"),
    custom_headers: z.array(z.object({
      key: z.string(),
      value: z.string()
    })).optional()
  }).strict()).min(1, "至少添加一个 Endpoint"),
  website_url: z
    .string()
    .trim()
    .optional()
    .refine((value) => !value || z.string().url().safeParse(value).success, {
      message: "官网地址必须是有效网址"
    }),
  api_key: z.string().optional(),
  provider_kind: z.enum(["official", "relay", "custom"]).optional(),
  model_availability_scope: z.enum(["shared_by_provider", "per_account"]).optional(),
  priority: z.string().refine((value) => value === "" || /^\d+$/.test(value), {
    message: "优先级必须是非负整数"
  }),
  template_id: z.string().optional(),
  accounts: z.array(z.object({
    account_key: z.string(),
    endpoint_key: z.string(),
    api_key: z.string(),
    expires_at: z.string(),
    remaining_usd: z.string(),
    enabled: z.boolean()
  })).min(1, "至少添加一个 Account")
}).strict();

function toDatetimeLocal(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function RequiredMark() {
  return <span className="required-mark">*</span>;
}

function runtimeStatusLabel(status?: string | null) {
  switch (status) {
    case "disabled":
      return "鉴权异常";
    case "rate_limited":
      return "限流中";
    case "cooling_down":
      return "错误冷却中";
    case "abnormal":
      return "失败过多";
    case "normal":
    case undefined:
    case null:
      return "正常";
    default:
      return status;
  }
}

function runtimeStatusBadgeClass(status?: string | null) {
  return status === "normal" || !status ? "badge success" : "badge warning";
}

function isRuntimeNormal(status?: string | null) {
  return status === "normal" || !status;
}

function isCooldownActive(cooldownUntil?: string | null) {
  if (!cooldownUntil) {
    return false;
  }
  const until = Date.parse(cooldownUntil);
  return Number.isFinite(until) && until > Date.now();
}

/**
 * 与后端 runtimeStatus.ts 的判定保持一致：
 * disabled / abnormal 需人工恢复；rate_limited 与 cooling_down 冷却到期即可再调度。
 */
function isRuntimeStatusSchedulable(input: {
  runtime_status?: string | null;
  status_reason?: string | null;
  status_cooldown_until?: string | null;
}) {
  if (isRuntimeNormal(input.runtime_status)) {
    return true;
  }
  if (input.runtime_status === "disabled" || input.runtime_status === "abnormal") {
    return false;
  }
  if (input.runtime_status === "rate_limited" || input.runtime_status === "cooling_down") {
    if (input.status_reason?.endsWith("_permanent")) {
      return false;
    }
    return !isCooldownActive(input.status_cooldown_until);
  }
  return false;
}

function isAccountSchedulable(account: NonNullable<ProviderDetails["accounts"]>[number]) {
  if (!account.enabled) {
    return false;
  }
  if (account.expires_at) {
    const expiresAt = Date.parse(account.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return false;
    }
  }
  if (
    account.quota &&
    typeof account.quota.remaining_usd === "number" &&
    account.quota.remaining_usd <= 0
  ) {
    return false;
  }
  return isRuntimeStatusSchedulable(account);
}

function isProviderAvailable(provider: ProviderDetails) {
  const hasSchedulableAccount =
    (provider.available_account_count ??
      provider.accounts?.filter(isAccountSchedulable).length ??
      (provider.key_hint ? 1 : 0)) > 0;
  return provider.enabled && hasSchedulableAccount;
}

function isProviderModelAvailable(model: {
  enabled?: boolean;
  runtime_status?: string | null;
  status_reason?: string | null;
  status_cooldown_until?: string | null;
}) {
  return model.enabled !== false && isRuntimeStatusSchedulable(model);
}

function isProviderModelSchedulable(provider: ProviderDetails, model: ProviderModel) {
  return isProviderAvailable(provider) && isProviderModelAvailable(model);
}

function providerModelUnavailableReason(provider: ProviderDetails, model: ProviderModel) {
  if (!provider.enabled) {
    return "Provider 已停用";
  }
  if ((provider.available_account_count ?? 0) <= 0) {
    return "没有可调度的 API Key";
  }
  if (!isProviderModelAvailable(model)) {
    return runtimeStatusDetail(model) || "模型不可用";
  }
  return "";
}

function formatQuotaSummary(quota: NonNullable<ProviderDetails["accounts"]>[number]["quota"]) {
  if (!quota) {
    return "未设置";
  }
  const parts: string[] = [];
  if (typeof quota.remaining_usd === "number") {
    parts.push(`剩余 $${quota.remaining_usd}`);
  }
  if (typeof quota.monthly_usd_limit === "number") {
    parts.push(`月限 $${quota.monthly_usd_limit}`);
  }
  if (typeof quota.remaining_requests === "number") {
    parts.push(`剩余请求 ${quota.remaining_requests}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "未设置";
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "未知";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function runtimeStatusDetail(input: {
  status_reason?: string | null;
  status_message?: string | null;
  status_cooldown_until?: string | null;
}) {
  const code = input.status_reason ? `异常码: ${input.status_reason}` : null;
  const message = input.status_message ? `错误信息: ${input.status_message}` : null;
  const cooldown = input.status_cooldown_until
    ? `冷却至: ${new Date(input.status_cooldown_until).toLocaleString()}`
    : null;
  const parts = [
    code,
    message,
    cooldown
  ].filter(Boolean);
  return parts.join("\n");
}

export function SwitchControl(props: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`switch-control ${props.disabled ? "disabled" : ""}`}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.label}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">{props.checked ? "已启用" : "已停用"}</span>
    </label>
  );
}

export function getStoredToken() {
  return localStorage.getItem(providerTokenStorageKey) ?? "";
}

const defaultProviderListParams: ProviderListParams = {
  sort_by: "priority",
  sort_dir: "desc",
  page: 1,
  page_size: 20
};

function providersQueryKey(token: string, params?: ProviderListParams) {
  return params ? ["providers", token, params] as const : ["providers", token] as const;
}

function providerQueryKey(token: string, providerKey: string) {
  return ["provider", token, providerKey] as const;
}

function useAdminToken() {
  const [token, setToken] = useState(getStoredToken);

  function saveToken(nextToken: string) {
    localStorage.setItem(providerTokenStorageKey, nextToken);
    setToken(nextToken);
  }

  function clearToken() {
    localStorage.removeItem(providerTokenStorageKey);
    setToken("");
  }

  return { token, saveToken, clearToken };
}

function useProviders(token: string, params: ProviderListParams = defaultProviderListParams) {
  return useQuery({
    queryKey: providersQueryKey(token, params),
    queryFn: () => listProviders(token, params),
    enabled: token.length > 0
  });
}

function useProvider(token: string, providerKey: string) {
  const providerQuery = useQuery({
    queryKey: providerQueryKey(token, providerKey),
    queryFn: () => getProvider(token, providerKey),
    enabled: token.length > 0 && providerKey.length > 0
  });

  return { ...providerQuery, provider: providerQuery.data ?? null };
}

const providerSortOptions: Array<{ value: ProviderSortBy; label: string }> = [
  { value: "priority", label: "优先级" },
  { value: "updated_at", label: "修改时间" },
  { value: "created_at", label: "添加时间" }
];

export const navItems = [
  {
    label: "Providers",
    icon: Network,
    to: "/providers",
    title: "Provider 管理",
    description: "配置不同协议的 Provider，自动整理可用模型。"
  },
  {
    label: "Catalog",
    icon: BookOpen,
    to: "/catalog",
    title: "Catalog 模型",
    description: "按逻辑模型管理共享元数据和 Provider 实例覆盖。"
  },
  {
    label: "API Keys",
    icon: KeyRound,
    to: "/api-keys",
    title: "API Key 管理",
    description: "查看系统令牌状态和各 Provider 凭据摘要。"
  },
  {
    label: "Usage",
    icon: BarChart3,
    to: "/usage",
    title: "使用记录",
    description: "查看最近请求的调用情况、成功率和 Provider 分布。"
  },
  {
    label: "Trace",
    icon: Route,
    to: "/trace",
    title: "Trace 追踪",
    description: "查看为什么命中这个 Provider 和模型。"
  },
  {
    label: "Tokens",
    icon: Activity,
    to: "/tokens",
    title: "Token 统计",
    description: "按 Provider 和模型查看最近 token 消耗。"
  },
  {
    label: "Policies",
    icon: ScrollText,
    to: "/policies",
    title: "Policies",
    description: "检查阈值、权重和 route 绑定关系。"
  },
  {
    label: "Settings",
    icon: Settings,
    to: "/settings",
    title: "系统设置",
    description: "查看当前运行配置、路径和运行态摘要。"
  }
] as const;

export function AdminRoot() {
  const [tokenInput, setTokenInput] = useState(getStoredToken);
  const [authError, setAuthError] = useState<string | null>(null);
  // 惰性初始化：localStorage 只在首次挂载时读一次
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const { token, saveToken, clearToken } = useAdminToken();
  const queryClient = useQueryClient();
  const providersQuery = useProviders(token);
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname
  });

  useEffect(() => {
    if (providersQuery.isError) {
      setAuthError(providersQuery.error.message);
    }
  }, [providersQuery.error, providersQuery.isError]);

  const isAuthenticated = token.length > 0 && providersQuery.isSuccess;
  const activeNavItem = useMemo(
    () =>
      navItems.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`)) ??
      navItems[0],
    [pathname]
  );

  function authenticate() {
    const nextToken = tokenInput.trim();
    if (!nextToken) {
      setAuthError("请输入 Admin Token");
      return;
    }

    setAuthError(null);
    saveToken(nextToken);
  }

  function lockConsole() {
    clearToken();
    setTokenInput("");
    setAuthError(null);
    queryClient.removeQueries({ queryKey: ["providers"] });
    void navigate({ to: "/providers" });
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeSidebarCollapsed(next);
      return next;
    });
  }

  if (!isAuthenticated) {
    return (
      <main className="auth-shell">
        <section className="auth-view">
          <div className="brand auth-brand">
            <div className="brand-mark">
              <Cpu size={22} />
            </div>
            <div>
              <h1>AutoRouter Admin</h1>
              <p>统一管理本地模型入口、调用策略与运行轨迹。</p>
            </div>
          </div>

          <div className="auth-card">
            <div className="card-header">
              <span className="eyebrow">
                <ShieldCheck size={14} />
                Secure Console
              </span>
              <h2>管理员验证</h2>
              <p>输入管理 Token 后进入控制台。</p>
            </div>

            <label className="field">
              <span>
                Admin Token <RequiredMark />
              </span>
              <input
                value={tokenInput}
                type="password"
                placeholder="输入 admin token"
                autoComplete="current-password"
                onChange={(event) => setTokenInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    authenticate();
                  }
                }}
              />
            </label>

            <button className="primary-action" type="button" onClick={authenticate}>
              <Lock size={16} />
              进入管理台
            </button>
            <p className={`status ${authError ? "error" : ""}`}>
              {authError ?? (providersQuery.isFetching ? "正在验证..." : "等待验证")}
            </p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className={`console-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <Sidebar items={navItems} collapsed={sidebarCollapsed} onToggle={toggleSidebar} />

      <section className="workspace">
        <header className="page-header">
          <div>
            <span className="eyebrow">
              <Sparkles size={14} />
              {activeNavItem.label}
            </span>
            <h1>{activeNavItem.title}</h1>
            <p>{activeNavItem.description}</p>
          </div>
          <div className="topbar-actions">
            <span className="badge success">
              <ShieldCheck size={13} />
              已验证
            </span>
            <button className="ghost-action" type="button" onClick={lockConsole}>
              <LogOut size={16} />
              锁定
            </button>
          </div>
        </header>

        <Outlet />
      </section>
    </main>
  );
}

export function ProviderListPage() {
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const [listParams, setListParams] = useState<ProviderListParams>(defaultProviderListParams);
  const providersQuery = useProviders(token, listParams);
  const providers = providersQuery.data?.data ?? [];
  const listMeta = providersQuery.data?.meta;
  const totalProviders = listMeta?.total ?? providers.length;
  const totalPages = Math.max(1, Math.ceil(totalProviders / listParams.page_size));
  const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0);
  const availableProviders =
    listMeta?.available_total ?? providers.filter(isProviderAvailable).length;
  const availableModels = providers.reduce(
    (sum, provider) =>
      sum + provider.models.filter((model) => isProviderModelSchedulable(provider, model)).length,
    0
  );

  return (
    <section className="page-panel">
      <section className="stats-grid provider-stats-grid">
        <div className="stat-card">
          <Network size={18} />
          <div>
            <span>Providers</span>
            <strong>{totalProviders}</strong>
            <small>可用 {availableProviders}</small>
          </div>
        </div>
        <div className="stat-card">
          <DatabaseZap size={18} />
          <div>
            <span>Models</span>
            <strong>{totalModels}</strong>
            <small>可用 {availableModels}</small>
          </div>
        </div>
      </section>

      <div className="list-header">
        <div>
          <h2>Provider 列表</h2>
        </div>
        <div className="page-actions">
          <label className="compact-field">
            <span>排序</span>
            <select
              value={listParams.sort_by}
              onChange={(event) =>
                setListParams((current) => ({
                  ...current,
                  sort_by: event.target.value as ProviderSortBy,
                  page: 1
                }))
              }
            >
              {providerSortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost-action"
            type="button"
            onClick={() =>
              setListParams((current) => ({
                ...current,
                sort_dir: current.sort_dir === "desc" ? "asc" : "desc",
                page: 1
              }))
            }
          >
            {listParams.sort_dir === "desc" ? "降序" : "升序"}
          </button>
          <label className="compact-field">
            <span>每页</span>
            <select
              value={listParams.page_size}
              onChange={(event) =>
                setListParams((current) => ({
                  ...current,
                  page_size: Number(event.target.value),
                  page: 1
                }))
              }
            >
              {[10, 20, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost-action"
            type="button"
            onClick={() => void providersQuery.refetch()}
          >
            <RefreshCw size={16} />
            刷新
          </button>
          <Link to="/providers/new" className="primary-action">
            <Plus size={16} />
            新增 Provider
          </Link>
        </div>
      </div>

      <ProviderList
        token={token}
        providers={providers}
        onChanged={() => void queryClient.invalidateQueries({ queryKey: providersQueryKey(token) })}
      />
      <div className="pagination-bar provider-pagination">
        <span>
          第 {listParams.page} / {totalPages} 页，共 {totalProviders} 个 Provider
        </span>
        <div className="page-actions">
          <button
            className="ghost-action small-action"
            type="button"
            disabled={listParams.page <= 1}
            onClick={() =>
              setListParams((current) => ({ ...current, page: Math.max(1, current.page - 1) }))
            }
          >
            上一页
          </button>
          <button
            className="ghost-action small-action"
            type="button"
            disabled={listParams.page >= totalPages}
            onClick={() =>
              setListParams((current) => ({
                ...current,
                page: Math.min(totalPages, current.page + 1)
              }))
            }
          >
            下一页
          </button>
        </div>
      </div>
    </section>
  );
}

export function ProviderNewPage() {
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return (
    <ProviderFormPage
      title="新增 Provider"
      help="填写 Provider 信息和多个 Endpoint 后，系统会自动找到可用模型并保存起来。"
      mode="create"
      token={token}
      onDone={() => {
        void queryClient.invalidateQueries({ queryKey: providersQueryKey(token) });
        void navigate({ to: "/providers" });
      }}
    />
  );
}

export function ProviderEditPage() {
  const token = getStoredToken();
  const { providerKey } = useParams({ from: "/providers/$providerKey/edit" });
  const { provider, isLoading } = useProvider(token, providerKey);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  if (isLoading) {
    return <PageLoading />;
  }

  if (!provider) {
    return <NotFoundPanel title="Provider 不存在" />;
  }

  return (
    <ProviderFormPage
      title="编辑 Provider"
      help="可直接增删 Endpoint；保存后会重新检查并同步可用模型。"
      mode="edit"
      token={token}
      provider={provider}
      onDone={() => {
        void queryClient.invalidateQueries({ queryKey: providersQueryKey(token) });
        void queryClient.invalidateQueries({ queryKey: providerQueryKey(token, providerKey) });
        void navigate({ to: "/providers/$providerKey", params: { providerKey } });
      }}
    />
  );
}

export function ProviderDetailPage() {
  const token = getStoredToken();
  const { providerKey } = useParams({ from: "/providers/$providerKey" });
  const { provider, isLoading } = useProvider(token, providerKey);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (action: "sync" | "toggle" | "delete") => {
      if (!provider) {
        return null;
      }

      if (action === "sync") {
        return syncProvider(token, provider.provider_key);
      }

      if (action === "toggle") {
        return setProviderEnabled(token, provider.provider_key, !provider.enabled);
      }

      if (action === "delete") {
        return deleteProvider(token, provider.provider_key);
      }

      return null;
    },
    onSuccess: (_result, action) => {
      void queryClient.invalidateQueries({ queryKey: providersQueryKey(token) });
      void queryClient.invalidateQueries({ queryKey: providerQueryKey(token, providerKey) });
      if (action === "delete") {
        window.location.assign("/admin/providers");
      }
    }
  });
  const modelMutation = useMutation({
    mutationFn: async (input: {
      model_key: string;
      enabled?: boolean;
      supports_streaming?: boolean;
      supports_tools?: boolean;
      supports_json_mode?: boolean;
    }) => {
      if (!provider) {
        throw new Error("Provider not loaded");
      }

      return updateProviderModelCapabilities(token, provider.provider_key, input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providersQueryKey(token) });
      void queryClient.invalidateQueries({ queryKey: providerQueryKey(token, providerKey) });
    }
  });
  if (isLoading) {
    return <PageLoading />;
  }

  if (!provider) {
    return <NotFoundPanel title="Provider 不存在" />;
  }

  return (
    <section className="page-panel detail-page">
      <div className="detail-header">
        <div>
          <span className="eyebrow">
            <Network size={14} />
            Provider Detail
          </span>
          <h2>{provider.display_name}</h2>
          <p className="muted">{provider.provider_key}</p>
        </div>
        <div className="page-actions">
          <Link to="/providers/$providerKey/edit" params={{ providerKey: provider.provider_key }} className="ghost-action">
            <Edit3 size={16} />
            编辑
          </Link>
          <button className="ghost-action" type="button" onClick={() => mutation.mutate("sync")}>
            <RefreshCw size={16} />
            同步模型
          </button>
        </div>
      </div>

      <div className="detail-grid">
        <MetricCard label="模型数量" value={String(provider.models.length)} />
        <MetricCard
          label="Accounts"
          value={`${provider.available_account_count ?? 0}/${provider.account_count ?? provider.accounts?.length ?? 0}`}
        />
      </div>

      <div className="panel detail-card">
        <h3>连接信息</h3>
        <dl>
          <dt>启用</dt>
          <dd>
            <SwitchControl
              checked={provider.enabled}
              disabled={mutation.isPending}
              label={`${provider.display_name} 启用开关`}
              onChange={() => mutation.mutate("toggle")}
            />
          </dd>
          <dt>Provider 类型</dt>
          <dd>{providerKindLabel(provider.provider_kind)}</dd>
          <dt>模型可用性</dt>
          <dd>
            {provider.model_availability_scope === "shared_by_provider"
              ? "按 Provider 共享"
              : "按 Account 独立"}
          </dd>
          <dt>Accounts</dt>
          <dd>
            {provider.account_count ?? provider.accounts?.length ?? 1} keys /
            {" "}
            {provider.available_account_count ??
              provider.accounts?.filter(isAccountSchedulable).length ??
              0}{" "}
            available
          </dd>
          <dt>官网地址</dt>
          <dd>
            {provider.website_url ? (
              <a href={provider.website_url} target="_blank" rel="noreferrer">
                {provider.website_url}
              </a>
            ) : (
              "未填写"
            )}
          </dd>
          <dt>添加时间</dt>
          <dd>{formatDateTime(provider.created_at)}</dd>
          <dt>修改时间</dt>
          <dd>{formatDateTime(provider.updated_at)}</dd>
          <dt>最近同步</dt>
          <dd>{provider.latest_sync?.status ?? "暂无记录"}</dd>
        </dl>
        <div className="model-capability-table endpoint-table">
          <div className="model-capability-header">
            <span>Endpoint</span>
            <span>协议</span>
            <span>状态</span>
            <span>自定义 Headers</span>
          </div>
          {provider.endpoints.map((endpoint) => (
            <div className="model-capability-row" key={endpoint.endpoint_key}>
              <div className="model-name-cell">
                <strong>{endpoint.endpoint_key}</strong>
                <code>{endpoint.base_url}</code>
                {endpoint.custom_headers && Object.keys(endpoint.custom_headers).length > 0 ? (
                  <small className="muted">
                    Headers: {Object.keys(endpoint.custom_headers).join(", ")}
                  </small>
                ) : null}
              </div>
              <span>{endpoint.protocol}</span>
              <span>{endpoint.enabled ? "已启用" : "已停用"}</span>
              <span>{endpoint.custom_headers && Object.keys(endpoint.custom_headers).length > 0 ? "已配置" : "无"}</span>
            </div>
          ))}
        </div>
        <ProviderAccountsPanel
          token={token}
          provider={provider}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: providersQueryKey(token) });
            void queryClient.invalidateQueries({ queryKey: providerQueryKey(token, providerKey) });
          }}
        />
      </div>

      <div className="panel detail-card">
        <h3>模型列表</h3>
        <div className="model-capability-table provider-model-table">
          <div className="model-capability-header">
            <span>模型</span>
            <span>启用</span>
            <span>调度状态</span>
            <span>Streaming</span>
            <span>Tools</span>
            <span>JSON</span>
          </div>
          {provider.models.map((model) => (
            <div className="model-capability-row" key={model.model_key}>
              <div className="model-name-cell">
                <strong>{model.model_name}</strong>
                <code>{model.model_key}</code>
                <span className="badge">{model.endpoint_key}</span>
              </div>
              <SwitchControl
                checked={model.enabled !== false}
                disabled={modelMutation.isPending}
                label={`${model.model_name} 启用开关`}
                onChange={(checked) =>
                  modelMutation.mutate({
                    model_key: model.model_key,
                    enabled: checked
                  })
                }
              />
              <span className={runtimeStatusBadgeClass(model.runtime_status)} title={runtimeStatusDetail(model)}>
                {runtimeStatusLabel(model.runtime_status)}
              </span>
              <CapabilityToggle
                checked={model.supports_streaming}
                disabled={modelMutation.isPending}
                label="Streaming"
                onChange={(checked) =>
                  modelMutation.mutate({
                    model_key: model.model_key,
                    supports_streaming: checked
                  })
                }
              />
              <CapabilityToggle
                checked={model.supports_tools}
                disabled={modelMutation.isPending}
                label="Tools"
                onChange={(checked) =>
                  modelMutation.mutate({
                    model_key: model.model_key,
                    supports_tools: checked
                  })
                }
              />
              <CapabilityToggle
                checked={model.supports_json_mode}
                disabled={modelMutation.isPending}
                label="JSON"
                onChange={(checked) =>
                  modelMutation.mutate({
                    model_key: model.model_key,
                    supports_json_mode: checked
                  })
                }
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CustomHeadersEditor(props: {
  control: Control<ProviderFormData>;
  endpointIndex: number;
}) {
  const { fields, append, remove } = useFieldArray({
    control: props.control,
    name: `endpoints.${props.endpointIndex}.custom_headers` as const
  });

  return (
    <div className="field">
      <div className="field-group-header">
        <span>Custom Headers</span>
        <button
          type="button"
          className="ghost-action small-action"
          onClick={() => append({ key: "", value: "" })}
        >
          <Plus size={14} />
          添加 Header
        </button>
      </div>
      <div className="custom-headers-list">
        {fields.map((field, index) => (
          <div className="custom-header-row" key={field.id}>
            <input
              {...props.control.register(`endpoints.${props.endpointIndex}.custom_headers.${index}.key` as const)}
              placeholder="Header 名称 (如 x-title)"
            />
            <input
              {...props.control.register(`endpoints.${props.endpointIndex}.custom_headers.${index}.value` as const)}
              placeholder="Header 值"
            />
            <button
              type="button"
              className="ghost-action small-action"
              onClick={() => remove(index)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {fields.length === 0 ? <small className="muted">暂无自定义 headers</small> : null}
      </div>
    </div>
  );
}

function CapabilityToggle(props: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="capability-toggle">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.label}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>{props.checked ? "是" : "否"}</span>
    </label>
  );
}

function ProviderFormPage(props: {
  title: string;
  help: string;
  mode: "create" | "edit";
  token: string;
  provider?: ProviderDetails;
  onDone: () => void;
}) {
  const isEditing = props.mode === "edit";
  const [message, setMessage] = useState<{ text: string; mode?: "success" | "error" } | null>(null);

  const [templates, setTemplates] = useState<ProviderTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [mergeDialog, setMergeDialog] = useState<{
    open: boolean;
    matches: Array<{
      provider_key: string;
      display_name: string;
      endpoint_key: string;
      protocol: string;
      base_url: string;
    }>;
    pendingValues: ProviderFormData | null;
  }>({ open: false, matches: [], pendingValues: null });

  const form = useForm<ProviderFormData>({
    resolver: zodResolver(providerFormSchema),
    defaultValues: {
      provider_key: "",
      display_name: "",
      endpoints: [
        {
          endpoint_key: "default",
          protocol: "openai",
          base_url: "",
          custom_headers: []
        }
      ],
      website_url: "",
      accounts: [
        {
          account_key: "default",
          endpoint_key: "",
          api_key: "",
          expires_at: "",
          remaining_usd: "",
          enabled: true
        }
      ],
      provider_kind: "custom",
      model_availability_scope: "per_account",
      priority: "0",
      template_id: ""
    }
  });
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "endpoints"
  });
  const {
    fields: accountFields,
    append: appendAccount,
    remove: removeAccount
  } = useFieldArray({
    control: form.control,
    name: "accounts"
  });

  useEffect(() => {
    const nextEndpoints = props.provider?.endpoints.length
      ? props.provider.endpoints.map((endpoint, index) => ({
          endpoint_key: endpoint.endpoint_key || `endpoint-${index + 1}`,
          protocol: endpoint.protocol as "openai" | "anthropic",
          base_url: endpoint.base_url,
          custom_headers: endpoint.custom_headers
            ? Object.entries(endpoint.custom_headers).map(([key, value]) => ({ key, value }))
            : []
        }))
      : [
          {
            endpoint_key: "default",
            protocol: "openai" as const,
            base_url: "",
            custom_headers: []
          }
        ];

    form.reset({
      provider_key: props.provider?.provider_key ?? "",
      display_name: props.provider?.display_name ?? "",
      endpoints: nextEndpoints,
      website_url: props.provider?.website_url ?? "",
      accounts: props.provider?.accounts?.length
        ? props.provider.accounts.map((account) => ({
            account_key: account.account_key,
            endpoint_key: account.endpoint_key ?? "",
            api_key: "",
            expires_at: toDatetimeLocal(account.expires_at),
            remaining_usd: account.quota?.remaining_usd?.toString() ?? "",
            enabled: account.enabled
          }))
        : [
            {
              account_key: "default",
              endpoint_key: "",
              api_key: "",
              expires_at: "",
              remaining_usd: "",
              enabled: true
            }
          ],
      provider_kind: props.provider?.provider_kind ?? "custom",
      model_availability_scope: props.provider?.model_availability_scope ?? "per_account",
      priority: String(props.provider?.priority ?? 0),
      template_id: ""
    });
    setSelectedTemplateId("");
    setMessage(null);
  }, [form, props.provider]);

  useEffect(() => {
    if (isEditing) {
      return;
    }
    void listProviderTemplates(props.token)
      .then((response) => setTemplates(response.data))
      .catch(() => setTemplates([]));
  }, [isEditing, props.token]);

  async function submitProvider(values: ProviderFormData, options?: { skipMergeCheck?: boolean }) {
    const normalizedEndpoints = values.endpoints.map((endpoint, index) => {
      let customHeaders: Record<string, string> | undefined;
      if (endpoint.custom_headers && endpoint.custom_headers.length > 0) {
        customHeaders = {};
        for (const pair of endpoint.custom_headers) {
          const trimmedKey = pair.key.trim();
          const trimmedValue = pair.value.trim();
          if (trimmedKey) {
            customHeaders[trimmedKey] = trimmedValue;
          }
        }
        if (Object.keys(customHeaders).length === 0) {
          customHeaders = undefined;
        }
      }
      return {
        endpoint_key: endpoint.endpoint_key.trim() || `endpoint-${index + 1}`,
        protocol: endpoint.protocol,
        base_url: endpoint.base_url.trim(),
        custom_headers: customHeaders
      };
    });
    const normalizedAccounts = values.accounts.map((account) => ({
      account_key: account.account_key.trim(),
      endpoint_key: account.endpoint_key || undefined,
      api_key: account.api_key.trim(),
      expires_at: account.expires_at ? new Date(account.expires_at).toISOString() : null,
      quota: account.remaining_usd
        ? { remaining_usd: Number(account.remaining_usd), source: "manual" as const }
        : undefined,
      enabled: account.enabled
    }));

    if (!isEditing && normalizedAccounts.some((account) => !account.account_key || !account.api_key)) {
      throw new Error("请填写每个 Account 的 Account Key 和 API Key");
    }

    const normalized: CreateProviderPayload = {
      provider_key: values.provider_key.trim(),
      display_name: values.display_name.trim(),
      endpoints: normalizedEndpoints,
      website_url: values.website_url?.trim() ?? "",
      api_key: normalizedAccounts[0]?.api_key ?? "",
      accounts: normalizedAccounts,
      provider_kind: values.provider_kind,
      model_availability_scope: values.model_availability_scope,
      priority: values.priority === "" ? 0 : Number(values.priority),
      template_id: values.template_id || undefined
    };

    if (isEditing && props.provider) {
      const payload: UpdateProviderPayload = {
        display_name: normalized.display_name,
        endpoints: normalized.endpoints,
        website_url: normalized.website_url,
        provider_kind: normalized.provider_kind,
        model_availability_scope: normalized.model_availability_scope,
        priority: normalized.priority
      };
      const updated = await updateProvider(props.token, props.provider.provider_key, payload);
      const existingAccounts = new Set((props.provider.accounts ?? []).map((account) => account.account_key));
      for (const account of normalizedAccounts) {
        if (!account.account_key) {
          throw new Error("请填写 Account Key");
        }
        if (existingAccounts.has(account.account_key)) {
          await updateProviderAccount(props.token, props.provider.provider_key, account.account_key, {
            endpoint_key: account.endpoint_key ?? null,
            api_key: account.api_key || undefined,
            expires_at: account.expires_at,
            quota: account.quota,
            enabled: account.enabled
          });
        } else {
          if (!account.api_key) {
            throw new Error(`新增 Account ${account.account_key} 必须填写 API Key`);
          }
          await createProviderAccount(props.token, props.provider.provider_key, {
            account_key: account.account_key,
            endpoint_key: account.endpoint_key,
            api_key: account.api_key,
            expires_at: account.expires_at,
            quota: account.quota,
            enabled: account.enabled
          });
        }
      }
      for (const existingAccount of props.provider.accounts ?? []) {
        if (!normalizedAccounts.some((account) => account.account_key === existingAccount.account_key)) {
          await deleteProviderAccount(props.token, props.provider.provider_key, existingAccount.account_key);
        }
      }
      for (const existingAccount of props.provider.accounts ?? []) {
        if (!normalizedAccounts.some((account) => account.account_key === existingAccount.account_key)) {
          await deleteProviderAccount(props.token, props.provider.provider_key, existingAccount.account_key);
        }
      }
      return updated;
    }

    if (!options?.skipMergeCheck && normalized.endpoints[0]) {
      const first = normalized.endpoints[0];
      const merge = await mergeCheckProvider(props.token, {
        protocol: first.protocol,
        base_url: first.base_url
      });
      if (merge.matches.length > 0) {
        setMergeDialog({
          open: true,
          matches: merge.matches,
          pendingValues: values
        });
        return null;
      }
    }

    return createProvider(props.token, normalized);
  }

  const mutation = useMutation({
    mutationFn: async (values: ProviderFormData) => submitProvider(values),
    onSuccess: (result) => {
      if (!result) {
        return;
      }
      setMessage({
        text: "Provider 已保存，可用模型已更新",
        mode: "success"
      });
      props.onDone();
    },
    onError: (error) => {
      setMessage({
        text: error instanceof Error ? error.message : "保存失败���",
        mode: "error"
      });
    }
  });

  const forceCreateMutation = useMutation({
    mutationFn: async (values: ProviderFormData) =>
      submitProvider(values, { skipMergeCheck: true }),
    onSuccess: (result) => {
      if (!result) {
        return;
      }
      setMergeDialog({ open: false, matches: [], pendingValues: null });
      setMessage({
        text: "Provider 已保存，可用模型已更新",
        mode: "success"
      });
      props.onDone();
    },
    onError: (error) => {
      setMessage({
        text: error instanceof Error ? error.message : "保存失败",
        mode: "error"
      });
    }
  });

  const mergeAccountMutation = useMutation({
    mutationFn: async () => {
      const values = mergeDialog.pendingValues;
      const target = mergeDialog.matches[0];
      if (!values || !target || !values.api_key) {
        throw new Error("缺少合并所需信息");
      }
      return createProviderAccount(props.token, target.provider_key, {
        account_key: `key-${Date.now().toString(36)}`,
        endpoint_key: target.endpoint_key,
        api_key: values.api_key
      });
    },
    onSuccess: () => {
      setMergeDialog({ open: false, matches: [], pendingValues: null });
      setMessage({ text: "已合并到已有 Provider 并添加 API Key", mode: "success" });
      props.onDone();
    },
    onError: (error) => {
      setMessage({
        text: error instanceof Error ? error.message : "合并失败",
        mode: "error"
      });
    }
  });

  const errors = form.formState.errors;
  const endpointsError = form.formState.errors.endpoints;

  return (
    <section className="page-panel form-page">
      <div className="detail-header">
        <div>
          <span className="eyebrow">
            {isEditing ? <Edit3 size={14} /> : <Plus size={14} />}
            {isEditing ? "Edit Provider" : "New Provider"}
          </span>
          <h2>{props.title}</h2>
          <p className="muted">{props.help}</p>
        </div>
        <Link to="/providers" className="ghost-action">
          返回列表
        </Link>
      </div>

      <form className="panel form form-card" onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
        {!isEditing ? (
          <label className="field">
            <span>Provider 模板</span>
            <select
              value={selectedTemplateId}
              onChange={(event) => {
                const templateId = event.target.value;
                setSelectedTemplateId(templateId);
                const template = templates.find((item) => item.template_id === templateId);
                if (!template) {
                  form.setValue("template_id", "");
                  return;
                }
                form.setValue("template_id", template.template_id);
                form.setValue("provider_key", template.suggested_provider_key);
                form.setValue("display_name", template.display_name);
                form.setValue("website_url", template.website_url ?? "");
                form.setValue("provider_kind", template.provider_kind);
                form.setValue("model_availability_scope", template.model_availability_scope);
                form.setValue(
                  "endpoints",
                  template.endpoints.map((endpoint) => ({
                    endpoint_key: endpoint.endpoint_key,
                    protocol: endpoint.protocol,
                    base_url: endpoint.base_url,
                    custom_headers: endpoint.custom_headers
                      ? Object.entries(endpoint.custom_headers).map(([key, value]) => ({ key, value }))
                      : []
                  }))
                );
              }}
            >
              <option value="">自定义创建</option>
              {templates.map((template) => (
                <option key={template.template_id} value={template.template_id}>
                  {template.vendor_name} · {template.display_name}
                  {template.region ? ` (${template.region})` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="field">
          <span>
            Provider Key <RequiredMark />
          </span>
          <input {...form.register("provider_key")} readOnly={isEditing} placeholder="my-provider" />
          {errors.provider_key ? <small>{errors.provider_key.message}</small> : null}
        </label>

        <label className="field">
          <span>
            Display Name <RequiredMark />
          </span>
          <input {...form.register("display_name")} placeholder="My Provider" />
          {errors.display_name ? <small>{errors.display_name.message}</small> : null}
        </label>

        <label className="field">
          <span>官网地址</span>
          <input {...form.register("website_url")} placeholder="https://example.com" />
          {errors.website_url ? <small>{errors.website_url.message}</small> : null}
        </label>

        <label className="field">
          <span>Provider 类型</span>
          <select {...form.register("provider_kind")}>
            <option value="official">官方 (official)</option>
            <option value="relay">中转站 (relay)</option>
            <option value="custom">自定义 (custom)</option>
          </select>
        </label>

        <label className="field">
          <span>模型可用性范围</span>
          <select {...form.register("model_availability_scope")}>
            <option value="shared_by_provider">按 Provider 共享</option>
            <option value="per_account">按 Account 独立</option>
          </select>
        </label>

        <label className="field">
          <span>优先级（可选，默认 0）</span>
          <input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            {...form.register("priority")}
            placeholder="0"
          />
          {errors.priority ? <small>{errors.priority.message}</small> : null}
        </label>

        <div className="field endpoint-group">
          <div className="field-group-header">
            <span>
              Endpoints <RequiredMark />
            </span>
            <button
              type="button"
              className="ghost-action small-action"
              onClick={() =>
                append({
                  endpoint_key: `endpoint-${fields.length + 1}`,
                  protocol: "openai",
                  base_url: "",
                  custom_headers: []
                })
              }
            >
              <Plus size={14} />
              添加 Endpoint
            </button>
          </div>

          <div className="endpoint-editor">
            {fields.map((field, index) => {
              const protocol = form.watch(`endpoints.${index}.protocol`);
              const endpointErrors = errors.endpoints?.[index];

              return (
                <div className="endpoint-editor-row" key={field.id}>
                  <label className="field">
                    <span>Endpoint Key</span>
                    <input {...form.register(`endpoints.${index}.endpoint_key`)} placeholder={`endpoint-${index + 1}`} />
                    {endpointErrors?.endpoint_key ? <small>{endpointErrors.endpoint_key.message}</small> : null}
                  </label>

                  <label className="field">
                    <span>协议类型</span>
                    <select {...form.register(`endpoints.${index}.protocol`)}>
                      <option value="openai">openai</option>
                      <option value="anthropic">anthropic</option>
                    </select>
                    {endpointErrors?.protocol ? <small>{endpointErrors.protocol.message}</small> : null}
                  </label>

                  <label className="field">
                    <span>Base URL</span>
                    <input
                      {...form.register(`endpoints.${index}.base_url`)}
                      placeholder={protocol === "anthropic" ? "https://api.anthropic.com/v1" : "https://example.com/v1"}
                    />
                    {endpointErrors?.base_url ? <small>{endpointErrors.base_url.message}</small> : null}
                  </label>

                  <CustomHeadersEditor control={form.control} endpointIndex={index} />

                  <div className="endpoint-row-actions">
                    <button
                      type="button"
                      className="ghost-action small-action"
                      disabled={fields.length === 1}
                      onClick={() => remove(index)}
                    >
                      <Trash2 size={14} />
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {!Array.isArray(endpointsError) && endpointsError?.message ? <small>{endpointsError.message}</small> : null}
        </div>

        <div className="field account-group">
          <div className="field-group-header">
            <span>
              Accounts / API Keys <RequiredMark />
            </span>
            <button
              type="button"
              className="ghost-action small-action"
              onClick={() =>
                appendAccount({
                  account_key: `key-${accountFields.length + 1}`,
                  endpoint_key: "",
                  api_key: "",
                  expires_at: "",
                  remaining_usd: "",
                  enabled: true
                })
              }
            >
              <Plus size={14} />
              添加 Account
            </button>
          </div>
          <div className="account-editor">
            {accountFields.map((field, index) => (
              <div className="account-editor-row" key={field.id}>
                <label className="field">
                  <span>Account Key</span>
                  <input {...form.register(`accounts.${index}.account_key`)} placeholder={`key-${index + 1}`} />
                </label>
                <label className="field">
                  <span>绑定 Endpoint</span>
                  <select {...form.register(`accounts.${index}.endpoint_key`)}>
                    <option value="">全部 Endpoint</option>
                    {form.watch("endpoints").map((endpoint, endpointIndex) => (
                      <option key={endpointIndex} value={endpoint.endpoint_key}>
                        {endpoint.endpoint_key || "未命名 Endpoint"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>API Key {isEditing ? "（留空不修改）" : ""}</span>
                  <input
                    type="password"
                    {...form.register(`accounts.${index}.api_key`)}
                    placeholder="sk-..."
                  />
                </label>
                <label className="field">
                  <span>过期时间</span>
                  <input
                    type="datetime-local"
                    step="60"
                    {...form.register(`accounts.${index}.expires_at`)}
                    onFocus={(event) => {
                      const input = event.currentTarget;
                      if (typeof input.showPicker === "function") {
                        try {
                          input.showPicker();
                        } catch {
                          // 浏览器可能限制非用户手势触发，保留原生控件行为即可。
                        }
                      }
                    }}
                  />
                </label>
                <label className="field">
                  <span>剩余额度 USD</span>
                  <input {...form.register(`accounts.${index}.remaining_usd`)} placeholder="可选" />
                </label>
                <label className="capability-toggle">
                  <input type="checkbox" {...form.register(`accounts.${index}.enabled`)} />
                  <span>启用</span>
                </label>
                <button
                  type="button"
                  className="ghost-action small-action"
                  disabled={accountFields.length === 1}
                  onClick={() => removeAccount(index)}
                >
                  <Trash2 size={14} />
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="form-actions">
          <button className="primary-action" type="submit" disabled={mutation.isPending}>
            {isEditing ? <Edit3 size={16} /> : <Plus size={16} />}
            {mutation.isPending ? "保存中..." : isEditing ? "保存修改" : "保存并同步"}
          </button>
        </div>
      </form>

      {message ? <p className={`status ${message.mode ?? ""}`}>{message.text}</p> : null}

      <AppDialog
        open={mergeDialog.open}
        tone="info"
        title="检测到可合并的 Provider"
        confirmLabel="关闭"
        onClose={() => setMergeDialog({ open: false, matches: [], pendingValues: null })}
      >
        <p>
          已有 Provider “{mergeDialog.matches[0]?.display_name}” 使用了相同 base_url / 协议。
        </p>
        <p className="muted">
          {mergeDialog.matches[0]?.endpoint_key}: {mergeDialog.matches[0]?.base_url}
        </p>
        <div className="form-actions" style={{ marginTop: 12 }}>
          <button
            className="primary-action"
            type="button"
            disabled={mergeAccountMutation.isPending}
            onClick={() => mergeAccountMutation.mutate()}
          >
            合并并添加 API Key
          </button>
          <button
            className="ghost-action"
            type="button"
            disabled={forceCreateMutation.isPending || !mergeDialog.pendingValues}
            onClick={() => {
              if (mergeDialog.pendingValues) {
                forceCreateMutation.mutate(mergeDialog.pendingValues);
              }
            }}
          >
            仍然新建
          </button>
        </div>
      </AppDialog>
    </section>
  );
}

function ProviderList(props: {
  token: string;
  providers: ProviderDetails[];
  onChanged: () => void;
}) {
  const [testProvider, setTestProvider] = useState<ProviderDetails | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { action: string; provider: ProviderDetails }) => {
      if (input.action === "sync") {
        return syncProvider(props.token, input.provider.provider_key);
      }

      if (input.action === "promote-priority") {
        return promoteProviderPriority(props.token, input.provider.provider_key);
      }

      if (input.action === "toggle") {
        return setProviderEnabled(
          props.token,
          input.provider.provider_key,
          !input.provider.enabled
        );
      }

      if (input.action === "delete") {
        return deleteProvider(props.token, input.provider.provider_key);
      }

      return null;
    },
    onSuccess: props.onChanged
  });

  if (props.providers.length === 0) {
    return (
      <div className="empty-state">
        <div>
          <strong>暂无 Provider</strong>
          <p>添加第一个 provider 后，这里会展示可用模型和连接状态。</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="provider-list">
        {props.providers.map((provider) => (
          <ProviderCard
            key={provider.provider_key}
            provider={provider}
            disabled={mutation.isPending}
            onAction={(action) => mutation.mutate({ action, provider })}
            onTest={() => setTestProvider(provider)}
            token={props.token}
            onPriorityChanged={props.onChanged}
          />
        ))}
      </div>
      {testProvider ? (
        <ProviderModelTestDialog
          key={testProvider.provider_key}
          token={props.token}
          provider={testProvider}
          onChanged={props.onChanged}
          onClose={() => setTestProvider(null)}
        />
      ) : null}
    </>
  );
}

function ProviderModelTestDialog(props: {
  token: string;
  provider: ProviderDetails;
  onChanged: () => void;
  onClose: () => void;
}) {
  const accounts = props.provider.accounts ?? [];
  const [accountKey, setAccountKey] = useState(accounts[0]?.account_key ?? "");
  const selectedAccount = accounts.find((account) => account.account_key === accountKey);
  const models =
    props.provider.model_availability_scope === "per_account"
      ? selectedAccount?.models ?? []
      : props.provider.models;
  const [modelKey, setModelKey] = useState(models[0]?.model_key ?? "");
  const [prompt, setPrompt] = useState("Reply with OK.");
  const [result, setResult] = useState<ProviderModelTestResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    if (!models.some((model) => model.model_key === modelKey)) {
      setModelKey(models[0]?.model_key ?? "");
    }
    setResult(null);
    setRequestError(null);
  }, [accountKey, modelKey, models]);

  const mutation = useMutation({
    mutationFn: () =>
      testProviderModel(props.token, props.provider.provider_key, {
        account_key: accountKey,
        model_key: modelKey,
        prompt: prompt.trim()
      }),
    onSuccess: (nextResult) => {
      setResult(nextResult);
      setRequestError(null);
      props.onChanged();
    },
    onError: (error) => {
      setResult(null);
      setRequestError(error instanceof Error ? error.message : "测试请求失败");
    }
  });

  return (
    <AppDialog
      open
      tone={result ? (result.success ? "success" : "error") : requestError ? "error" : "info"}
      title={`测试模型 · ${props.provider.display_name}`}
      confirmLabel="关闭"
      onClose={props.onClose}
    >
      <div className="provider-test-form">
        <label className="field">
          <span>Key</span>
          <select
            value={accountKey}
            disabled={mutation.isPending}
            onChange={(event) => setAccountKey(event.target.value)}
          >
            {accounts.map((account) => (
              <option key={account.account_key} value={account.account_key}>
                {account.account_key} · {account.key_hint ?? "hidden"}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Model</span>
          <select
            value={modelKey}
            disabled={mutation.isPending || models.length === 0}
            onChange={(event) => {
              setModelKey(event.target.value);
              setResult(null);
              setRequestError(null);
            }}
          >
            {models.map((model) => (
              <option key={model.model_key} value={model.model_key}>
                {model.model_name}{model.enabled === false ? " · 已停用" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>测试内容</span>
          <textarea
            value={prompt}
            rows={3}
            maxLength={2000}
            disabled={mutation.isPending}
            onChange={(event) => {
              setPrompt(event.target.value);
              setResult(null);
              setRequestError(null);
            }}
          />
        </label>
        <button
          className="primary-action"
          type="button"
          disabled={mutation.isPending || !accountKey || !modelKey || !prompt.trim()}
          onClick={() => mutation.mutate()}
        >
          <FlaskConical size={16} />
          {mutation.isPending ? "测试中..." : "开始测试"}
        </button>
        {models.length === 0 ? <p className="status error">当前 Key 没有关联模型</p> : null}
        {requestError ? <p className="status error">{requestError}</p> : null}
        {result ? (
          <div className={`provider-test-result ${result.success ? "success" : "error"}`}>
            <strong>{result.success ? "模型可用" : "模型不可用"}</strong>
            <span>
              {result.protocol === "responses" ? "Responses" : "Chat Completions"}
              {" · "}
              {result.latency_ms} ms
              {result.upstream_status ? ` · HTTP ${result.upstream_status}` : ""}
            </span>
            <code>{result.prompt}</code>
            {result.error_message ? <p>{result.error_message}</p> : null}
          </div>
        ) : null}
      </div>
    </AppDialog>
  );
}

function ProviderCard(props: {
  provider: ProviderDetails;
  disabled: boolean;
  onAction: (action: string) => void;
  onTest: () => void;
  token: string;
  onPriorityChanged: () => void;
}) {
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const [priority, setPriority] = useState(String(props.provider.priority ?? 0));
  const [priorityError, setPriorityError] = useState<string | null>(null);
  const priorityMutation = useMutation({
    mutationFn: (value: number) =>
      updateProvider(props.token, props.provider.provider_key, { priority: value }),
    onSuccess: () => {
      setPriorityError(null);
      props.onPriorityChanged();
    },
    onError: (error) => {
      setPriorityError(error instanceof Error ? error.message : "优先级保存失败");
    }
  });

  useEffect(() => {
    setPriority(String(props.provider.priority ?? 0));
  }, [props.provider.priority]);
  const accounts = props.provider.accounts ?? [];
  const isPerAccountModels = props.provider.model_availability_scope !== "shared_by_provider";
  const visibleModelLimit = 12;
  const renderModelList = (
    models: ProviderModel[],
    account?: NonNullable<ProviderDetails["accounts"]>[number]
  ) => {
    const visibleModels = modelsExpanded ? models : models.slice(0, visibleModelLimit);
    const hiddenModelCount = Math.max(0, models.length - visibleModels.length);
    return (
      <ul className="model-list">
        {visibleModels.length > 0 ? (
          visibleModels.map((model) => {
            const modelAvailable = account
              ? isProviderAvailable(props.provider) &&
                isAccountSchedulable(account) &&
                isProviderModelAvailable(model)
              : isProviderModelSchedulable(props.provider, model);
            const unavailableReason = account
              ? !isProviderAvailable(props.provider)
                ? !props.provider.enabled
                  ? "Provider 已停用"
                  : "没有可调度的 API Key"
                : !isAccountSchedulable(account)
                  ? runtimeStatusDetail(account) || "Key 不可调度"
                  : providerModelUnavailableReason(props.provider, model)
              : providerModelUnavailableReason(props.provider, model);

            return (
              <li
                key={model.model_key}
                className={modelAvailable ? "available" : "unavailable"}
                title={modelAvailable ? "可用" : unavailableReason || "不可用"}
              >
                {model.model_name}
              </li>
            );
          })
        ) : (
          <li className="empty-model">暂无模型</li>
        )}
        {hiddenModelCount > 0 ? (
          <li>
            <button
              className="model-list-toggle"
              type="button"
              onClick={() => setModelsExpanded(true)}
            >
              +{hiddenModelCount}
            </button>
          </li>
        ) : null}
        {modelsExpanded && models.length > visibleModelLimit ? (
          <li>
            <button
              className="model-list-toggle"
              type="button"
              onClick={() => setModelsExpanded(false)}
            >
              收起
            </button>
          </li>
        ) : null}
      </ul>
    );
  };
  const renderAccountRow = (account: NonNullable<ProviderDetails["accounts"]>[number]) => (
    <div className="provider-key-row" key={account.account_key}>
      <div className="provider-key-title">
        <strong>{account.account_key}</strong>
        <code>{account.key_hint ?? "hidden"}</code>
      </div>
      <span className={account.enabled ? "badge success" : "badge danger"}>
        {account.enabled ? "已启用" : "已停用"}
      </span>
      <span
        className={runtimeStatusBadgeClass(account.runtime_status)}
        title={runtimeStatusDetail(account)}
      >
        {runtimeStatusLabel(account.runtime_status)}
      </span>
    </div>
  );

  return (
    <article className="provider-item">
      <div className="provider-row">
        <div className="provider-title">
          <strong>{props.provider.display_name}</strong>
          <code>{props.provider.provider_key}</code>
        </div>
      </div>

      <div className="provider-meta">
        <div className="metric">
          <span>启用</span>
          <SwitchControl
            checked={props.provider.enabled}
            disabled={props.disabled}
            label={`${props.provider.display_name} 启用开关`}
            onChange={() => props.onAction("toggle")}
          />
        </div>
        <div className="metric provider-priority-metric">
          <span>优先级</span>
          <input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={priority}
            disabled={props.disabled || priorityMutation.isPending}
            aria-label={`${props.provider.display_name} 优先级`}
            onChange={(event) => {
              setPriority(event.target.value);
              setPriorityError(null);
            }}
            onBlur={() => {
              if (!/^\d+$/.test(priority)) {
                setPriorityError("优先级必须是非负整数");
                return;
              }
              const nextPriority = Number(priority);
              if (!Number.isSafeInteger(nextPriority)) {
                setPriorityError("优先级数值过大");
                return;
              }
              if (nextPriority !== props.provider.priority) {
                priorityMutation.mutate(nextPriority);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
          {priorityError ? <small>{priorityError}</small> : null}
        </div>
        <div className="metric">
          <span>官网</span>
          {props.provider.website_url ? (
            <a href={props.provider.website_url} target="_blank" rel="noreferrer">
              {props.provider.website_url}
            </a>
          ) : (
            <strong>未填写</strong>
          )}
        </div>
        <div className="metric">
          <span>Models</span>
          <strong>{props.provider.models.length}</strong>
        </div>
        <div className="metric">
          <span>添加时间</span>
          <strong>{formatDateTime(props.provider.created_at)}</strong>
        </div>
        <div className="metric">
          <span>修改时间</span>
          <strong>{formatDateTime(props.provider.updated_at)}</strong>
        </div>
        <div className="metric">
          <span>类型</span>
          <strong>{providerKindLabel(props.provider.provider_kind)}</strong>
        </div>
      </div>

      <div className="provider-actions">
        <Link to="/providers/$providerKey" params={{ providerKey: props.provider.provider_key }} className="ghost-action small-action">
          <ExternalLink size={14} />
          详情
        </Link>
        <Link to="/providers/$providerKey/edit" params={{ providerKey: props.provider.provider_key }} className="ghost-action small-action">
          <Edit3 size={14} />
          编辑
        </Link>
        <button type="button" disabled={props.disabled} onClick={props.onTest}>
          <FlaskConical size={14} />
          测试模型
        </button>
        <button type="button" disabled={props.disabled} onClick={() => props.onAction("sync")}>
          <RefreshCw size={14} />
          同步模型
        </button>
        <button
          type="button"
          disabled={props.disabled}
          onClick={() => props.onAction("promote-priority")}
        >
          <Sparkles size={14} />
          一键高优
        </button>
        <button type="button" disabled={props.disabled} onClick={() => props.onAction("delete")}>
          <Trash2 size={14} />
          删除
        </button>
      </div>

      <div className="provider-key-models">
        {isPerAccountModels ? (
          accounts.length > 0 ? (
            accounts.map((account) => (
              <div className="provider-key-model-group" key={account.account_key}>
                {renderAccountRow(account)}
                {renderModelList(account.models ?? [], account)}
              </div>
            ))
          ) : (
            <div className="provider-key-model-group">
              <div className="provider-key-row">
                <div className="provider-key-title">
                  <strong>default</strong>
                  <code>{props.provider.key_hint ?? "hidden"}</code>
                </div>
                <span className="badge success">已启用</span>
              </div>
              {renderModelList(props.provider.models)}
            </div>
          )
        ) : (
          <div className="provider-key-model-group">
            <div className="provider-key-rows">
              {accounts.length > 0 ? (
                accounts.map(renderAccountRow)
              ) : (
                <div className="provider-key-row">
                  <div className="provider-key-title">
                    <strong>default</strong>
                    <code>{props.provider.key_hint ?? "hidden"}</code>
                  </div>
                  <span className="badge success">已启用</span>
                </div>
              )}
            </div>
            {renderModelList(props.provider.models)}
          </div>
        )}
      </div>
    </article>
  );
}

function ProviderAccountsPanel(props: {
  token: string;
  provider: ProviderDetails;
  onChanged: () => void;
}) {
  const accounts = props.provider.accounts ?? [];
  const [message, setMessage] = useState<{ text: string; mode?: "success" | "error" } | null>(null);

  const toggleMutation = useMutation({
    mutationFn: async (input: { account_key: string; enabled: boolean }) =>
      updateProviderAccount(props.token, props.provider.provider_key, input.account_key, {
        enabled: input.enabled
      }),
    onSuccess: props.onChanged
  });

  const deleteMutation = useMutation({
    mutationFn: async (accountKey: string) =>
      deleteProviderAccount(props.token, props.provider.provider_key, accountKey),
    onSuccess: props.onChanged,
    onError: (error) => {
      setMessage({
        text: error instanceof Error ? error.message : "删除 Account 失败",
        mode: "error"
      });
    }
  });

  const syncMutation = useMutation({
    mutationFn: async (accountKey: string) =>
      syncProviderAccount(props.token, props.provider.provider_key, accountKey),
    onSuccess: () => {
      setMessage({ text: "Account 模型已同步", mode: "success" });
      props.onChanged();
    },
    onError: (error) => {
      setMessage({
        text: error instanceof Error ? error.message : "同步 Account 模型失败",
        mode: "error"
      });
    }
  });

  return (
    <div className="panel detail-card">
      <h3>Accounts / API Keys</h3>
      <div className="model-capability-table provider-model-table">
        <div className="model-capability-header">
          <span>Account</span>
          <span>启用</span>
          <span>调度状态</span>
          <span>过期时间</span>
          <span>额度</span>
          <span>操作</span>
        </div>
        {accounts.map((account) => (
          <div className="model-capability-row" key={account.account_key}>
            <div className="model-name-cell">
              <strong>{account.account_key}</strong>
              <code>{account.key_hint ?? "hidden"}</code>
              <span className="badge">{account.endpoint_key ?? "全部 Endpoint"}</span>
            </div>
            <SwitchControl
              checked={account.enabled}
              disabled={toggleMutation.isPending}
              label={`${account.account_key} 启用开关`}
              onChange={(checked) =>
                toggleMutation.mutate({
                  account_key: account.account_key,
                  enabled: checked
                })
              }
            />
            <span
              className={runtimeStatusBadgeClass(account.runtime_status)}
              title={runtimeStatusDetail(account)}
            >
              {runtimeStatusLabel(account.runtime_status)}
            </span>
            <span>{account.expires_at ? formatDateTime(account.expires_at) : "未设置"}</span>
            <span>{formatQuotaSummary(account.quota)}</span>
            <div className="page-actions">
              <button
                type="button"
                className="ghost-action small-action"
                disabled={syncMutation.isPending}
                onClick={() => syncMutation.mutate(account.account_key)}
              >
                <RefreshCw size={14} />
                同步模型
              </button>
              <button
                type="button"
                className="ghost-action small-action"
                disabled={deleteMutation.isPending || accounts.length <= 1}
                onClick={() => deleteMutation.mutate(account.account_key)}
              >
                <Trash2 size={14} />
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
      {message ? <p className={`status ${message.mode ?? ""}`}>{message.text}</p> : null}
    </div>
  );
}

function MetricCard(props: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <DatabaseZap size={18} />
      <div>
        <span>{props.label}</span>
        <strong>{props.value}</strong>
      </div>
    </div>
  );
}

function PageLoading() {
  return (
    <section className="page-panel">
      <p className="muted">正在加载...</p>
    </section>
  );
}

function NotFoundPanel(props: { title: string }) {
  return (
    <section className="page-panel">
      <div className="empty-state">
        <div>
          <strong>{props.title}</strong>
          <p>返回列表后重新选择。</p>
        </div>
      </div>
    </section>
  );
}
