# 项目状态

## 一、架构健康度

- 模块总数：14，以 `src` 一级目录计。
- 违规跨模块调用：本次调用点审计未发现协议转换或宽协议 adapter 越界。
- 三个入站协议、三个原生 adapter、Account、Endpoint、Account-Endpoint 和 Account-Endpoint-Model 职责已分离。

## 二、本次变更影响范围

- **移除 expiry 硬过滤**：projector、Admin 序列化、SQL 可用性统计均不再因 `expires_at` 已过而排除 Key；到期时间仅用于 Key 池内排序。
- **两阶段调度**：`selectRoute` 先按 Provider 分组排序（priority 降序），组内按 Key 池策略（到期升序 → 最少活跃 → 轮询）选择凭证；sticky 命中置顶。Key 数量不影响跨 Provider 排序。
- **活跃请求计数**：`ActiveRequestTracker` 进程内计数，选择与占用原子完成；流式/非流式均在 `finally` 释放。
- **连接故障短路**：Endpoint 级连接故障跳过同 Endpoint 其余 Key，不再遍历不可达地址。
- **Admin 四视图**：Provider 详情页改为 概览 / API Keys / 模型 / 设置 四个 Tab；API Keys 表支持点击展开协议状态（替代独立连通性大矩阵）。
- **到期时间 tooltip**：统一文案"到期时间越早…不作为过滤条件…不填表示不过期"，列表、创建表单、编辑表单一致。
- **统一可用性投影**：`projectAccountAvailability` / `projectProviderAvailability` 区分人工停用、待验证、部分可用、不可用。
- **Trace 增强**：`session_sticky` 拆分为 `sticky_hit`（实际命中）和 `session_present`（有 session 无 sticky）；`selectRoute` 返回 `stickyHit`。
- 新增 `src/routing/keyPool.ts`、`src/routing/activeRequests.ts`、`tests/routing/keyPool.test.ts`（11 个测试）。
- 接口契约：`RuntimeSnapshot` 新增 `poolCursors` 字段；`selectRoute` 新增 `poolCursors` 参数和 `stickyHit` 返回值；`AccountRuntimeState` 新增 `expires_at`。

## 三、已知风险点

- 同一上游共享预算不会因多个 Key 被重复展示为多份独立容量——当前只展示逐 Key 额度，不做求和。
- sticky 为进程内 Map，无 TTL/持久化，重启丢失。
- Admin 构建成功，但仍有单个压缩后资源块超过 500 kB 的既有构建警告。
- 未记录的 relay message 字符串不会扩大 scope；需要稳定机器码后才能新增 provider profile。

## 四、下次最该做的事

- 补充两阶段调度的集成测试（多 Key 轮换、并发最少活跃、sticky 优先于到期）。
- 大型 Key 池的 UI 分页/筛选。
- 收集真实 relay 的稳定机器错误码，为高频 Provider 增加精确 failure profile。
