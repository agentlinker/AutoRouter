import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Cable,
  KeyRound,
  Route,
  ScrollText,
  Settings,
  ShieldCheck
} from "lucide-react";
import type { ReactNode } from "react";

import {
  getApiKeyDetail,
  listApiKeys,
  type ProviderApiKeyEntry,
  type SystemApiKeyEntry
} from "../api/apiKeys.js";
import { getPolicyDetail, listPolicies } from "../api/policies.js";
import {
  getSettingsSectionDetail,
  listSettings
} from "../api/settings.js";
import { getTokensOverview } from "../api/tokens.js";
import {
  getTraceDetail,
  listTraces,
  type TraceRecord
} from "../api/traces.js";
import { getUsageDetail, getUsageOverview } from "../api/usage.js";
import { providerTokenStorageKey } from "./providers.js";

function getStoredToken() {
  return localStorage.getItem(providerTokenStorageKey) ?? "";
}

function useApiKeysList(token: string) {
  return useQuery({
    queryKey: ["admin-api-keys", token],
    queryFn: () => listApiKeys(token),
    enabled: token.length > 0
  });
}

function useApiKeyDetail(token: string, keyScope: string, entryId: string) {
  return useQuery({
    queryKey: ["admin-api-keys", token, keyScope, entryId],
    queryFn: () => getApiKeyDetail(token, keyScope, entryId),
    enabled: token.length > 0
  });
}

function useUsageOverview(token: string) {
  return useQuery({
    queryKey: ["admin-usage", token],
    queryFn: () => getUsageOverview(token),
    enabled: token.length > 0
  });
}

function useUsageDetail(token: string, traceId: string) {
  return useQuery({
    queryKey: ["admin-usage", token, traceId],
    queryFn: () => getUsageDetail(token, traceId),
    enabled: token.length > 0
  });
}

function useTraceList(token: string, limit = 100) {
  return useQuery({
    queryKey: ["admin-traces", token, limit],
    queryFn: () => listTraces(token, limit),
    enabled: token.length > 0
  });
}

function useTraceDetail(token: string, traceId: string) {
  return useQuery({
    queryKey: ["admin-traces", token, traceId],
    queryFn: () => getTraceDetail(token, traceId),
    enabled: token.length > 0
  });
}

function useTokensOverview(token: string) {
  return useQuery({
    queryKey: ["admin-tokens", token],
    queryFn: () => getTokensOverview(token),
    enabled: token.length > 0
  });
}

function usePoliciesList(token: string) {
  return useQuery({
    queryKey: ["admin-policies", token],
    queryFn: () => listPolicies(token),
    enabled: token.length > 0
  });
}

function usePolicyDetail(token: string, policyId: string) {
  return useQuery({
    queryKey: ["admin-policies", token, policyId],
    queryFn: () => getPolicyDetail(token, policyId),
    enabled: token.length > 0
  });
}

function useSettingsList(token: string) {
  return useQuery({
    queryKey: ["admin-settings", token],
    queryFn: () => listSettings(token),
    enabled: token.length > 0
  });
}

function useSettingsDetail(token: string, sectionId: string) {
  return useQuery({
    queryKey: ["admin-settings", token, sectionId],
    queryFn: () => getSettingsSectionDetail(token, sectionId),
    enabled: token.length > 0
  });
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "暂无";
  }

  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat("zh-CN").format(value ?? 0);
}

function formatUsd(value: number | null) {
  if (value === null) {
    return "暂无";
  }

  return `$${value.toFixed(4)}`;
}

function ConsolePageLoading() {
  return (
    <section className="page-panel">
      <p className="muted">正在加载...</p>
    </section>
  );
}

function ConsoleNotFound(props: { title: string }) {
  return (
    <section className="page-panel">
      <div className="empty-state">
        <div>
          <strong>{props.title}</strong>
          <p>返回上一页后重新选择。</p>
        </div>
      </div>
    </section>
  );
}

function PageBackLink(props: { to: string; children: string }) {
  return (
    <Link to={props.to} className="ghost-action">
      <ArrowLeft size={16} />
      {props.children}
    </Link>
  );
}

