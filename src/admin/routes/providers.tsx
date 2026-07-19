import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  BarChart3,
  Cpu,
  DatabaseZap,
  Edit3,
  ExternalLink,
  KeyRound,
  Lock,
  LogOut,
  Network,
  Plus,
  Power,
  RefreshCw,
  Route,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  createProvider,
  deleteProvider,
  listProviders,
  setProviderEnabled,
  syncProvider,
  updateProvider,
  updateProviderModelCapabilities,
  type ProviderDetails,
  type ProviderFormValues
} from "../api/providers.js";

export const providerTokenStorageKey = "autorouter_admin_token";

const providerFormSchema = z.object({
  provider_key: z.string().trim().min(1, "请填写 Provider Key"),
  display_name: z.string().trim().min(1, "请填写 Display Name"),
  base_url: z.string().trim().url("Base URL 必须是有效网址"),
  website_url: z
    .string()
    .trim()
    .optional()
    .refine((value) => !value || z.string().url().safeParse(value).success, {
      message: "官网地址必须是有效网址"
    }),
  api_key: z.string().optional()
});

function normalizeFormValues(values: ProviderFormValues): ProviderFormValues {
  return {
    provider_key: values.provider_key.trim(),
    display_name: values.display_name.trim(),
    base_url: values.base_url.trim(),
    website_url: values.website_url?.trim() ?? "",
    api_key: values.api_key?.trim() ?? ""
  };
}

function RequiredMark() {
  return <span className="required-mark">*</span>;
}

export function getStoredToken() {
  return localStorage.getItem(providerTokenStorageKey) ?? "";
}

