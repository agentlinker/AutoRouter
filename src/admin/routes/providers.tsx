import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  type ProviderDetails,
  type ProviderFormValues
} from "../api/providers.js";

const tokenStorageKey = "autorouter_admin_token";

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

export function AdminApp() {
  const [tokenInput, setTokenInput] = useState(
    () => localStorage.getItem(tokenStorageKey) ?? ""
  );
  const [token, setToken] = useState(() => localStorage.getItem(tokenStorageKey) ?? "");
  const [authError, setAuthError] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<ProviderDetails | null>(null);
  const queryClient = useQueryClient();

  const providersQuery = useQuery({
    queryKey: ["providers", token],
    queryFn: () => listProviders(token),
    enabled: token.length > 0
  });

  useEffect(() => {
    if (providersQuery.isError) {
      setAuthError(providersQuery.error.message);
    }
  }, [providersQuery.error, providersQuery.isError]);

  const providers = providersQuery.data?.data ?? [];
  const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0);
  const isAuthenticated = token.length > 0 && providersQuery.isSuccess;

  function authenticate() {
    const nextToken = tokenInput.trim();
    if (!nextToken) {
      setAuthError("请输入 Admin Token");
      return;
    }

    localStorage.setItem(tokenStorageKey, nextToken);
    setAuthError(null);
    setToken(nextToken);
  }

  function lockConsole() {
    localStorage.removeItem(tokenStorageKey);
    setToken("");
    setTokenInput("");
    setEditingProvider(null);
    setAuthError(null);
    queryClient.removeQueries({ queryKey: ["providers"] });
  }

  if (!isAuthenticated) {
    return (
      <main className="layout">
        <section className="auth-view">
          <div className="brand">
            <div className="brand-mark">AR</div>
            <div>
              <h1>AutoRouter Admin</h1>
              <p>管理本地 provider、密钥与自动发现的模型。</p>
            </div>
          </div>

          <div className="auth-card">
            <div className="card-header">
              <h2>管理员验证</h2>
              <p>使用 .env 中的 AUTO_ROUTER_ADMIN_TOKEN 进入控制台。</p>
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
    <main className="layout">
      <section className="app-view">
        <header className="topbar">
          <div className="brand compact">
            <div className="brand-mark">AR</div>
            <div>
              <h1>Provider 管理</h1>
              <p>配置 OpenAI-compatible provider 并同步模型。</p>
            </div>
          </div>
          <div className="topbar-actions">
            <span className="badge success">已验证</span>
            <button className="ghost-action" type="button" onClick={lockConsole}>
              锁定
            </button>
          </div>
        </header>

        <section className="content-grid">
          <ProviderForm
            token={token}
            editingProvider={editingProvider}
            onDone={() => {
              setEditingProvider(null);
              void queryClient.invalidateQueries({ queryKey: ["providers", token] });
            }}
            onCancel={() => setEditingProvider(null)}
          />

          <section className="panel list-panel">
            <div className="list-header">
              <div>
                <h2>Provider 列表</h2>
                <p className="muted">
                  {providers.length} providers · {totalModels} models
                </p>
              </div>
              <button
                className="ghost-action"
                type="button"
                onClick={() => void providersQuery.refetch()}
              >
                刷新
              </button>
            </div>

            <ProviderList
              token={token}
              providers={providers}
              onEdit={setEditingProvider}
              onChanged={() => void queryClient.invalidateQueries({ queryKey: ["providers", token] })}
            />
          </section>
        </section>
      </section>
    </main>
  );
}

function ProviderForm(props: {
  token: string;
  editingProvider: ProviderDetails | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const isEditing = Boolean(props.editingProvider);
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
    if (!props.editingProvider) {
      form.reset({
        provider_key: "",
        display_name: "",
        base_url: "",
        website_url: "",
        api_key: ""
      });
      setMessage(null);
      return;
    }

    form.reset({
      provider_key: props.editingProvider.provider_key,
      display_name: props.editingProvider.display_name,
      base_url: props.editingProvider.base_url,
      website_url: props.editingProvider.website_url ?? "",
      api_key: ""
    });
    setMessage(null);
  }, [form, props.editingProvider]);

  const mutation = useMutation({
    mutationFn: async (values: ProviderFormValues) => {
      const normalized = normalizeFormValues(values);
      if (!isEditing && !normalized.api_key) {
        throw new Error("请填写 API Key");
      }

      if (props.editingProvider) {
        return updateProvider(props.token, props.editingProvider.provider_key, {
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
        props.editingProvider && values.base_url.trim() !== props.editingProvider.base_url;
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
    <aside className="panel create-panel">
      <div className="card-header">
        <h2>{isEditing ? "编辑 Provider" : "新增 Provider"}</h2>
        <p>
          {isEditing
            ? "修改名称或官网会直接保存；修改 Base URL 时会重新检查可用模型。"
            : "填写服务信息后，系统会自动找到可用模型并保存起来。"}
        </p>
      </div>

      <form className="form" onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
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
            {mutation.isPending ? "保存中..." : isEditing ? "保存修改" : "保存并同步"}
          </button>
          {isEditing ? (
            <button className="ghost-action" type="button" onClick={props.onCancel}>
              取消编辑
            </button>
          ) : null}
        </div>
      </form>

      {message ? <p className={`status ${message.mode ?? ""}`}>{message.text}</p> : null}
    </aside>
  );
}

function ProviderList(props: {
  token: string;
  providers: ProviderDetails[];
  onEdit: (provider: ProviderDetails) => void;
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
          <p>新增一个 provider 后，系统会自动记录可用模型。</p>
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
          onEdit={() => props.onEdit(provider)}
          onAction={(action) => mutation.mutate({ action, provider })}
        />
      ))}
    </div>
  );
}

function ProviderCard(props: {
  provider: ProviderDetails;
  disabled: boolean;
  onEdit: () => void;
  onAction: (action: string) => void;
}) {
  const visibleModels = useMemo(() => props.provider.models.slice(0, 16), [props.provider.models]);
  const hiddenModelCount = Math.max(0, props.provider.models.length - visibleModels.length);

  return (
    <article className="provider-item">
      <div className="provider-row">
        <div className="provider-title">
          <strong>{props.provider.display_name}</strong>
          <code>{props.provider.provider_key}</code>
        </div>
        <span className={`badge ${props.provider.enabled ? "success" : "warning"}`}>
          {props.provider.enabled ? "Enabled" : "Disabled"}
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
        <button type="button" disabled={props.disabled} onClick={props.onEdit}>
          编辑
        </button>
        <button type="button" disabled={props.disabled} onClick={() => props.onAction("sync")}>
          同步模型
        </button>
        <button type="button" disabled={props.disabled} onClick={() => props.onAction("toggle")}>
          {props.provider.enabled ? "禁用" : "启用"}
        </button>
        <button type="button" disabled={props.disabled} onClick={() => props.onAction("delete")}>
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
