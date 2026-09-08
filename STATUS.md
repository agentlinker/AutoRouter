# 项目状态

## 一、架构健康度

- 模块总数：14，以 `src` 一级目录计。
- 违规跨模块调用：本次调用点审计未发现协议转换或宽协议 adapter 越界。
- 三个入站协议、三个原生 adapter、Account、Endpoint、Account-Endpoint 和 Account-Endpoint-Model 职责已分离。

## 二、本次变更影响范围

- 配置与 Admin 仅接受 `openai-responses`、`openai-chat-completions`、`anthropic-messages`。
- 数据库事务迁移旧协议和 Endpoint key，不合成 Chat Completions Endpoint，并清除来源不明的旧 OpenAI 观测。
- 新增 Account-Endpoint 状态、仓储、路由过滤、Admin API 和 UI 控件；Account identity 保持 Provider-scoped。
- 三条网关入口只调用匹配协议的原生 adapter；跨协议请求、响应和流转换已删除。
- 结构化失败归因按 kind、scope、confidence、retryable 分派运行状态，并保留上游机器字段。
- Trace、explain、Admin trace UI 已展示 required/actual protocol、operation 和失败归因。
- `unknown` 运行态在模型列表和 Provider 模型路由状态中统一显示为待验证且可尝试，不再误报不可用。
- 真实网关请求会按实际候选 Endpoint 即时回写 Account-Endpoint 与模型组合状态；Admin 页面由用户手动刷新读取最新状态。
- 接口契约发生破坏性变化；迁移影响记录于 README、ADR 和 RELEASE_NOTES。

## 三、已知风险点

- 未记录的 relay message 字符串不会扩大 scope；需要稳定机器码后才能新增 provider profile。
- MiMo SGP 独立入口未获官方资料确认，预设已移除，用户仍可显式创建自定义 Endpoint。
- Admin 构建成功，但仍有单个压缩后资源块超过 500 kB 的既有构建警告，不影响本次功能。
- 回滚必须恢复迁移前数据库备份和旧二进制。

## 四、下次最该做的事

收集真实 relay 的稳定机器错误码，为高频 Provider 增加经过测试的精确 failure profile，避免长期停留在保守 scope。
