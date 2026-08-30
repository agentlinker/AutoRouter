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
AutoRouter 内部的上游凭证承载单元，用于表达访问某个 **Provider** 的认证信息、
额度和运行状态。Account 不绑定协议或 Endpoint，默认可用于该 Provider 下所有
enabled Endpoint。
_Avoid_: 用户, 平台账号

**API Key**:
一种具体凭证值；在本地 `config.yaml` 中允许直写，但运行时仍归一化到 **Account**。
_Avoid_: Account

**Model Catalog**:
某个 **Provider** 的模型目录来源。可以通过显式 `model_catalog_url` 配置，也可以
从 Provider 的 Endpoint 推导。模型目录来源不等同于推理协议或 Endpoint 归属。
_Avoid_: Endpoint models, Protocol models

## Relationships

- 一个 **Provider** 可以拥有一个或多个 **Endpoint**
- 一个 **Provider** 可以拥有一个或多个 **Account**
- 一个 **Account** 默认可以访问同一 Provider 下所有 enabled **Endpoint**
- 一个 **Endpoint** 只表达推理协议、请求地址、认证形式和能力，不持久化绑定 Account
- 一个 **Provider-Model** 表达 Provider 下的共享模型定义和公共元数据，不属于发现它的 Endpoint
- 一个 **Account-Model** 表达具体 Account/key 对某个 Provider-Model 的可见性和运行态
- 运行时调度候选由 Provider、Endpoint、Account 和 Model 动态组合，不把该组合反写为持久化绑定

**Provider** 只保留 `enabled` 作为人工总开关，不维护动态调度状态。连接健康属于
**Endpoint**，凭证问题属于 **Account**，模型请求错误属于对应 **Account-Model**。

模型公共定义归因到 **Provider-Model**，模型可见性和账户维度运行态归因到
**Account-Model**。不同 API Key 可能来自不同订阅 tier、组织、余额或模型白名单，
因此每个 Account 仍使用 Provider 的 Model Catalog 分别同步；同步时复用同一份
Provider-Model 定义，只建立各自的 Account-Model 关联。路由时只使用该 Account
可见且仍可调度的模型。

一个 Provider 默认只有一份共享 Model Catalog。OpenAI/Anthropic Endpoint 只负责
推理，不分别拥有模型目录。目录中出现某个模型不等于该模型必然支持所有协议；
具体 model/endpoint 组合由连通性测试确认。
状态机实现见 `src/runtime/runtimeStatus.ts` 和 `src/runtime/runtimeStatusService.ts`。

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

> **Dev:** “同一个 API Key 要分别绑定 OpenAI 和 Anthropic Endpoint 吗？”
> **Domain expert:** “不要。API Key 属于 Provider Account；运行时再与该 Provider 的 enabled Endpoint 动态组合。”

> **Dev:** “Anthropic Endpoint 没有 `/models`，是不是不能同步模型？”
> **Domain expert:** “不是。Model Catalog 独立于推理 Endpoint；优先使用显式 `model_catalog_url`，否则从 Provider Endpoint 推导一次。”

> **Dev:** “客户端传来的 `metadata` 要不要原样给上游？”
> **Domain expert:** “不要。`metadata` 是 AutoRouter 内部语义；需要给上游的内容放到 `upstream_metadata`。”

> **Dev:** “客户端请求头要不要原样给上游？”
> **Domain expert:** “不要。默认只透传 `originator` 和 `user-agent`，特殊 provider 用 Endpoint `custom_headers` 显式覆盖。”

## Flagged ambiguities

- “provider 配 apiKey” 容易和内部 **Account** 概念混淆；已解决：本地配置允许直写 `api_key`，但运行时概念仍是 **Account**。
- “Account 属于 Endpoint”是旧模型；已解决：Account 属于 Provider，Endpoint 只在
  运行时路由候选中与 Account 组合。
- “模型由某个 Endpoint 发现”不等于“模型属于该 Endpoint”；已解决：
  **Provider-Model** 保存共享定义，**Account-Model** 保存 key 的可见性，
  Model Catalog 独立于推理协议。
- “模型不可用”等同于“Key 不可用”是错误归因；HTTP `408/5xx`、`429`、`404/410`
  默认只改变对应模型作用域，只有连接层故障、鉴权和账单问题才改变 **Account**。
- “metadata 透传”等同于“用户原始字段透传”是错误边界；已解决：
  `metadata` 归 AutoRouter 内部消费，`upstream_metadata` 才表达上游 body
  `metadata`。
- “header 透传”等同于“客户端 header 全量转发”是安全风险；已解决：默认只白名单
  `originator` / `user-agent`，其它上游 header 通过 Endpoint `custom_headers`
  明确配置。
