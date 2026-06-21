# AutoRouter Concept Model Draft

This document captures the current target data model for `AutoRouter`. It is a schema draft for future-facing configuration and routing behavior, not a guarantee that every field is already fully implemented.

## Core Concepts

### `platform`

`platform` describes the protocol family or upstream API style.

Examples:

- `openai`
- `anthropic`
- `gemini`
- `ollama`

This layer determines:

- request shape
- response shape
- streaming event format
- error parsing rules

### `provider`

`provider` describes the upstream service or gateway vendor.

Examples:

- `openrouter`
- `anthropic-official`
- `relay-a`
- `my-provider`

This layer carries:

- vendor identity
- trust level
- privacy level
- usage trust
- provider-wide policy and routing metadata

### `endpoint`

`endpoint` describes a concrete protocol entrypoint exposed by a provider.

Examples:

- `openrouter-openai`
- `my-provider-openai`
- `my-provider-anthropic`
- `ollama-local`

This layer carries:

- `provider`
- `platform`
- `base_url`
- adapter selection
- protocol-specific capabilities

One provider can have multiple endpoints.

### `account`

`account` describes the concrete credential or identity used for a request.

Examples:

- an API key
- an OAuth token set
- a subscription-backed account
- a local model execution slot

This layer carries:

- endpoint binding
- credential reference
- quota state
- health and error state

### `model`

`model` describes a routable model entry bound to an endpoint.

Examples:

- `anthropic/claude-sonnet-4`
- `claude-sonnet-4-20250514`
- `qwen2.5-coder:32b`

This layer carries:

- upstream model name
- context window
- capability flags
- price metadata

### `route`

`route` is the user-facing alias or candidate set used by incoming requests.

Examples:

- `auto`
- `cheap`
- `coding`

This layer carries:

- policy selection
- candidate ordering
- account/model combinations

## Recommended Relationship

```text
platform
  -> provider
    -> endpoint
      -> account
        -> model

request
  -> route
    -> account
      -> endpoint
        -> provider
        -> platform
      -> model
```

## Why `endpoint` Exists

`endpoint` exists because a single provider may expose multiple protocol surfaces.

For example:

- one OpenAI-compatible base URL
- one Anthropic-compatible base URL
- one Responses-style base URL

Without `endpoint`, `provider + model` is not enough to unambiguously select:

- which protocol to use
- which base URL to call
- which adapter to invoke

## Mapping from `sub2api`

The `sub2api` concept of "channel" roughly overlaps with:

- `provider`
- plus some `endpoint`
- plus some account-level semantics in certain cases

`AutoRouter` keeps these concepts separate to make routing and protocol support easier to extend.

## Draft Config Shape

```yaml
platforms:
  openai:
    protocol: openai

providers:
  openrouter:
    display_name: OpenRouter
    trust_level: medium
    privacy_level: normal
    usage_trust: medium

endpoints:
  openrouter_openai:
    provider: openrouter
    platform: openai
    adapter: openrouter
    base_url: https://openrouter.ai/api/v1
    capabilities:
      streaming: true
      tools: true
      json_mode: true

accounts:
  openrouter_main:
    endpoint: openrouter_openai
    account_type: api_key
    credential_env: OPENROUTER_API_KEY

models:
  sonnet_via_openrouter:
    endpoint: openrouter_openai
    model_name: anthropic/claude-sonnet-4
    context_window: 200000
    capabilities:
      streaming: true
      tools: true
      json_mode: true
    pricing:
      input_per_1m: 3
      output_per_1m: 15
      source: openrouter
      confidence: medium

routes:
  auto:
    policy: balanced
    candidates:
      - account: openrouter_main
        model: sonnet_via_openrouter
```

## Status

This is a design draft.

The current implementation already contains pieces of this model, especially around:

- provider trust
- endpoint-aware routing
- account-level routing
- model candidates

But the config file and implementation may still be in transition as this schema settles.
