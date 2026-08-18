# AutoRouter

AutoRouter 是一个本地模型路由网关。它把用户配置的 provider、endpoint、account、model 和 route 组织成一个可解释、可观测的本地调用层。

## Language

**Provider**:
逻辑供应方，用于表达一组模型来源的业务身份。
_Avoid_: 平台, 厂商入口

**Endpoint**:
某个 **Provider** 暴露出来的具体协议接入面，通常绑定一个 `base_url`。
_Avoid_: 平台, 站点

**Account**:
AutoRouter 内部的凭证承载单元，用于表达访问某个 **Endpoint** 所需的认证信息。
_Avoid_: 用户, 平台账号

**API Key**:
一种具体凭证值；在本地 `config.yaml` 中允许直写，但运行时仍归一化到 **Account**。
_Avoid_: Account

## Relationships

- 一个 **Provider** 可以拥有一个或多个 **Endpoint**
- 一个 **Endpoint** 可以关联一个或多个 **Account**
- 一个 **Account** 为访问一个 **Endpoint** 提供认证信息
- 一个 **Provider-Model** 表达 Provider 共享的模型运行态
- 一个 **Account-Model** 表达具体 Account 与 Model 组合的独立运行态

**Provider** 只保留 `enabled` 作为人工总开关，不维护动态调度状态。连接健康属于
**Endpoint**，凭证问题属于 **Account**，模型请求错误属于对应模型作用域。

当 `model_availability_scope=per_account` 时，模型错误归因到 **Account-Model**；
当 `model_availability_scope=shared_by_provider` 时，模型错误归因到
**Provider-Model**。完整状态规则见 `docs/runtime-status.md`。

## Request Boundary

AutoRouter 是路由网关，不是原始 HTTP 隧道。客户端请求进入 AutoRouter 后，
请求体和请求头会先被解释为 AutoRouter 的路由输入，再由 adapter 按上游协议
重新构造请求。

`metadata` 是 AutoRouter 内部请求元数据，供路由、trace、sticky session 和
上下文估算使用。典型字段包括 `session_id`、`privacy_level`、`context_tokens`
或 `context_tokens_est`。这些字段默认不透传给 OpenAI-compatible 上游，避免
把内部路由信号泄给第三方，也避免严格兼容站因未知字段拒绝请求。

当客户端确实希望上游收到 OpenAI 风格的 `metadata` body 字段时，应使用
`upstream_metadata`。OpenAI-compatible adapter 会把 `upstream_metadata` 映射
成上游请求体里的 `metadata`，但不会透传 AutoRouter 的内部 `metadata`。

客户端请求头不会整体透传给上游。AutoRouter 默认只白名单透传身份类 header：
`originator` 和 `user-agent`，用于兼容要求 agentic client 指纹的 relay。
上游请求头合并顺序为：内建 header → 白名单透传 header → Endpoint
`custom_headers` → Account 凭证 header。因此 `custom_headers` 可以覆盖
`originator` / `user-agent`，但不能覆盖 `authorization` / `x-api-key` 等认证
header。

## Example dialogue

> **Dev:** “我想直接给 provider 配 `base_url` 和 `api_key`，可以吗？”
> **Domain expert:** “可以，但那只是本地配置输入形式；运行时仍然会把凭证归一化成 **Account**。”

> **Dev:** “客户端传来的 `metadata` 要不要原样给上游？”
> **Domain expert:** “不要。`metadata` 是 AutoRouter 内部语义；需要给上游的内容放到 `upstream_metadata`。”

> **Dev:** “客户端请求头要不要原样给上游？”
> **Domain expert:** “不要。默认只透传 `originator` 和 `user-agent`，特殊 provider 用 Endpoint `custom_headers` 显式覆盖。”

## Flagged ambiguities

- “provider 配 apiKey” 容易和内部 **Account** 概念混淆；已解决：本地配置允许直写 `api_key`，但运行时概念仍是 **Account**。
- “模型不可用”等同于“Key 不可用”是错误归因；HTTP `408/5xx`、`429`、`404/410`
  默认只改变对应模型作用域，只有连接层故障、鉴权和账单问题才改变 **Account**。
- “metadata 透传”等同于“用户原始字段透传”是错误边界；已解决：
  `metadata` 归 AutoRouter 内部消费，`upstream_metadata` 才表达上游 body
  `metadata`。
- “header 透传”等同于“客户端 header 全量转发”是安全风险；已解决：默认只白名单
  `originator` / `user-agent`，其它上游 header 通过 Endpoint `custom_headers`
  明确配置。
