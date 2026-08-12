import { describe, expect, it } from "vitest";

import {
  classifyProviderFailure,
  normalizeRuntimeStatusSettings
} from "../../src/runtime/runtimeStatus.js";
import { HttpError } from "../../src/utils/httpErrors.js";
import { PROVIDER_AUTH_FAILED_CODE } from "../../src/utils/providerErrors.js";

describe("classifyProviderFailure", () => {
  it("classifies credential failures as auth", () => {
    expect(
      classifyProviderFailure(new HttpError(401, PROVIDER_AUTH_FAILED_CODE, "Invalid API key"))
    ).toBe("auth");
    expect(
      classifyProviderFailure(new HttpError(403, PROVIDER_AUTH_FAILED_CODE, "Forbidden"))
    ).toBe("auth");
    // code 缺失时仍应按状态码判定
    expect(classifyProviderFailure(new HttpError(401, "provider_error", "unauthorized"))).toBe(
      "auth"
    );
  });

  it("classifies 402 as billing", () => {
    expect(
      classifyProviderFailure(new HttpError(402, "request_invalid", "Insufficient balance"))
    ).toBe("billing");
  });

  it("classifies 429 as rate_limit", () => {
    expect(
      classifyProviderFailure(new HttpError(429, "provider_rate_limited", "Too many requests"))
    ).toBe("rate_limit");
    // 流式分支只带 message 时的兜底
    expect(
      classifyProviderFailure(
        new HttpError(503, "provider_error", "Streaming responses request failed with status 429")
      )
    ).toBe("rate_limit");
  });

  it("classifies 404 and 410 as model_unavailable", () => {
    expect(
      classifyProviderFailure(new HttpError(404, "provider_invalid_model", "model not found"))
    ).toBe("model_unavailable");
    expect(
      classifyProviderFailure(new HttpError(410, "provider_error", "Gone"))
    ).toBe("model_unavailable");
  });

  it("prefers statusCode over the generic provider_error code", () => {
    // openaiCompatible.ts 的流式分支对所有非 429 4xx/5xx 都抛 code=provider_error，
    // 只看 code 会把 410 误判成 transient。
    const streaming410 = new HttpError(
      410,
      "provider_error",
      "Streaming responses request failed with status 410"
    );
    expect(classifyProviderFailure(streaming410)).toBe("model_unavailable");

    const streaming502 = new HttpError(
      502,
      "provider_error",
      "Streaming responses request failed with status 502"
    );
    expect(classifyProviderFailure(streaming502)).toBe("upstream_error");
  });

  it("classifies upstream 5xx, gateway and HTTP timeout failures as model-scoped errors", () => {
    for (const status of [500, 502, 503, 504, 520, 521, 522, 524, 530]) {
      expect(
        classifyProviderFailure(
          new HttpError(status, "provider_error", `Streaming responses request failed with status ${status}`)
        )
      ).toBe("upstream_error");
    }

    expect(classifyProviderFailure(new HttpError(408, "provider_timeout", "timeout"))).toBe(
      "upstream_error"
    );
    expect(
      classifyProviderFailure(new HttpError(503, "provider_unreachable", "socket hang up"))
    ).toBe("transient");
  });

  it("classifies request-shaped 4xx as client_error", () => {
    for (const status of [400, 409, 413, 422]) {
      expect(
        classifyProviderFailure(new HttpError(status, "request_invalid", `failed with ${status}`))
      ).toBe("client_error");
    }
  });

  it("treats unknown non-HTTP failures as transient", () => {
    // undici 在迭代 SSE 时断流不会带 statusCode，本质仍是上游不稳
    expect(classifyProviderFailure(new Error("stream disconnected before completion"))).toBe(
      "transient"
    );
    expect(classifyProviderFailure(new Error("other side closed"))).toBe("transient");
    expect(classifyProviderFailure(undefined)).toBe("transient");
    expect(classifyProviderFailure(null)).toBe("transient");
  });

  it("recovers the status code from the message when statusCode is missing", () => {
    expect(
      classifyProviderFailure(new Error("Streaming responses request failed with status 502"))
    ).toBe("upstream_error");
    expect(
      classifyProviderFailure(new Error("Streaming responses request failed with status 429"))
    ).toBe("rate_limit");
  });
});

describe("normalizeRuntimeStatusSettings", () => {
  it("normalizes auth_disables_account", () => {
    expect(
      normalizeRuntimeStatusSettings({
        auth_disables_account: false
      }).auth_disables_account
    ).toBe(false);
  });
});