function StatCard(props: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="stat-card">
      {props.icon}
      <div>
        <span>{props.label}</span>
        <strong>{props.value}</strong>
      </div>
    </div>
  );
}

function KeyStatusBadge(props: { configured: boolean }) {
  return (
    <span className={`badge ${props.configured ? "success" : "warning"}`}>
      {props.configured ? "已配置" : "未配置"}
    </span>
  );
}

function TraceStatusBadge(props: { status: "success" | "failed" }) {
  return (
    <span className={`badge ${props.status === "success" ? "success" : "warning"}`}>
      {props.status === "success" ? "成功" : "失败"}
    </span>
  );
}

function TraceDetailPanel(props: {
  trace: TraceRecord;
  title: string;
  eyebrowIcon: ReactNode;
  eyebrowText: string;
  backTo: string;
}) {
  return (
    <section className="page-panel detail-page">
      <div className="detail-header">
        <div>
          <span className="eyebrow">
            {props.eyebrowIcon}
            {props.eyebrowText}
          </span>
          <h2>{props.title}</h2>
          <p className="muted">{props.trace.trace_id}</p>
        </div>
        <PageBackLink to={props.backTo}>返回列表</PageBackLink>
      </div>

      <div className="detail-grid">
        <StatCard icon={<Route size={18} />} label="执行状态" value={props.trace.status === "success" ? "成功" : "失败"} />
        <StatCard icon={<Activity size={18} />} label="延迟" value={`${formatNumber(props.trace.latency_ms)} ms`} />
        <StatCard icon={<BarChart3 size={18} />} label="总 Tokens" value={formatNumber(props.trace.total_tokens)} />
      </div>

      <div className="panel detail-card">
        <h3>请求信息</h3>
        <dl>
          <dt>请求时间</dt>
          <dd>{formatDateTime(props.trace.timestamp)}</dd>
          <dt>原始模型</dt>
          <dd>{props.trace.requested_model}</dd>
          <dt>归一化模型</dt>
          <dd>{props.trace.normalized_model}</dd>
          <dt>选中 Provider</dt>
          <dd>{props.trace.selected_provider ?? "未命中"}</dd>
          <dt>选中 Endpoint</dt>
          <dd>{props.trace.selected_endpoint ?? "未命中"}</dd>
          <dt>选中模型</dt>
          <dd>{props.trace.selected_model ?? "未命中"}</dd>
          <dt>命中策略</dt>
          <dd>{props.trace.policy_hits.length > 0 ? props.trace.policy_hits.join(", ") : "无"}</dd>
          <dt>估算成本</dt>
          <dd>{formatUsd(props.trace.estimated_cost_usd)}</dd>
          <dt>错误信息</dt>
          <dd>{props.trace.error ?? "无"}</dd>
          <dt>实际尝试</dt>
          <dd>{props.trace.attempt_count}</dd>
        </dl>
      </div>

      <div className="split-grid">
        <div className="panel detail-card">
          <h3>候选列表</h3>
          <div className="stack-list">
            {props.trace.candidates.length > 0 ? (
              props.trace.candidates.map((candidate, index) => (
                <div key={`${candidate.endpoint}-${index}`} className="stack-item">
                  <strong>{candidate.provider ?? candidate.endpoint}</strong>
                  <span>{candidate.model}</span>
                  <code>{candidate.route_id ?? "route:auto"}</code>
                </div>
              ))
            ) : (
              <p className="muted">没有候选记录。</p>
            )}
          </div>
        </div>

        <div className="panel detail-card">
          <h3>实际尝试</h3>
          <div className="stack-list">
            {props.trace.attempts.length > 0 ? (
              props.trace.attempts.map((attempt, index) => (
                <div key={`${attempt.endpoint}-attempt-${index}`} className="stack-item">
                  <strong>{attempt.provider ?? attempt.endpoint}</strong>
                  <span>{attempt.model}</span>
                  <code>
                    {attempt.status === "success" ? "success" : attempt.error ?? "failed"}
                  </code>
                </div>
              ))
            ) : (
              <p className="muted">没有实际尝试记录。</p>
            )}
          </div>
        </div>

        <div className="panel detail-card">
          <h3>过滤与回退</h3>
          <div className="stack-list">
            {props.trace.filtered.length > 0 ? (
              props.trace.filtered.map((candidate, index) => (
                <div key={`${candidate.endpoint}-filtered-${index}`} className="stack-item">
                  <strong>{candidate.provider ?? candidate.endpoint}</strong>
                  <span>{candidate.model}</span>
                  <code>过滤原因: {candidate.reason ?? "unknown"}</code>
                </div>
              ))
            ) : (
              <p className="muted">没有被过滤的候选。</p>
            )}
            {props.trace.fallbacks.length > 0 ? (
              props.trace.fallbacks.map((candidate, index) => (
                <div key={`${candidate.endpoint}-fallback-${index}`} className="stack-item">
                  <strong>{candidate.provider ?? candidate.endpoint}</strong>
                  <span>{candidate.model}</span>
                  <code>fallback</code>
                </div>
              ))
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export function ApiKeysPage() {
  const token = getStoredToken();
  const query = useApiKeysList(token);

  if (query.isLoading) {
    return <ConsolePageLoading />;
  }

  const data = query.data;
  if (!data) {
    return <ConsoleNotFound title="API Key 数据不存在" />;
  }

  return (
    <section className="page-panel">
      <div className="list-header">
        <div>
          <h2>API Key 总览</h2>
          <p className="muted">统一查看系统令牌状态和各 Provider 凭据摘要。</p>
        </div>
      </div>

      <div className="detail-grid">
        <StatCard icon={<ShieldCheck size={18} />} label="系统令牌" value={String(data.system.length)} />
        <StatCard icon={<KeyRound size={18} />} label="Provider 凭据" value={String(data.providers.length)} />
        <StatCard
          icon={<Cable size={18} />}
          label="已配置"
          value={String(
            data.system.filter((item) => item.configured).length +
              data.providers.filter((item) => item.configured).length
          )}
        />
      </div>

      <div className="split-grid">
        <div className="panel detail-card">
          <h3>系统令牌</h3>
          <div className="record-list">
            {data.system.map((item) => (
              <Link
                key={item.entry_id}
                to="/api-keys/$keyScope/$entryId"
                params={{ keyScope: item.scope, entryId: item.entry_id }}
                className="record-item"
              >
                <div>
                  <strong>{item.label}</strong>
                  <p>{item.env_name}</p>
                </div>
                <KeyStatusBadge configured={item.configured} />
              </Link>
            ))}
          </div>
        </div>

        <div className="panel detail-card">
          <h3>Provider 凭据</h3>
          <div className="record-list">
            {data.providers.length > 0 ? (
              data.providers.map((item) => (
                <Link
                  key={item.entry_id}
                  to="/api-keys/$keyScope/$entryId"
                  params={{ keyScope: item.scope, entryId: item.entry_id }}
                  className="record-item"
                >
                  <div>
                    <strong>{item.display_name}</strong>
                    <p>{item.provider_key}</p>
                  </div>
                  <KeyStatusBadge configured={item.configured} />
                </Link>
              ))
            ) : (
              <p className="muted">还没有 Provider 凭据。</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function ApiKeyDetailPage() {
  const token = getStoredToken();
  const { keyScope, entryId } = useParams({ from: "/api-keys/$keyScope/$entryId" });
  const query = useApiKeyDetail(token, keyScope, entryId);

  if (query.isLoading) {
    return <ConsolePageLoading />;
  }

  const detail = query.data;
  if (!detail) {
    return <ConsoleNotFound title="API Key 数据不存在" />;
  }

  const systemEntry: SystemApiKeyEntry | null =
    keyScope === "system" && detail.scope === "system" ? detail : null;
  const providerEntry: ProviderApiKeyEntry | null =
    keyScope === "provider" && detail.scope === "provider" ? detail : null;

  if (!systemEntry && !providerEntry) {
    return <ConsoleNotFound title="API Key 项不存在" />;
  }

  return (
    <section className="page-panel detail-page">
      <div className="detail-header">
        <div>
          <span className="eyebrow">
            <KeyRound size={14} />
            API Key Detail
          </span>
          <h2>{systemEntry?.label ?? providerEntry?.display_name}</h2>
          <p className="muted">{systemEntry?.env_name ?? providerEntry?.provider_key}</p>
        </div>
        <PageBackLink to="/api-keys">返回 API Keys</PageBackLink>
      </div>

      <div className="detail-grid">
        <StatCard icon={<KeyRound size={18} />} label="状态" value={(systemEntry?.configured ?? providerEntry?.configured) ? "已配置" : "未配置"} />
        <StatCard icon={<ShieldCheck size={18} />} label="类型" value={keyScope === "system" ? "系统令牌" : "Provider 凭据"} />
        <StatCard icon={<Activity size={18} />} label="最近更新时间" value={formatDateTime(providerEntry?.updated_at ?? null)} />
      </div>

      <div className="panel detail-card">
        <h3>详细信息</h3>
        <dl>
          <dt>配置方式</dt>
          <dd>{keyScope === "system" ? "环境变量" : "数据库加密存储"}</dd>
          {systemEntry ? (
            <>
              <dt>环境变量</dt>
              <dd><code>{systemEntry.env_name}</code></dd>
              <dt>用途</dt>
              <dd>{systemEntry.description}</dd>
            </>
          ) : null}
          {providerEntry ? (
            <>
              <dt>Provider Key</dt>
              <dd>{providerEntry.provider_key}</dd>
              <dt>显示名称</dt>
              <dd>{providerEntry.display_name}</dd>
              <dt>密钥提示</dt>
              <dd>{providerEntry.key_hint ?? "hidden"}</dd>
              <dt>启用状态</dt>
              <dd>{providerEntry.enabled ? "已启用" : "已停用"}</dd>
            </>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

export function UsagePage() {
  const token = getStoredToken();
  const query = useUsageOverview(token);

  if (query.isLoading) {
    return <ConsolePageLoading />;
  }

  const data = query.data;
  if (!data) {
    return <ConsoleNotFound title="使用记录不存在" />;
  }

  return (
    <section className="page-panel">
      <div className="list-header">
        <div>
          <h2>使用记录</h2>
          <p className="muted">最近请求的调用情况、成功率和 Provider 分布。</p>
        </div>
      </div>

      <div className="stats-grid">
        <StatCard icon={<BarChart3 size={18} />} label="请求数" value={formatNumber(data.totals.requests)} />
        <StatCard icon={<ShieldCheck size={18} />} label="成功率" value={formatPercent(data.totals.success_rate)} />
        <StatCard icon={<Activity size={18} />} label="平均延迟" value={`${formatNumber(data.totals.avg_latency_ms)} ms`} />
      </div>

      <div className="panel detail-card">
        <h3>Provider 维度</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>请求</th>
              <th>成功率</th>
              <th>平均延迟</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {data.providers.map((provider) => (
              <tr key={provider.provider_key}>
                <td>{provider.provider_key}</td>
                <td>{formatNumber(provider.request_count)}</td>
                <td>{formatPercent(provider.request_count > 0 ? provider.success_count / provider.request_count : 0)}</td>
                <td>{formatNumber(provider.avg_latency_ms)} ms</td>
                <td>{formatNumber(provider.total_tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel detail-card">
        <h3>最近请求</h3>
        <div className="record-list">
          {data.recent_requests.map((trace) => (
            <Link
              key={trace.trace_id}
              to="/usage/$traceId"
              params={{ traceId: trace.trace_id }}
              className="record-item"
            >
              <div>
                <strong>{trace.selected_provider ?? "unassigned"}</strong>
                <p>{trace.selected_model ?? trace.normalized_model}</p>
              </div>
              <div className="record-meta">
                <TraceStatusBadge status={trace.status} />
                <span>{formatNumber(trace.total_tokens)} tokens</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

export function UsageDetailPage() {
  const token = getStoredToken();
  const { traceId } = useParams({ from: "/usage/$traceId" });
  const query = useUsageDetail(token, traceId);

  if (query.isLoading) {
    return <ConsolePageLoading />;
  }

  const trace = query.data;
  if (!trace) {
    return <ConsoleNotFound title="使用记录不存在" />;
  }

  return (
    <TraceDetailPanel
      trace={trace}
      title="请求详情"
      eyebrowIcon={<BarChart3 size={14} />}
      eyebrowText="Usage Detail"
      backTo="/usage"
    />
  );
}

export function TraceListPage() {
  const token = getStoredToken();
  const query = useTraceList(token, 100);

  if (query.isLoading) {
    return <ConsolePageLoading />;
  }

  const data = query.data;
  if (!data) {
    return <ConsoleNotFound title="Trace 数据不存在" />;
  }

  return (
    <section className="page-panel">
      <div className="list-header">
        <div>
          <h2>Trace 列表</h2>
          <p className="muted">查看每次选路为什么命中这个 Provider 和模型。</p>
        </div>
      </div>

      <div className="record-list">
        {data.data.length > 0 ? (
          data.data.map((trace) => (
            <Link
              key={trace.trace_id}
              to="/trace/$traceId"
              params={{ traceId: trace.trace_id }}
              className="record-item"
            >
              <div>
                <strong>{trace.selected_provider ?? "unassigned"}</strong>
                <p>
                  {trace.selected_model ?? trace.normalized_model} · {formatDateTime(trace.timestamp)}
                </p>
              </div>
              <div className="record-meta">
                <TraceStatusBadge status={trace.status} />
                <span>{trace.policy_hits.join(", ") || "无策略命中"}</span>
              </div>
            </Link>
          ))
        ) : (
          <p className="muted">还没有 trace 记录。</p>
        )}
      </div>
    </section>
  );
}

export function TraceDetailPage() {
  const token = getStoredToken();
  const { traceId } = useParams({ from: "/trace/$traceId" });
  const query = useTraceDetail(token, traceId);

  if (query.isLoading) {
    return <ConsolePageLoading />;
  }

  const trace = query.data;
  if (!trace) {
    return <ConsoleNotFound title="Trace 不存在" />;
  }

  return (
    <TraceDetailPanel
      trace={trace}
      title="Trace 详情"
      eyebrowIcon={<Route size={14} />}
      eyebrowText="Trace Detail"
      backTo="/trace"
    />
  );
}

export function TokensPage() {
  const token = getStoredToken();
  const query = useTokensOverview(token);

  if (query.isLoading) {
    return <ConsolePageLoading />;
  }

  const data = query.data;
  if (!data) {
    return <ConsoleNotFound title="Token 统计不存在" />;
  }

  return (
    <section className="page-panel">
      <div className="list-header">
        <div>
          <h2>Token 使用量</h2>
          <p className="muted">按 Provider 和模型查看最近请求的 token 消耗情况。</p>
        </div>
      </div>

      <div className="detail-grid">
        <StatCard icon={<Activity size={18} />} label="输入 Tokens" value={formatNumber(data.totals.input_tokens)} />
        <StatCard icon={<Activity size={18} />} label="输出 Tokens" value={formatNumber(data.totals.output_tokens)} />
        <StatCard icon={<Activity size={18} />} label="总 Tokens" value={formatNumber(data.totals.total_tokens)} />
      </div>

      <div className="split-grid">
        <div className="panel detail-card">
          <h3>Provider 排名</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>请求</th>
                <th>总 Tokens</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((provider) => (
                <tr key={provider.provider_key}>
                  <td>{provider.provider_key}</td>
                  <td>{formatNumber(provider.request_count)}</td>
                  <td>{formatNumber(provider.total_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel detail-card">
          <h3>模型排名</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>Provider</th>
                <th>总 Tokens</th>
              </tr>
            </thead>
            <tbody>
              {data.models.slice(0, 20).map((model) => (
                <tr key={`${model.provider_key ?? "none"}-${model.model}`}>
                  <td>{model.model}</td>
                  <td>{model.provider_key ?? "unassigned"}</td>
                  <td>{formatNumber(model.total_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function PoliciesPage() {
  const token = getStoredToken();
  const query = usePoliciesList(token);

  if (query.isLoading) {
    return <ConsolePageLoading />;
  }

  const data = query.data;
  if (!data) {
    return <ConsoleNotFound title="策略配置不存在" />;
  }

  return (
    <section className="page-panel">
      <div className="list-header">
        <div>
          <h2>Policies</h2>
          <p className="muted">查看每个策略的阈值、权重和被哪些 route 使用。</p>
        </div>
      </div>

      <div className="record-list">
        {data.data.map((policy) => (
          <Link
            key={policy.policy_id}
            to="/policies/$policyId"
            params={{ policyId: policy.policy_id }}
            className="record-item"
          >
            <div>
              <strong>{policy.policy_id}</strong>
              <p>{policy.route_count} 条 route</p>
            </div>
            <div className="record-meta">
              {policy.is_default ? <span className="badge success">默认策略</span> : null}
              <span>{policy.fallback_enabled ? "允许回退" : "禁止回退"}</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function PolicyDetailPage() {
  const token = getStoredToken();
  const { policyId } = useParams({ from: "/policies/$policyId" });
  const query = usePolicyDetail(token, policyId);

  if (query.isLoading) {
    return <ConsolePageLoading />;
  }

  const policy = query.data;
  if (!policy) {
    return <ConsoleNotFound title="Policy 不存在" />;
  }

  return (
    <section className="page-panel detail-page">
      <div className="detail-header">
        <div>
          <span className="eyebrow">
            <ScrollText size={14} />
            Policy Detail
          </span>
          <h2>{policy.policy_id}</h2>
          <p className="muted">{policy.is_default ? "当前默认策略" : "非默认策略"}</p>
        </div>
        <PageBackLink to="/policies">返回 Policies</PageBackLink>
      </div>

      <div className="detail-grid">
        <StatCard icon={<ScrollText size={18} />} label="绑定 Routes" value={formatNumber(policy.route_count)} />
        <StatCard icon={<ShieldCheck size={18} />} label="最小信任等级" value={policy.min_trust_level} />
        <StatCard icon={<Route size={18} />} label="Sticky Session" value={policy.sticky_session ? "开启" : "关闭"} />
      </div>

      <div className="split-grid">
        <div className="panel detail-card">
          <h3>Thresholds</h3>
          <pre className="code-block">{JSON.stringify(policy.thresholds, null, 2)}</pre>
        </div>
        <div className="panel detail-card">
          <h3>Weights</h3>
          <pre className="code-block">{JSON.stringify(policy.weights, null, 2)}</pre>
        </div>
      </div>

      <div className="panel detail-card">
        <h3>关联 Routes</h3>
        <ul className="model-list expanded">
          {policy.routes.length > 0 ? policy.routes.map((routeId) => <li key={routeId}>{routeId}</li>) : <li>暂无</li>}
        </ul>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const token = getStoredToken();
  const query = useSettingsList(token);

  if (query.isLoading) {
    return <ConsolePageLoading />;
  }

  const data = query.data;
  if (!data) {
    return <ConsoleNotFound title="系统设置不存在" />;
  }

  return (
    <section className="page-panel">
      <div className="list-header">
        <div>
          <h2>Settings</h2>
          <p className="muted">查看当前运行配置和关键路径，不再散落到多个文件里找。</p>
        </div>
      </div>

      <div className="record-list">
        {data.data.map((section) => (
          <Link
            key={section.section_id}
            to="/settings/$sectionId"
            params={{ sectionId: section.section_id }}
            className="record-item"
          >
            <div>
              <strong>{section.label}</strong>
              <p>{section.description}</p>
            </div>
            <div className="record-meta">
              <span>{section.items.length} 项</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function SettingsDetailPage() {
  const token = getStoredToken();
  const { sectionId } = useParams({ from: "/settings/$sectionId" });
  const query = useSettingsDetail(token, sectionId);

  if (query.isLoading) {
    return <ConsolePageLoading />;
  }

  const section = query.data;
  if (!section) {
    return <ConsoleNotFound title="设置分组不存在" />;
  }

  return (
    <section className="page-panel detail-page">
      <div className="detail-header">
        <div>
          <span className="eyebrow">
            <Settings size={14} />
            Settings Detail
          </span>
          <h2>{section.label}</h2>
          <p className="muted">{section.description}</p>
        </div>
        <PageBackLink to="/settings">返回 Settings</PageBackLink>
      </div>

      <div className="panel detail-card">
        <h3>配置项</h3>
        <dl>
          {section.items.map((item) => (
            <div key={item.key} className="settings-row">
              <dt>{item.label}</dt>
              <dd><code>{item.value}</code></dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
