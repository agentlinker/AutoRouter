# 项目状态

## 一、架构健康度

- 模块总数：14，以 `src` 一级目录计。
- 违规跨模块调用：本次目录命名调用点审计未发现新增越界调用。
- 三个入站协议、三个原生 adapter、Account、Endpoint、Account-Endpoint 和 Account-Endpoint-Model 职责已分离。

## 二、本次变更影响范围

- Admin 主题设计归档：方案已保存至指定文档目录，文件名为 `2026-10-02-admin-theme-switch-design.md`，确定当前深色与 Wise 两套样式、浏览器独立保存偏好、启动初始化和分阶段验收。主题相关状态记录统一维护在本功能分支。

- Admin Web UI 双主题：新增 `midnight`/`wise` 主题状态工具、浏览器级 `localStorage` 持久化、启动前 `data-theme` 初始化、认证页与控制台切换控件；将 Admin CSS 颜色、表面、状态、焦点、圆角和阴影接入主题 token，并补齐存储异常容错。涉及 `src/admin/index.html`、`src/admin/main.tsx`、`src/admin/routes/providers.tsx`、`src/admin/styles.css`、`src/admin/utils/theme.ts` 及主题测试；不改变服务端接口、数据库或业务路由。验证：全量 54 个测试文件、350 个测试通过，`npm run typecheck` 和 `npm run build:admin` 通过；构建仍有既有大资源块警告，当前环境无可用浏览器做点击验收。

- 模型目录标签修复：保留 `deepseek-v4-flash:0731` 等模型的冒号标签，只剥离已知协议前缀；同步启动迁移中的归一化规则，修正历史逻辑名、默认显示名和模型聚合名，保留人工显示名。涉及两个源文件、三个测试文件及本状态文件；接口字段不变，标签模型的逻辑名恢复完整。验证：修复前六个回归断言失败，修复后全量五十二个测试文件、三百四十四个测试及类型检查通过。
- Trace 明细精简：移除流完整性列，将原因与失败归因合并为失败原因；报错和归因分别展示，每部分超过 120 字符截断，more 弹窗展示原文。Trace 列表移除策略命中列，后台记录与详情请求信息中的策略保持保留。涉及管理端页面、样式、新增失败原因组件及展示工具、回归测试；接口契约不变。验证：35 个相关测试、9 个组件渲染断言、类型检查及管理端构建通过。
- Trace 展示：候选模型仅保留模型名，移除 Endpoint 与实际上游地址列；缺少尝试协议时显示请求协议。列表延迟分两行显示成功尝试首字耗时和整次请求总耗时。涉及管理端页面、类型、Trace 序列化及回归测试；管理接口新增可空的首字耗时字段。验证：31 个相关测试、类型检查及管理端构建通过。
- 入站请求：新增 zstd、gzip、deflate body 解压，并向 Fastify 报告原始编码长度，修复 Codex Responses 压缩请求被 `FST_ERR_CTP_INVALID_CONTENT_LENGTH` 拒绝的问题；新增压缩请求集成测试。

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

- Wise 主题已完成代码级 token 与组件覆盖，但未能在真实浏览器中完成逐页截图/点击验收；原因是当前环境没有可用浏览器后端。

- 本次尚未重启运行服务或修改实际数据库；已有错误目录记录需在更新代码后的下次启动执行迁移才能修正。未知冒号前缀将保留，避免再次截断真实模型标签。
- 失败原因弹窗已验证组件渲染和截断逻辑，尚未对用户给定的长原因 Trace 做浏览器点击实测。
- Trace 首字耗时沿用成功上游尝试的计时，不含此前失败重试；旧记录或失败请求无成功首字记录时显示空值。请求和尝试均未记录协议的旧数据仍显示空值。
- 同一上游共享预算不会因多个 Key 被重复展示为多份独立容量——当前只展示逐 Key 额度，不做求和。
- sticky 为进程内 Map，无 TTL/持久化，重启丢失。
- Admin 构建成功，但仍有单个压缩后资源块超过 500 kB 的既有构建警告。
- 未记录的 relay message 字符串不会扩大 scope；需要稳定机器码后才能新增 provider profile。

## 四、下次最该做的事

- 在可用浏览器中完成两套 Admin 主题的逐页桌面与移动布局、刷新持久化、键盘切换和弹窗验收。

- 更新并重启服务后，核验模型目录中的完整标签名及历史记录迁移结果。
- 补充两阶段调度的集成测试（多 Key 轮换、并发最少活跃、sticky 优先于到期）。
- 大型 Key 池的 UI 分页/筛选。
- 收集真实 relay 的稳定机器错误码，为高频 Provider 增加精确 failure profile。
