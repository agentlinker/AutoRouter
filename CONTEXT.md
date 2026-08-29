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
按协议自动生成：`openai` 或 `anthropic`；用户和客户端不负责填写。测试请求中的
`endpoint_key` 只是引用这个既有标识，不是另一套配置。
_Avoid_: User-defined endpoint name, Model endpoint ownership

**Account**:
AutoRouter 内部的凭证承载单元，用于表达访问某个 **Provider** 所需的认证信息。
_Avoid_: 用户, 平台账号

**API Key**:
一种具体凭证值；在本地 `config.yaml` 中允许直写，但运行时仍归一化到 **Account**。
_Avoid_: Account

**Model Catalog**:
某个 **Provider** 的模型目录来源。模型目录独立于推理协议和 Endpoint；可以显式配置
`model_catalog_url`，也可以从 Provider 的 Endpoint 推导。
_Avoid_: Endpoint models, Protocol models

**Account-Endpoint-Model**:
某个 Account 使用某个 Endpoint 调用某个 Provider-Model 的实测运行状态。它是运行时
观测，不是凭证绑定或模型权限。没有记录表示 `unknown`，仍允许路由和手动测试。
_Avoid_: Account-Endpoint binding, Endpoint model ownership

## Relationships

- 一个 **Provider** 可以拥有一个或多个 **Endpoint**
- 每个 **Endpoint** 的 Endpoint Key 由服务端按协议生成并只读返回；协议变更属于 Endpoint 身份变更
- 一个 **Provider** 可以拥有一个或多个 **Account**
- 一个 **Account** 默认可用于该 Provider 下所有 **Endpoint**，不绑定协议
- 一个 **Provider-Model** 表达 Provider 下共享的模型定义和公共元数据，不属于发现它的 Endpoint
- 一个 **Account-Model** 表达具体 Account/key 对 Provider-Model 的可见性和人工启用状态
- 一个 **Account-Endpoint-Model** 表达具体三元组合的连通性、冷却和错误状态
- 运行时调度候选由 Provider、Endpoint、Account 和 Model 动态组合，不把该组合反写为凭证绑定

## API Key / Protocol Boundary

Provider 的 API Key 不和协议绑定。协议属于 **Endpoint**：它描述请求应该按
OpenAI-compatible、Anthropic 等哪种上游接口构造；API Key 属于 **Account**：它
描述同一 Provider 下的一份凭证、额度、状态和模型可用性。

路由时入站协议只是软偏好：同协议 Endpoint 优先；没有同协议候选但存在已实现且
语义兼容的 adapter 时，可以走转换路径。不能转换、模型不可用或凭证不可用时，应
返回明确错误，而不是要求用户为同一份 key 选择一个“绑定协议”。

**Provider** 只保留 `enabled` 作为人工总开关，不维护动态调度状态。连接健康属于
**Endpoint**，凭证问题属于 **Account**，模型目录权限属于 **Account-Model**，
具体协议组合的模型请求错误属于 **Account-Endpoint-Model**。

模型公共定义归因到 **Provider-Model**。不同 API Key 可能来自不同订阅 tier、组织、
余额或模型白名单，因此每个 Account 仍使用 Provider 的 Model Catalog 分别同步；
同步时复用同一份 Provider-Model 定义，只建立各自的 Account-Model 关联。

OpenAI/Anthropic Endpoint 默认共享 Provider 模型目录。目录中出现某个模型不代表该
模型必然支持所有协议。具体组合通过 Admin 手动测试或实际请求懒验证；成功或失败只
更新对应 Account-Endpoint-Model，不污染同一模型的其它 Endpoint。模型发现不批量
创建三元组合记录。
状态机实现见 `src/runtime/runtimeStatus.ts` 和 `src/runtime/runtimeStatusService.ts`。

## Connectivity Test Boundary

“测试模型”是一次指定 Account、Model 和 Endpoint 的真实最小请求，不是模型发现。

- Account 决定使用哪个 key。
- Model 必须存在于该 Account 的 Account-Model 可见集合。
- Endpoint 由用户独立选择；UI 从 Provider 的既有 Endpoint 下拉框取得
  `endpoint_key` 并显式提交，不提供手工文本输入。
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

客户端请求头不会整体透传给上游。AutoRouter 默认只白名单透传身份类 header：
`originator` 和 `user-agent`，用于兼容要求 agentic client 指纹的 relay。
上游请求头合并顺序为：内建 header → 白名单透传 header → Endpoint
`custom_headers` → Account 凭证 header。因此 `custom_headers` 可以覆盖
`originator` / `user-agent`，但不能覆盖 `authorization` / `x-api-key` 等认证
header。

## Example dialogue

> **Dev:** “我想直接给 provider 配 `base_url` 和 `api_key`，可以吗？”
> **Domain expert:** “可以，但那只是本地配置输入形式；运行时仍然会把凭证归一化成 **Account**。”

> **Dev:** “测试模型时，Endpoint 要跟着 API Key 联动吗？”
> **Domain expert:** “不要。Key 属于 Account，Endpoint 独立选择；测试结果记录到 Account-Endpoint-Model。”

> **Dev:** “冷却中的组合可以手动改成可用吗？”
> **Domain expert:** “不能伪造成功。可以重新测试，或清除状态回到 `unknown`，让后续请求重新验证。”

> **Dev:** “客户端传来的 `metadata` 要不要原样给上游？”
> **Domain expert:** “不要。`metadata` 是 AutoRouter 内部语义；需要给上游的内容放到 `upstream_metadata`。”

> **Dev:** “客户端请求头要不要原样给上游？”
> **Domain expert:** “不要。默认只透传 `originator` 和 `user-agent`，特殊 provider 用 Endpoint `custom_headers` 显式覆盖。”

## Flagged ambiguities

- “provider 配 apiKey” 容易和内部 **Account** 概念混淆；已解决：本地配置允许直写 `api_key`，但运行时概念仍是 **Account**。
- “API Key 绑定协议”是错误边界；已解决：Provider Account 不保存 Endpoint /
  protocol 绑定，协议只在 Endpoint 层表达。
- “测试请求填写 Endpoint Key”等同于“用户自定义 Endpoint Key”是错误理解；已解决：
  Endpoint Key 由服务端按协议生成，测试 UI 只选择并提交既有值，后端不做缺省推断。
- “三元组合状态”等同于“Account 绑定 Endpoint”是错误边界；已解决：
  Account-Endpoint-Model 只保存实测状态，缺记录为 `unknown`。
- “模型发现成功”等同于“所有协议都能调用”是错误推断；已解决：
  Model Catalog 只建立 Provider-Model 和 Account-Model，协议兼容性由手动测试或
  实际请求懒验证。
- “模型不可用”等同于“Key 不可用”是错误归因；HTTP `408/5xx`、`429`、`404/410`
  默认只改变对应 Account-Endpoint-Model，只有连接层故障、鉴权和账单问题才改变
  **Endpoint** 或 **Account**。
- “metadata 透传”等同于“用户原始字段透传”是错误边界；已解决：
  `metadata` 归 AutoRouter 内部消费，`upstream_metadata` 才表达上游 body
  `metadata`。
- “header 透传”等同于“客户端 header 全量转发”是安全风险；已解决：默认只白名单
  `originator` / `user-agent`，其它上游 header 通过 Endpoint `custom_headers`
  明确配置。
