# AutoRouter Runtime Status

本文档描述 AutoRouter 当前的运行态层级、错误归因和恢复规则。当前实现日期为
2026-08-11。

## 状态层级

动态运行态分为三层：

1. `Account`
2. `Provider-Model`
3. `Account-Model`

`Provider` 不维护动态 `runtime_status`，只保留人工控制的 `enabled` 总开关。
Provider 启用后，候选是否可调度由 Endpoint、Account 和模型作用域各自决定。

`Account` 是具体凭证承载单元，通常对应一个 API Key。

`Provider-Model` 表示某个 Provider 共享的模型状态。`Account-Model` 表示某个
Account 下某个模型的独立状态。

### 模型状态作用域

模型错误最终写入哪一层，由 Provider 的 `model_availability_scope` 决定：

- `per_account`：写入 `Account-Model`。只影响实际失败的 Key 和模型组合。
- `shared_by_provider`：写入 `Provider-Model`。影响该 Provider 下所有 Key 的对应模型。

Admin Provider 列表在 `per_account` 模式下展示的是 `Account-Model` 状态。

## 状态值

| 状态 | 含义 | 是否自动恢复 |
| --- | --- | --- |
| `normal` | 正常，可参与调度 | 不适用 |
| `rate_limited` | 触发限流退避 | 冷却到期后可重试 |
| `cooling_down` | 临时错误冷却 | 冷却到期后可重试 |
| `disabled` | 鉴权或账单异常 | 需要人工恢复 |
| `abnormal` | 永久异常或冷却阶梯转永久 | 需要人工恢复 |

`enabled` 与 `runtime_status` 是两个不同维度。Provider、Endpoint、Account 和 Model
可以使用 `enabled=false` 表示人工关闭；只有 Account 和模型作用域维护请求执行过程中
产生的 `runtime_status`。

## 错误归因

| 上游结果 | 归因层级 | 状态变化 | 影响范围 |
| --- | --- | --- | --- |
| HTTP `401/403` | `Account` | `disabled / auth_failed` | 当前 Key 的所有模型 |
| HTTP `402` | `Account` | `disabled / billing_failed` | 当前 Key 的所有模型 |
| 无法建立连接，例如 DNS、连接拒绝、socket 断开 | `Account` | `cooling_down / error_cooldown` | 当前 Key 的所有模型 |
| HTTP `429` | `Account-Model` 或 `Provider-Model` | `rate_limited` | 对应模型作用域 |
| HTTP `404/410` | `Account-Model` 或 `Provider-Model` | `cooling_down / model_unavailable` | 对应模型作用域 |
| HTTP `408` 或 `5xx` | `Account-Model` 或 `Provider-Model` | `cooling_down / upstream_error_cooldown` | 对应模型作用域 |
| HTTP `400/409/413/422` | 不改变运行态 | 只记录最后错误 | 不过滤候选 |
| 未知非 HTTP 异常 | `Account` | `cooling_down / error_cooldown` | 当前 Key 的所有模型 |

中转 Provider 可能透传其内部渠道的任意 HTTP 状态。因此，HTTP `408/5xx`
不能证明 Key 或整个 Provider 不可用，只冷却实际失败的模型作用域。

只有无法连接 Provider 的传输层异常才升级到 `Account`，因为此时无法证明问题只和
某个模型有关。

正常请求链路不会因为单次请求失败自动修改 Provider。需要人工停止整个 Provider 时，
直接设置 `Provider.enabled=false`。

如果未来需要持久化 Provider 接入面的连接健康状态，应归属到 `Endpoint`，而不是重新
引入 Provider 运行态，因为同一个 Provider 可以有多个协议 Endpoint。

## 成功与恢复

请求成功时：

- 可恢复的 `Account` 冷却状态重置为 `normal`。
- `per_account` Provider 只重置对应的 `Account-Model`。
- `shared_by_provider` Provider 重置对应的 `Provider-Model`。
- 根据 `clear_counters_on_success` 决定是否清空 strike 和错误计数。

以下状态不会被一次成功请求自动清除：

- `disabled`
- `abnormal`
- `rate_limited_permanent`
- reason 以 `_permanent` 结尾的状态

这些状态需要通过后台人工启用操作恢复。

人工启用 Account 时，会将 Account 状态和计数重置为 `normal`。人工启用 Model
时，会将 Provider-Model 以及关联的 Account-Model 状态和计数重置为 `normal`。

## 冷却阶梯

运行态配置位于 `runtime_status` 设置段：

| 配置项 | 用途 |
| --- | --- |
| `rate_limit_backoff_seconds` | HTTP `429` 的模型限流冷却阶梯 |
| `error_backoff_seconds` | HTTP `408/5xx` 的模型冷却，以及连接失败的 Account 冷却阶梯 |
| `model_unavailable_backoff_seconds` | HTTP `404/410` 的模型下线冷却阶梯 |
| `permanent_after_final_backoff` | `429` 走完阶梯后是否转永久 |
| `error_permanent_after_final_backoff` | 错误冷却走完阶梯后是否转 `abnormal` |
| `clear_counters_on_success` | 成功后是否清空错误计数 |
| `auth_disables_account` | 是否把 `401/403` 作为当前 Account 的凭证禁用处理 |

冷却到期后，候选不需要等待配置重载即可重新参与调度。下一次成功请求会把持久化状态
恢复为 `normal`。

## 调度过滤顺序

候选可用性按以下层级检查：

1. Provider 的 `enabled`
2. 当前候选的 Account-Model，存在时优先
3. Provider-Model，作为共享模型状态或兼容回退
4. Endpoint 的 `enabled` 和健康状态
5. Account
6. 配额、隐私、能力和上下文窗口等策略条件

`Account-Model` 的状态键包含完整 Account ID 和 Model Key，因此一个 Key 的模型错误
不会污染同 Provider 的其他 Key。

## 示例

假设 `sotamodel` 使用 `per_account`，Key `key-a` 同时支持：

- `gpt-5.6-sol`
- `claude-opus-5`

当 `key-a + gpt-5.6-sol` 返回 HTTP `503`：

- `Provider.enabled` 保持 `true`。
- `key-a` 对应的 `Account` 保持 `normal`。
- `key-a + gpt-5.6-sol` 进入 `cooling_down`。
- `key-a + claude-opus-5` 仍可调度。
- 其他 Key 的 `gpt-5.6-sol` 仍可调度。

如果错误是无法连接 `sotamodel`，则 `key-a` 对应的 Account 进入冷却，该 Key 下所有
模型暂时停止调度。

## 实现位置

- 错误分类：`src/runtime/runtimeStatus.ts`
- 状态归因与恢复：`src/runtime/runtimeStatusService.ts`
- 持久化：`src/repositories/managedProviderRepository.ts`
- 运行态投影：`src/runtime/runtimeConfigProjector.ts`
- 候选过滤：`src/routing/routeEngine.ts`
- 数据表：`src/db/schema.ts`

## 数据兼容

历史数据库中的 `managed_providers.runtime_status` 及相关状态列暂时保留，避免升级时
重建表或破坏旧数据。运行时、调度和 Admin UI 不再读取或展示这些字段。后续独立的
数据库清理 migration 可以在确认没有旧版本回滚需求后删除这些列。

历史设置键 `auth_disables_provider` 不再读取或迁移。缺少 `auth_disables_account` 时使用
默认值 `true`；下一次保存运行态设置时，持久化内容只包含新键。
