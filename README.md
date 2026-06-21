# AutoRouter

`AutoRouter` is a local model routing gateway for agent clients. It exposes an OpenAI-compatible API, routes requests across configured providers and accounts, records route traces, and explains routing decisions.

## Current MVP

The current implementation includes:

- Local `POST /v1/chat/completions`
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
