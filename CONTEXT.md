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

## Example dialogue

> **Dev:** “我想直接给 provider 配 `base_url` 和 `api_key`，可以吗？”
> **Domain expert:** “可以，但那只是本地配置输入形式；运行时仍然会把凭证归一化成 **Account**。”

## Flagged ambiguities

- “provider 配 apiKey” 容易和内部 **Account** 概念混淆；已解决：本地配置允许直写 `api_key`，但运行时概念仍是 **Account**。
- “模型不可用”等同于“Key 不可用”是错误归因；HTTP `408/5xx`、`429`、`404/410`
  默认只改变对应模型作用域，只有连接层故障、鉴权和账单问题才改变 **Account**。
