# Release Notes

## Unreleased - Wire Protocol Boundaries

This release makes Endpoint protocol identifiers exact and breaking. Supported
values are `openai-responses`, `openai-chat-completions`, and
`anthropic-messages`. The gateway no longer converts requests, responses, or
streams between these protocols.

Existing database rows migrate from `openai` to `openai-responses` and from
`anthropic` to `anthropic-messages`. Endpoint keys change with the protocol. No
Chat Completions Endpoint is synthesized, and ambiguous legacy OpenAI runtime
observations reset to `unknown`. Rollback requires the pre-migration database
backup and previous binary.

Account credentials remain Provider-scoped. New Account-Endpoint state isolates
administrative disablement and protocol-surface access errors. Generic `401`
and `403` responses no longer disable the Account globally; only explicit
invalid, revoked, or expired credential evidence can do so.

Route traces now retain required protocol, actual protocol, operation, failure
kind, scope, confidence, retryability, HTTP status, provider code/type, and
actual upstream URL. The Admin API and UI expose Account-Endpoint controls and
these trace fields.

Bundled templates were checked against vendor documentation on September 6,
2026. The unverified MiMo SGP preset was removed. OpenRouter and Ollama now
declare separate confirmed Responses and Chat Completions Endpoints.
