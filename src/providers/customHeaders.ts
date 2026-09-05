import { RESERVED_CUSTOM_HEADER_NAMES } from "../config/schema.js";

const BLOCKED_REQUEST_HEADERS = new Set([
  ...RESERVED_CUSTOM_HEADER_NAMES,
  "proxy-authorization", "cookie", "cookie2",
  "connection", "keep-alive", "proxy-connection", "proxy-authenticate",
  "te", "trailer", "transfer-encoding", "upgrade", "expect",
  "host", "content-length", "content-type", "content-encoding", "accept-encoding"
]);

type RequestHeaderValue = string | string[] | undefined;

export function pickForwardedRequestHeaders(
  requestHeaders: Record<string, RequestHeaderValue> | undefined
): Record<string, string> | undefined {
  if (!requestHeaders) {
    return undefined;
  }

  const entries = Object.entries(requestHeaders).map(([name, value]) => [
    name.trim().toLowerCase(), Array.isArray(value) ? value.join(", ") : value
  ] as const);
  // Connection options name additional hop-by-hop fields, regardless of header order.
  const blocked = new Set(BLOCKED_REQUEST_HEADERS);
  for (const [name, value] of entries) {
    if (name === "connection") {
      for (const option of (value ?? "").split(",")) {
        blocked.add(option.trim().toLowerCase());
      }
    }
  }

  const forwarded: Record<string, string> = Object.create(null);
  for (const [name, value] of entries) {
    if (!name || name.startsWith(":") || name.startsWith("x-autorouter-") || blocked.has(name)) {
      continue;
    }
    if (value !== undefined) {
      forwarded[name] = value;
    }
  }

  return Object.keys(forwarded).length > 0 ? forwarded : undefined;
}

/**
 * 把 endpoint 的 custom_headers 合并进内建 header。
 *
 * 合并顺序：内建基础 header → custom_headers → 认证 header。
 * 认证 header 由调用方在本函数返回后写入，因此不可能被 custom_headers 覆盖。
 *
 * header 名统一转小写：HTTP header 名大小写不敏感，但 undici 会按字面量发送，
 * 不归一化会出现 `content-type` 与 `Content-Type` 同时发出的重复头。
 */
export function mergeCustomHeaders(
  base: Record<string, string>,
  customHeaders: Record<string, string> | undefined
): Record<string, string> {
  if (!customHeaders) {
    return base;
  }

  const merged = { ...base };
  for (const [name, value] of Object.entries(customHeaders)) {
    const normalized = name.trim().toLowerCase();
    // schema 已拦截，这里是兜底：DB 里的历史数据不经过 zod
    if (!normalized || RESERVED_CUSTOM_HEADER_NAMES.has(normalized)) {
      continue;
    }

    merged[normalized] = value;
  }

  return merged;
}
