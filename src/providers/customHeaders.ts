import { RESERVED_CUSTOM_HEADER_NAMES } from "../config/schema.js";

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
