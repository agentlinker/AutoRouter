# AutoRouter

AutoRouter 是一个本地模型路由网关。它把用户配置的 provider、endpoint、account、model 和 route 组织成一个可解释、可观测的本地调用层。

## Language

**Provider**:
逻辑供应方，用于表达一组模型来源的业务身份。
_Avoid_: 平台, 厂商入口

**Endpoint**:
某个 **Provider** 暴露出来的具体协议接入面，通常绑定一个 `base_url`。
_Avoid_: 平台, 站点

**Endpoint Key**:
Endpoint 在 Provider 内的只读稳定标识。当前每种协议最多一个 Endpoint，因此由服务端
按 wire protocol 自动生成：`openai-responses`、`openai-chat-completions` 或
`anthropic-messages`；用户和客户端不负责填写。测试请求中的 `endpoint_key` 只是
引用这个既有标识，不是另一套配置。
_Avoid_: User-defined endpoint name, Model endpoint ownership

**Account**:
AutoRouter 内部的上游凭证承载单元，用于表达访问某个 **Provider** 的认证信息、
额度和运行状态。Account 不绑定协议或 Endpoint，默认可用于该 Provider 下所有
enabled Endpoint。
_Avoid_: 用户, 平台账号

**API Key**:
一种具体凭证值；在本地 `config.yaml` 中允许直写，但运行时仍归一化到 **Account**。
_Avoid_: Account

**Account-Endpoint**:
某个 Account 是否能使用某个 Endpoint 的权限和运行状态。它是多对多关系，不表示
Account 归属于 Endpoint。没有记录表示 `unknown`，允许首次调用或手动测试。
_Avoid_: Account ownership, Protocol-bound credential

**Model Catalog**:
某个 **Provider** 的模型目录来源。可以通过显式 `model_catalog_url` 配置，也可以
从 Provider 的 Endpoint 推导。模型目录来源不等同于推理协议或 Endpoint 归属。
_Avoid_: Endpoint models, Protocol models

**Account-Endpoint-Model**:
某个 Account 使用某个 Endpoint 调用某个 Provider-Model 的实测运行状态。它是运行时
观测，不是凭证绑定或模型权限。没有记录表示 `unknown`，仍允许路由和手动测试。
_Avoid_: Account-Endpoint binding, Endpoint model ownership

## Relationships

- 一个 **Provider** 可以拥有一个或多个 **Endpoint**
- 每个 **Endpoint** 的 Endpoint Key 由服务端按协议生成并只读返回；协议变更属于 Endpoint 身份变更
- 一个 **Provider** 可以拥有一个或多个 **Account**
- 一个 **Account** 默认可用于该 Provider 下所有 enabled **Endpoint**，不绑定协议
- 一个 **Endpoint** 只表达推理协议、请求地址、认证形式和能力，不持久化绑定 Account
- 一个 **Account-Endpoint** 表达凭证在特定 wire protocol 接入面上的权限和运行状态
- 一个 **Provider-Model** 表达 Provider 下共享的模型定义和公共元数据，不属于发现它的 Endpoint
- 一个 **Account-Model** 表达具体 Account/key 对 Provider-Model 的可见性和人工启用状态
- 一个 **Account-Endpoint-Model** 表达具体三元组合的连通性、冷却和错误状态
- 运行时调度候选由 Provider、Endpoint、Account 和 Model 动态组合，不把该组合反写为凭证绑定

## API Key / Protocol Boundary

Provider 的 API Key 不和协议绑定。Wire protocol 属于 **Endpoint**：它精确描述
上游请求和响应契约。当前只允许 `openai-responses`、
`openai-chat-completions` 和 `anthropic-messages`。

入站路径与上游 wire protocol 是硬边界：`/v1/responses` 只使用
`openai-responses`，`/v1/chat/completions` 只使用 `openai-chat-completions`，
`/v1/messages` 只使用 `anthropic-messages`。AutoRouter 不做跨协议转换，也不把
另一个协议当作 fallback。同协议内仍可在 Provider、Endpoint 和 Account 候选间
fallback；流式响应已经输出字节后不能再切换候选。

**Provider** 只保留 `enabled` 作为人工总开关，不维护动态调度状态。连接健康属于
**Endpoint**，明确的全局凭证或账单问题属于 **Account**，特定协议面的凭证、group
或路径权限属于 **Account-Endpoint**，模型目录权限属于 **Account-Model**，具体
协议组合的模型请求错误属于 **Account-Endpoint-Model**。

