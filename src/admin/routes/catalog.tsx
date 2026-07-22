import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { BookOpen, RefreshCw, Save, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  enrichCatalogModelFromOpenRouter,
  getCatalogModel,
  listCatalogModels,
  updateCatalogModel,
  updateCatalogModelInstance,
  type CatalogModel,
  type CatalogModelInstance
} from "../api/catalog.js";
import { AppDialog, type AppDialogTone } from "../components/Dialog.js";
import { getStoredToken } from "./providers.js";

function catalogQueryKey(token: string) {
  return ["catalog", token] as const;
}

function catalogDetailQueryKey(token: string, logicalName: string) {
  return ["catalog", token, logicalName] as const;
}

function useCatalogModels(token: string) {
  return useQuery({
    queryKey: catalogQueryKey(token),
    queryFn: () => listCatalogModels(token),
    enabled: token.length > 0
  });
}

function CapabilitySelect(props: {
  value: boolean | null;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <select
      value={props.value === null ? "inherit" : props.value ? "true" : "false"}
      onChange={(event) => {
        const value = event.target.value;
        props.onChange(value === "inherit" ? null : value === "true");
      }}
    >
      <option value="inherit">继承</option>
      <option value="true">是</option>
      <option value="false">否</option>
    </select>
  );
}