function providersQueryKey(token: string) {
  return ["providers", token] as const;
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

function useProviders(token: string) {
  return useQuery({
    queryKey: providersQueryKey(token),
    queryFn: () => listProviders(token),
    enabled: token.length > 0
  });
}

function useProvider(token: string, providerKey: string) {
  const providersQuery = useProviders(token);
  const provider = providersQuery.data?.data.find((item) => item.provider_key === providerKey) ?? null;

  return { ...providersQuery, provider };
}

const navItems = [
  {
    label: "Providers",
    icon: Network,
    to: "/providers",
    title: "Provider 管理",
    description: "配置 OpenAI-compatible provider，自动整理可用模型。"
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

  const providers = providersQuery.data?.data ?? [];
  const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0);

  return (
    <main className="console-shell">
      <aside className="sidebar">
        <div className="brand sidebar-brand">
          <div className="brand-mark">
            <Cpu size={21} />
          </div>
          <div>
            <strong>AutoRouter</strong>
            <span>Control Plane</span>
          </div>
        </div>

        <nav className="side-nav" aria-label="Admin navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.label}
                to={item.to}
                className="nav-item"
                activeProps={{ className: "nav-item active" }}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <span className="status-dot" />
          <span>Gateway online</span>
        </div>
      </aside>

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

        <section className="stats-grid">
          <div className="stat-card">
            <Network size={18} />
            <div>
              <span>Providers</span>
              <strong>{providers.length}</strong>
            </div>
          </div>
          <div className="stat-card">
            <DatabaseZap size={18} />
            <div>
              <span>Models</span>
              <strong>{totalModels}</strong>
            </div>
          </div>
          <div className="stat-card">
            <Activity size={18} />
            <div>
              <span>Gateway</span>
              <strong>Online</strong>
            </div>
          </div>
        </section>

        <Outlet />
      </section>
    </main>
  );
}

export function ProviderListPage() {
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const providersQuery = useProviders(token);
  const providers = providersQuery.data?.data ?? [];
  const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0);

  return (
    <section className="page-panel">
      <div className="list-header">
        <div>
          <h2>Provider 列表</h2>
          <p className="muted">
            {providers.length} providers · {totalModels} models
          </p>
        </div>
        <div className="page-actions">
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
      help="填写服务信息后，系统会自动找到可用模型并保存起来。"
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
      help="修改名称或官网会直接保存；修改 Base URL 时会重新检查可用模型。"
      mode="edit"
      token={token}
      provider={provider}
      onDone={() => {
        void queryClient.invalidateQueries({ queryKey: providersQueryKey(token) });
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
      if (action === "delete") {
        window.location.assign("/admin/providers");
      }
    }
  });
  const modelMutation = useMutation({
    mutationFn: async (input: {
      model_key: string;
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
          <button className="ghost-action" type="button" onClick={() => mutation.mutate("toggle")}>
            {provider.enabled ? <Power size={16} /> : <Activity size={16} />}
            {provider.enabled ? "禁用" : "启用"}
          </button>
        </div>
      </div>

      <div className="detail-grid">
        <MetricCard label="状态" value={provider.enabled ? "已启用" : "已停用"} />
        <MetricCard label="模型数量" value={String(provider.models.length)} />
        <MetricCard label="Key" value={provider.key_hint ?? "hidden"} />
      </div>

      <div className="panel detail-card">
        <h3>连接信息</h3>
        <dl>
          <dt>Base URL</dt>
          <dd><code>{provider.base_url}</code></dd>
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
          <dt>最近同步</dt>
          <dd>{provider.latest_sync?.status ?? "暂无记录"}</dd>
        </dl>
      </div>

      <div className="panel detail-card">
        <h3>模型列表</h3>
        <div className="model-capability-table">
          <div className="model-capability-header">
            <span>模型</span>
            <span>Streaming</span>
            <span>Tools</span>
            <span>JSON</span>
          </div>
          {provider.models.map((model) => (
            <div className="model-capability-row" key={model.model_key}>
              <div className="model-name-cell">
                <strong>{model.model_name}</strong>
                <code>{model.model_key}</code>
              </div>
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

  const form = useForm<ProviderFormValues>({
    resolver: zodResolver(providerFormSchema),
    defaultValues: {
      provider_key: "",
      display_name: "",
      base_url: "",
      website_url: "",
      api_key: ""
    }
  });

  useEffect(() => {
    form.reset({
      provider_key: props.provider?.provider_key ?? "",
      display_name: props.provider?.display_name ?? "",
      base_url: props.provider?.base_url ?? "",
      website_url: props.provider?.website_url ?? "",
      api_key: ""
    });
    setMessage(null);
  }, [form, props.provider]);

  const mutation = useMutation({
    mutationFn: async (values: ProviderFormValues) => {
      const normalized = normalizeFormValues(values);
      if (!isEditing && !normalized.api_key) {
        throw new Error("请填写 API Key");
      }

      if (isEditing && props.provider) {
        return updateProvider(props.token, props.provider.provider_key, {
          display_name: normalized.display_name,
          base_url: normalized.base_url,
          website_url: normalized.website_url,
          api_key: normalized.api_key || undefined
        });
      }

      return createProvider(props.token, normalized);
    },
    onSuccess: (_result, values) => {
      const baseUrlChanged =
        props.provider && values.base_url.trim() !== props.provider.base_url;
      setMessage({
        text: baseUrlChanged ? "Provider 已保存，可用模型已更新" : "Provider 已保存",
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

  const errors = form.formState.errors;

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
          <span>
            Base URL <RequiredMark />
          </span>
          <input {...form.register("base_url")} placeholder="https://example.com/v1" />
          {errors.base_url ? <small>{errors.base_url.message}</small> : null}
        </label>

        <label className="field">
          <span>官网地址</span>
          <input {...form.register("website_url")} placeholder="https://example.com" />
          {errors.website_url ? <small>{errors.website_url.message}</small> : null}
        </label>

        <label className="field">
          <span>
            API Key {!isEditing ? <RequiredMark /> : null}
          </span>
          <input
            {...form.register("api_key")}
            type="password"
            placeholder={isEditing ? "不修改可留空" : "sk-..."}
          />
        </label>

        <div className="form-actions">
          <button className="primary-action" type="submit" disabled={mutation.isPending}>
            {isEditing ? <Edit3 size={16} /> : <Plus size={16} />}
            {mutation.isPending ? "保存中..." : isEditing ? "保存修改" : "保存并同步"}
          </button>
        </div>
      </form>

      {message ? <p className={`status ${message.mode ?? ""}`}>{message.text}</p> : null}
    </section>
  );
}

function ProviderList(props: {
  token: string;
  providers: ProviderDetails[];
  onChanged: () => void;
}) {
  const mutation = useMutation({
    mutationFn: async (input: { action: string; provider: ProviderDetails }) => {
      if (input.action === "sync") {
        return syncProvider(props.token, input.provider.provider_key);
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
    <div className="provider-list">
      {props.providers.map((provider) => (
        <ProviderCard
          key={provider.provider_key}
          provider={provider}
          disabled={mutation.isPending}
          onAction={(action) => mutation.mutate({ action, provider })}
        />
      ))}
    </div>
  );
}

function ProviderCard(props: {
  provider: ProviderDetails;
  disabled: boolean;
  onAction: (action: string) => void;
}) {
  const visibleModels = useMemo(() => props.provider.models.slice(0, 12), [props.provider.models]);
  const hiddenModelCount = Math.max(0, props.provider.models.length - visibleModels.length);

  return (
    <article className="provider-item">
      <div className="provider-row">
        <div className="provider-title">
          <strong>{props.provider.display_name}</strong>
          <code>{props.provider.provider_key}</code>
        </div>
        <span className={`badge ${props.provider.enabled ? "success" : "warning"}`}>
          {props.provider.enabled ? "已启用" : "已停用"}
        </span>
      </div>

      <div className="provider-meta">
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
          <span>Base URL</span>
          <code>{props.provider.base_url}</code>
        </div>
        <div className="metric">
          <span>Models</span>
          <strong>{props.provider.models.length}</strong>
        </div>
        <div className="metric">
          <span>Key</span>
          <strong>{props.provider.key_hint ?? "hidden"}</strong>
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
        <button type="button" disabled={props.disabled} onClick={() => props.onAction("sync")}>
          <RefreshCw size={14} />
          同步模型
        </button>
        <button type="button" disabled={props.disabled} onClick={() => props.onAction("toggle")}>
          {props.provider.enabled ? <Power size={14} /> : <Activity size={14} />}
          {props.provider.enabled ? "禁用" : "启用"}
        </button>
        <button type="button" disabled={props.disabled} onClick={() => props.onAction("delete")}>
          <Trash2 size={14} />
          删除
        </button>
      </div>

      <ul className="model-list">
        {visibleModels.map((model) => (
          <li key={model.model_key}>{model.model_name}</li>
        ))}
        {hiddenModelCount > 0 ? <li>+{hiddenModelCount}</li> : null}
      </ul>
    </article>
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
