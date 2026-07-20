# AutoRouter

`AutoRouter` is a local model routing gateway for agent clients. It exposes an OpenAI-compatible API, routes requests across configured providers and accounts, records route traces, and explains routing decisions.

## Current MVP

The current implementation includes:

- Local `POST /v1/chat/completions`
- Local `POST /v1/responses`
- Local `GET /v1/models`
- Local `GET /v1/autorouter/health`
- Local `GET /v1/autorouter/explain/latest`
- OpenAI-compatible, OpenRouter, and Ollama adapters
- Sticky sessions, fallback routing, trace logging, and basic cost estimation

## Install

```bash
npm ci
```

## Configuration

The public template lives at:

```bash
config/config.example.yaml
```

This file currently reflects the target concept model draft documented in:

```bash
docs/concept-model.md
```

The implementation already follows parts of this structure, but the config schema is still converging toward the full draft.

Create your local runtime config:

```bash
cp config/config.example.yaml config/config.yaml
```

`config/config.yaml` is ignored by Git.

## Run

Set a local gateway token and any provider API keys referenced by your config:

```bash
export AUTO_ROUTER_TOKEN=dev-token
```

Start the service:

```bash
npm run dev
```

## Verify

### Health

```bash
curl -s \
  -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8811/v1/autorouter/health
```

Expected:

- Returns gateway host/port
- Returns configured providers and accounts
- Shows provider health status

### Models

```bash
curl -s \
  -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8811/v1/models
```

Expected:

- Returns configured aliases such as `auto`
- Returns provider-backed model entries

### Chat Completion

```bash
curl -s \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8811/v1/chat/completions \
  -d '{
    "model": "auto",
    "messages": [
      { "role": "user", "content": "Say hello in one sentence." }
    ],
    "metadata": {
      "session_id": "manual-check-1",
      "privacy_level": "normal"
    }
  }'
```

Expected:

- Returns a provider response body
- Response headers include:
  - `x-autorouter-trace-id`
  - `x-autorouter-normalized-model`

Notes:

- The gateway keeps response headers minimal by default.
- Detailed routing internals such as provider, endpoint, account, fallback chain, and filter reasons are not exposed in response headers.
- Use `x-autorouter-trace-id` with `GET /v1/autorouter/explain/latest` or local trace files for routing diagnostics.

### Responses

Use this endpoint for clients that speak the OpenAI Responses API, including Codex CLI providers configured with `wire_api = "responses"`.

```bash
curl -s \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8811/v1/responses \
  -d '{
    "model": "auto",
    "input": "Say hello in one sentence.",
    "stream": true
  }'
```

Expected:

- Accepts `input`, `instructions`, `tools`, `tool_choice`, `temperature`, `max_output_tokens`, and `metadata`
- Routes through the same policy, fallback, trace, and credential handling as chat completions
- OpenAI-compatible managed endpoints with native Responses support are forwarded directly to upstream `POST /responses`
- Streaming Responses requests are proxied as upstream SSE rather than converted from chat completions
- If every eligible endpoint lacks native Responses support, AutoRouter falls back to a best-effort Chat Completions conversion
- Function calls and `function_call_output` are preserved on the native path; fallback conversion is only for compatibility

### Managed Provider Endpoints

Managed providers can expose more than one protocol surface. Keep one provider for the vendor, then add one endpoint per protocol/base URL.

```bash
curl -s \
  -X POST \
  -H "Authorization: Bearer admin-token" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8811/admin/api/providers/my-provider/endpoints \
  -d '{
    "endpoint_key": "anthropic",
    "protocol": "anthropic",
    "adapter_type": "anthropic",
    "base_url": "https://example.com/anthropic/v1"
  }'
```

Expected:

- The original provider remains one logical vendor entry
- Each endpoint carries its own `protocol`, `adapter_type`, `base_url`, enabled flag, and capabilities
- Models discovered from non-default endpoints are keyed as `provider/endpoint/model`
- If one endpoint cannot list models but another endpoint for the same provider can, runtime routing reuses the provider's discovered models for that endpoint
- Runtime routing creates separate accounts/endpoints internally while preserving provider-level trust, privacy, and credential settings

### Explain Latest

```bash
curl -s \
  -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8811/v1/autorouter/explain/latest
```

Expected:

- Returns the last trace id
- Returns the original requested model and normalized model selector
- Returns selected route details from the latest trace
- Returns fallback history when the primary route failed

### Trace Privacy Check

- Inspect the latest JSONL file under the configured trace directory in `config/config.yaml`
- Confirm trace records include `prompt_hash`
- Confirm trace records do not contain plaintext prompt content or API keys

## Validation

```bash
npm run typecheck
npm test
```