模型公共定义归因到 **Provider-Model**，模型可见性和账户维度运行态归因到
**Account-Model**。不同 API Key 可能来自不同订阅 tier、组织、余额或模型白名单，
因此每个 Account 仍使用 Provider 的 Model Catalog 分别同步；同步时复用同一份
Provider-Model 定义，只建立各自的 Account-Model 关联。路由时只使用该 Account
可见且仍可调度的模型。

一个 Provider 默认只有一份共享 Model Catalog。不同 wire protocol Endpoint 只负责
推理，不分别拥有模型目录。目录中出现某个模型不代表该模型必然支持所有协议。
具体组合通过 Admin 手动测试或实际请求懒验证；成功或失败只更新对应
Account-Endpoint-Model，不污染同一模型的其它 Endpoint。模型发现不批量创建三元
组合记录。
状态机实现见 `src/runtime/runtimeStatus.ts` 和 `src/runtime/runtimeStatusService.ts`。

## Failure Attribution Boundary

上游错误只能提供 HTTP 状态、机器可读错误字段、响应头和 message 等证据；这些证据
不保证能唯一确定故障范围。Adapter 必须保留原始证据，并产出包含 `kind`、`scope`、
`confidence` 和 `retryable` 的结构化错误。运行状态服务只按结构化 scope 更新状态，
不再次从 message 推断。

- 只有明确的 `invalid_api_key`、撤销或过期等机器可读证据可以禁用整个 Account
- 普通 `401` 默认只影响 Account-Endpoint
- 普通 `403` 或 group/path dispatch 禁止只影响 Account-Endpoint
- 明确的模型不存在、模型权限或模型限流只影响 Account-Endpoint-Model
- DNS、TLS、连接失败或协议路径整体不可达影响 Endpoint
- 请求参数错误不改变 Provider、Endpoint、Account 或 Model 的运行状态
- 无法确定 scope 时记录 `unknown`；启发式规则不能扩大故障半径

## Connectivity Test Boundary

“测试模型”是一次指定 Account、Model 和 Endpoint 的真实最小请求，不是模型发现。

- Account 决定使用哪个 key。
- Model 必须存在于该 Account 的 Account-Model 可见集合。
- Endpoint 由用户独立选择；UI 从 Provider 的既有 Endpoint 下拉框取得
  `endpoint_key` 并显式提交，不提供手工文本输入。
- 缺少 Account-Endpoint 记录表示协议面权限 `unknown`，不能阻止首次测试。
- 测试 API 的 `endpoint_key` 必填。后端不从 Account、Model、第一个 enabled
  Endpoint 或第一个 Endpoint 推断。
- 缺少 Account-Endpoint-Model 记录表示 `unknown`，不能阻止测试。
- 测试成功后创建或更新该三元组合为可用。
- 测试失败后只更新该三元组合的错误、冷却或不可用状态。
- 手动“清除状态”恢复为 `unknown`；不能直接伪造为“可用”。
- 只有真实测试或实际请求成功才能把组合标记为可用。

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

客户端请求头采用黑名单过滤，其余默认透传，包括 Claude Code 身份和 Anthropic beta header。
黑名单包含 `authorization`、`x-api-key`、`proxy-authorization`、`cookie`、`cookie2`，
所有 `x-autorouter-*` 内部头和 HTTP/2 伪头，以及 `connection`、`keep-alive`、
`proxy-connection`、`proxy-authenticate`、`te`、`trailer`、`transfer-encoding`、
`upgrade`、`expect`。`Connection` 指定的字段也会动态剔除。
`host`、`content-length`、`content-type`、`content-encoding` 不沿用入站值，
因为上游 URL 和 JSON 请求体由 adapter 重建。`accept-encoding` 不透传，避免
当前未解压响应的 adapter 请求到压缩数据。未知自定义头可能包含敏感信息，调用方需自行审查。
上游请求头合并顺序为：内建 header → 黑名单过滤后的 header → Endpoint
`custom_headers` → Account 凭证 header。因此 `custom_headers` 可以覆盖
`originator` / `user-agent`，但不能覆盖 `authorization` / `x-api-key` 等认证
header。

## Example dialogue

> **Dev:** “我想直接给 provider 配 `base_url` 和 `api_key`，可以吗？”
> **Domain expert:** “可以，但那只是本地配置输入形式；运行时仍然会把凭证归一化成 **Account**。”