export function CatalogListPage() {
  const token = getStoredToken();
  const catalogQuery = useCatalogModels(token);
  const models = catalogQuery.data?.data ?? [];
  const [searchTerm, setSearchTerm] = useState("");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const filteredModels = useMemo(() => {
    if (!normalizedSearch) {
      return models;
    }

    return models.filter((model) => {
      const searchable = [
        model.logical_name,
        model.display_name,
        model.openrouter_slug,
        ...model.instances.flatMap((instance) => [
          instance.provider_key,
          instance.provider_display_name,
          instance.model_key,
          instance.provider_model_id,
          instance.model_name
        ])
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLowerCase();

      return searchable.includes(normalizedSearch);
    });
  }, [models, normalizedSearch]);
  const totalPages = Math.max(1, Math.ceil(filteredModels.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageModels = filteredModels.slice(pageStart, pageStart + pageSize);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  return (
    <section className="page-panel">
      <div className="list-header">
        <div>
          <h2>Catalog 模型</h2>
          <p className="muted">
            {models.length} 个模型 · {models.reduce((sum, model) => sum + model.instances.length, 0)} 个 Provider 实例
          </p>
        </div>
        <button className="ghost-action" type="button" onClick={() => void catalogQuery.refetch()}>
          <RefreshCw size={16} />
          刷新
        </button>
      </div>

      <div className="table-toolbar">
        <span className="muted">
          显示 {filteredModels.length === 0 ? 0 : pageStart + 1}-{Math.min(pageStart + pageSize, filteredModels.length)} / {filteredModels.length}
        </span>
        <div className="table-toolbar-actions">
          <label className="search-field">
            <span>搜索</span>
            <input
              value={searchTerm}
              placeholder="模型名或 Provider 名"
              onChange={(event) => {
                setSearchTerm(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="inline-select">
            <span>每页</span>
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              {[10, 20, 50, 100].map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="table-scroll">
        <table className="data-table catalog-table">
          <thead>
            <tr>
              <th>模型名</th>
              <th>OpenRouter Slug</th>
              <th>Context</th>
              <th>能力</th>
              <th>Provider 实例数</th>
              <th>来源</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            {pageModels.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <span className="muted">没有匹配的 Catalog 模型</span>
                </td>
              </tr>
            ) : null}
            {pageModels.map((model) => {
              const displayName =
                model.display_name && model.display_name !== model.logical_name
                  ? model.display_name
                  : null;

              return (
                <tr key={model.logical_name}>
                  <td>
                    <Link to="/catalog/$logicalName" params={{ logicalName: model.logical_name }}>
                      {model.logical_name}
                    </Link>
                    {displayName ? <span className="table-subtext">{displayName}</span> : null}
                  </td>
                  <td>{model.openrouter_slug ? <code>{model.openrouter_slug}</code> : <span className="muted">未设置</span>}</td>
                  <td>{model.context_window ? model.context_window.toLocaleString() : <span className="muted">未知</span>}</td>
                  <td>
                    <div className="model-tags compact">
                      <span className={model.supports_tools ? "badge success" : "badge"}>Tools</span>
                      <span className={model.supports_streaming ? "badge success" : "badge"}>Stream</span>
                      <span className={model.supports_json_mode ? "badge success" : "badge"}>JSON</span>
                    </div>
                  </td>
                  <td>{model.instances.length}</td>
                  <td>
                    <span className="badge">{model.metadata_source}</span>
                    <span className="table-subtext">{model.metadata_confidence}</span>
                  </td>
                  <td>{new Date(model.updated_at).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pagination-bar">
        <button className="ghost-action small-action" type="button" disabled={currentPage <= 1} onClick={() => setPage(1)}>
          首页
        </button>
        <button className="ghost-action small-action" type="button" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
          上一页
        </button>
        <span className="muted">第 {currentPage} / {totalPages} 页</span>
        <button className="ghost-action small-action" type="button" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
          下一页
        </button>
        <button className="ghost-action small-action" type="button" disabled={currentPage >= totalPages} onClick={() => setPage(totalPages)}>
          末页
        </button>
      </div>
    </section>
  );
}

export function CatalogDetailPage() {
  const token = getStoredToken();
  const { logicalName } = useParams({ from: "/catalog/$logicalName" });
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: catalogDetailQueryKey(token, logicalName),
    queryFn: () => getCatalogModel(token, logicalName),
    enabled: token.length > 0
  });
  const model = detailQuery.data ?? null;
  const [form, setForm] = useState({
    display_name: "",
    openrouter_slug: "",
    context_window: "",
    supports_streaming: true,
    supports_tools: true,
    supports_json_mode: false,
    pricing_json: "",
    notes: ""
  });
  const [message, setMessage] = useState<{ text: string; mode?: "success" | "error" } | null>(null);
  const [dialog, setDialog] = useState<{
    title: string;
    description?: string;
    tone: AppDialogTone;
  } | null>(null);

  useEffect(() => {
    if (!model) {
      return;
    }

    setForm({
      display_name: model.display_name ?? "",
      openrouter_slug: model.openrouter_slug ?? "",
      context_window: model.context_window ? String(model.context_window) : "",
      supports_streaming: model.supports_streaming,
      supports_tools: model.supports_tools,
      supports_json_mode: model.supports_json_mode,
      pricing_json: model.pricing_json ?? "",
      notes: model.notes ?? ""
    });
  }, [model]);

  const invalidate = (updated?: CatalogModel) => {
    void queryClient.invalidateQueries({ queryKey: catalogQueryKey(token) });
    if (updated) {
      queryClient.setQueryData(catalogDetailQueryKey(token, updated.logical_name), updated);
    } else {
      void queryClient.invalidateQueries({ queryKey: catalogDetailQueryKey(token, logicalName) });
    }
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      updateCatalogModel(token, logicalName, {
        display_name: form.display_name.trim() || null,
        openrouter_slug: form.openrouter_slug.trim() || null,
        context_window: form.context_window.trim() ? Number(form.context_window) : null,
        supports_streaming: form.supports_streaming,
        supports_tools: form.supports_tools,
        supports_json_mode: form.supports_json_mode,
        pricing_json: form.pricing_json.trim() || null,
        notes: form.notes.trim() || null
      }),
    onSuccess: (updated) => {
      const text = "Catalog 元数据已更新。";
      setMessage({ text: `保存成功，${text}`, mode: "success" });
      invalidate(updated);
      setDialog({
        title: "保存成功",
        description: text,
        tone: "success"
      });
    },
    onError: (error) => {
      const detail = error instanceof Error ? error.message : "请稍后重试。";
      const text = `保存失败：${detail}`;
      setMessage({ text, mode: "error" });
      setDialog({
        title: "保存失败",
        description: detail,
        tone: "error"
      });
    }
  });
  const enrichMutation = useMutation({
    mutationFn: () => enrichCatalogModelFromOpenRouter(token, logicalName),
    onSuccess: (updated) => {
      const text = "从 OpenRouter 获取元数据成功，并且已保存。";
      setMessage({ text, mode: "success" });
      invalidate(updated);
      setDialog({
        title: "获取成功",
        description: text,
        tone: "success"
      });
    },
    onError: (error) => {
      const detail = error instanceof Error ? error.message : "请稍后重试。";
      const text = `从 OpenRouter 获取元数据失败：${detail}`;
      setMessage({ text, mode: "error" });
      setDialog({
        title: "获取失败",
        description: detail,
        tone: "error"
      });
    }
  });

  const instances = useMemo(() => model?.instances ?? [], [model]);

  if (detailQuery.isLoading) {
    return <section className="page-panel">正在加载...</section>;
  }

  if (!model) {
    return <section className="page-panel">Catalog 模型不存在</section>;
  }

  return (
    <section className="page-panel detail-page">
      <AppDialog
        open={dialog !== null}
        title={dialog?.title ?? ""}
        tone={dialog?.tone ?? "info"}
        onClose={() => setDialog(null)}
      >
        {dialog?.description}
      </AppDialog>

      <div className="detail-header">
        <div>
          <span className="eyebrow">
            <BookOpen size={14} />
            Catalog Detail
          </span>
          <h2>{model.display_name ?? model.logical_name}</h2>
          <p className="muted">{model.logical_name}</p>
        </div>
        <div className="page-actions">
          <Link to="/catalog" className="ghost-action">返回列表</Link>
          <button className="ghost-action" type="button" onClick={() => enrichMutation.mutate()}>
            <Sparkles size={16} />
            从 OpenRouter 获取元数据
          </button>
          <button className="primary-action" type="button" onClick={() => saveMutation.mutate()}>
            <Save size={16} />
            保存
          </button>
        </div>
      </div>

      <div className="panel form form-card">
        <label className="field">
          <span>Display Name</span>
          <input value={form.display_name} onChange={(event) => setForm((current) => ({ ...current, display_name: event.target.value }))} />
        </label>
        <label className="field">
          <span>OpenRouter Slug</span>
          <input value={form.openrouter_slug} onChange={(event) => setForm((current) => ({ ...current, openrouter_slug: event.target.value }))} />
        </label>
        <label className="field">
          <span>Context Window</span>
          <input value={form.context_window} type="number" onChange={(event) => setForm((current) => ({ ...current, context_window: event.target.value }))} />
        </label>
        <label className="field">
          <span>Pricing JSON</span>
          <textarea value={form.pricing_json} rows={4} onChange={(event) => setForm((current) => ({ ...current, pricing_json: event.target.value }))} />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea value={form.notes} rows={3} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
        </label>
        <div className="model-tags">
          <label className="capability-toggle">
            <input type="checkbox" checked={form.supports_streaming} onChange={(event) => setForm((current) => ({ ...current, supports_streaming: event.target.checked }))} />
            <span>Streaming</span>
          </label>
          <label className="capability-toggle">
            <input type="checkbox" checked={form.supports_tools} onChange={(event) => setForm((current) => ({ ...current, supports_tools: event.target.checked }))} />
            <span>Tools</span>
          </label>
          <label className="capability-toggle">
            <input type="checkbox" checked={form.supports_json_mode} onChange={(event) => setForm((current) => ({ ...current, supports_json_mode: event.target.checked }))} />
            <span>JSON</span>
          </label>
        </div>
        {message ? <p className={`status ${message.mode ?? ""}`}>{message.text}</p> : null}
      </div>

      <div className="panel detail-card">
        <h3>Provider 实例</h3>
        <div className="catalog-instance-table">
          <div className="catalog-instance-header">
            <span>Provider 实例</span>
            <span>Context</span>
            <span>Stream</span>
            <span>Tools</span>
            <span>JSON</span>
            <span>Enabled</span>
          </div>
          {instances.map((instance) => (
            <CatalogInstanceRow
              key={`${instance.provider_key}:${instance.model_key}`}
              token={token}
              logicalName={logicalName}
              instance={instance}
              onUpdated={invalidate}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function CatalogInstanceRow(props: {
  token: string;
  logicalName: string;
  instance: CatalogModelInstance;
  onUpdated: (updated: CatalogModel) => void;
}) {
  const [contextOverride, setContextOverride] = useState(
    props.instance.context_window_override ? String(props.instance.context_window_override) : ""
  );
  const [streamOverride, setStreamOverride] = useState<boolean | null>(props.instance.supports_streaming_override);
  const [toolsOverride, setToolsOverride] = useState<boolean | null>(props.instance.supports_tools_override);
  const [jsonOverride, setJsonOverride] = useState<boolean | null>(props.instance.supports_json_mode_override);
  const mutation = useMutation({
    mutationFn: (overrides?: {
      contextWindowOverride?: string;
      streamOverride?: boolean | null;
      toolsOverride?: boolean | null;
      jsonOverride?: boolean | null;
    }) => {
      const nextContext = overrides?.contextWindowOverride ?? contextOverride;
      const nextStream = overrides?.streamOverride ?? streamOverride;
      const nextTools = overrides?.toolsOverride ?? toolsOverride;
      const nextJson = overrides?.jsonOverride ?? jsonOverride;
      return (
      updateCatalogModelInstance(props.token, props.logicalName, {
        provider_key: props.instance.provider_key,
        model_key: props.instance.model_key,
        context_window_override: nextContext.trim() ? Number(nextContext) : null,
        supports_streaming_override: nextStream,
        supports_tools_override: nextTools,
        supports_json_mode_override: nextJson
      })
      );
    },
    onSuccess: props.onUpdated
  });
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      updateCatalogModelInstance(props.token, props.logicalName, {
        provider_key: props.instance.provider_key,
        model_key: props.instance.model_key,
        enabled
      }),
    onSuccess: props.onUpdated
  });

  return (
    <div className="catalog-instance-row">
      <div className="model-name-cell">
        <strong>{props.instance.provider_display_name}</strong>
        <code>{props.instance.model_key}</code>
        <span className="badge">{props.instance.endpoint_key}</span>
      </div>
      <input
        value={contextOverride}
        type="number"
        placeholder={props.instance.effective_context_window ? String(props.instance.effective_context_window) : "inherit"}
        onChange={(event) => setContextOverride(event.target.value)}
        onBlur={() => mutation.mutate({})}
      />
      <CapabilitySelect value={streamOverride} onChange={(value) => { setStreamOverride(value); mutation.mutate({ streamOverride: value }); }} />
      <CapabilitySelect value={toolsOverride} onChange={(value) => { setToolsOverride(value); mutation.mutate({ toolsOverride: value }); }} />
      <CapabilitySelect value={jsonOverride} onChange={(value) => { setJsonOverride(value); mutation.mutate({ jsonOverride: value }); }} />
      <label className="capability-toggle">
        <input
          type="checkbox"
          checked={props.instance.enabled}
          disabled={toggleMutation.isPending}
          onChange={(event) => toggleMutation.mutate(event.target.checked)}
        />
        <span>{props.instance.enabled ? "启用" : "禁用"}</span>
      </label>
    </div>
  );
}