> **Dev:** “同一个 API Key 要分别绑定 OpenAI 和 Anthropic Endpoint 吗？”
> **Domain expert:** “不要。API Key 属于 Provider Account；运行时再与该 Provider 的 enabled Endpoint 动态组合。”

> **Dev:** “某个 group 不允许 `/v1/messages`，是不是 Account 应该绑定协议？”
> **Domain expert:** “不是。把失败记录到 Account-Endpoint，只阻止这份凭证使用 `anthropic-messages`，不要影响同一 Account 的其它协议面。”

> **Dev:** “Anthropic Endpoint 没有 `/models`，是不是不能同步模型？”
> **Domain expert:** “不是。Model Catalog 独立于推理 Endpoint；优先使用显式 `model_catalog_url`，否则从 Provider Endpoint 推导一次。”

> **Dev:** “测试模型时，Endpoint 要跟着 API Key 联动吗？”
> **Domain expert:** “不要。Key 属于 Account，Endpoint 独立选择；测试结果记录到 Account-Endpoint-Model。”

> **Dev:** “冷却中的组合可以手动改成可用吗？”
> **Domain expert:** “不能伪造成功。可以重新测试，或清除状态回到 `unknown`，让后续请求重新验证。”

> **Dev:** “客户端传来的 `metadata` 要不要原样给上游？”
> **Domain expert:** “不要。`metadata` 是 AutoRouter 内部语义；需要给上游的内容放到 `upstream_metadata`。”

> **Dev:** “客户端请求头要不要原样给上游？”
> **Domain expert:** “默认透传黑名单之外的字段；网关凭证、内部头、连接控制头和需要重建的传输头不透传，特殊 provider 用 Endpoint `custom_headers` 显式覆盖。”

## Flagged ambiguities

- “provider 配 apiKey” 容易和内部 **Account** 概念混淆；已解决：本地配置允许直写 `api_key`，但运行时概念仍是 **Account**。
- “Account 属于 Endpoint”是旧模型；已解决：Account 属于 Provider，Endpoint 只在
  运行时路由候选中与 Account 组合。
- “模型由某个 Endpoint 发现”不等于“模型属于该 Endpoint”；已解决：
  **Provider-Model** 保存共享定义，**Account-Model** 保存 key 的可见性，
  Model Catalog 独立于推理协议。
- “API Key 绑定协议”是错误边界；已解决：Provider Account 不保存 Endpoint /
  protocol 归属，协议面权限单独记录在 Account-Endpoint。
- “OpenAI-compatible”表示同时支持 Responses 和 Chat Completions 是错误推断；已解决：
  两者是独立 wire protocol，必须分别配置和验证。
- “协议匹配只是软偏好”会导致静默语义转换；已解决：入站路径和 Endpoint wire
  protocol 硬匹配，不允许跨协议 fallback。
- “测试请求填写 Endpoint Key”等同于“用户自定义 Endpoint Key”是错误理解；已解决：
  Endpoint Key 由服务端按协议生成，测试 UI 只选择并提交既有值，后端不做缺省推断。
- “三元组合状态”等同于“Account 绑定 Endpoint”是错误边界；已解决：
  Account-Endpoint-Model 只保存实测状态，缺记录为 `unknown`。
- “模型发现成功”等同于“所有协议都能调用”是错误推断；已解决：
  Model Catalog 只建立 Provider-Model 和 Account-Model，协议兼容性由手动测试或
  实际请求懒验证。
- “任意 `401/403` 都证明 Key 全局无效”是错误归因；已解决：普通鉴权或访问拒绝默认
  只改变 **Account-Endpoint**，只有明确的全局凭证证据才改变 **Account**。
- “模型不可用”等同于“Key 不可用”是错误归因；已解决：模型错误改变
  **Account-Endpoint-Model**，连接故障改变 **Endpoint**，协议面权限错误改变
  **Account-Endpoint**。
- “metadata 透传”等同于“用户原始字段透传”是错误边界；已解决：
  `metadata` 归 AutoRouter 内部消费，`upstream_metadata` 才表达上游 body
  `metadata`。
- “header 透传”等同于“客户端 header 全量转发”是安全风险；已解决：黑名单剔除
  网关凭证、内部头和传输控制头，其余默认透传。Endpoint `custom_headers` 仍是显式配置，
  不受入站黑名单过滤，但不能覆盖 Account 认证头。
