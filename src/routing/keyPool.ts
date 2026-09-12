import type { AccountRuntimeState } from "../state/routerState.js";

/**
 * Key 池内排序规则（默认策略）：
 * 1. 到期时间越早越优先（含已过期的配置时间——只参与升序排序，不做过滤）
 * 2. 未设置到期时间的排最后
 * 3. 同到期时间（含都未设置）按最少活跃请求选择
 * 4. 同负载按轮询游标打破平局
 *
 * 配置的到期时间只是排序提示，不是不可用证据。
 */

/** 进程内 Key 池轮询游标，跨请求共享，重启后清空 */
export const poolCursors = new Map<string, string>();

export interface KeyPoolCandidate {
  account: AccountRuntimeState;
  candidateIndex: number;
}

export interface KeyPoolSelectionInput {
  candidates: KeyPoolCandidate[];
  activeCounts: ReadonlyMap<string, number>;
  poolCursors: Map<string, string>;
  poolKey: string;
}

/**
 * 在合格 Key 池内按默认策略选择一个凭证。
 */
export function selectKeyFromPool(
  input: KeyPoolSelectionInput
): KeyPoolCandidate | null {
  if (input.candidates.length === 0) {
    return null;
  }
  if (input.candidates.length === 1) {
    return input.candidates[0];
  }

  const sorted = [...input.candidates].sort((a, b) => {
    // 1. 到期时间升序；未设置排最后
    const aExpiry = parseExpirySortValue(a.account.expires_at);
    const bExpiry = parseExpirySortValue(b.account.expires_at);
    if (aExpiry !== bExpiry) {
      return aExpiry - bExpiry;
    }

    // 2. 最少活跃请求
    const aActive = input.activeCounts.get(a.account.id) ?? 0;
    const bActive = input.activeCounts.get(b.account.id) ?? 0;
    if (aActive !== bActive) {
      return aActive - bActive;
    }

    // 3. 轮询：优先选游标之后的候选
    const cursor = input.poolCursors.get(input.poolKey);
    if (cursor) {
      const aAfter = isAfterCursor(input.candidates, cursor, a.account.id);
      const bAfter = isAfterCursor(input.candidates, cursor, b.account.id);
      if (aAfter !== bAfter) {
        return aAfter ? -1 : 1;
      }
    }

    // 4. 保持输入顺序作为最终平局
    return a.candidateIndex - b.candidateIndex;
  });

  const selected = sorted[0];
  if (selected) {
    input.poolCursors.set(input.poolKey, selected.account.id);
  }
  return selected;
}

/**
 * 将到期时间解析为排序值。
 * - 有效日期 → 毫秒时间戳（越早越小）
 * - 未设置或无效 → Number.MAX_SAFE_INTEGER（排最后）
 *
 * 已过期的配置时间仍返回真实时间戳，参与升序排序，不被特殊处理为"立即排除"。
 */
function parseExpirySortValue(expiresAt: string | null | undefined): number {
  if (!expiresAt) {
    return Number.MAX_SAFE_INTEGER;
  }
  const ts = Date.parse(expiresAt);
  return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
}

function isAfterCursor(
  candidates: KeyPoolCandidate[],
  cursorAccountId: string,
  accountId: string
): boolean {
  const cursorIdx = candidates.findIndex((c) => c.account.id === cursorAccountId);
  const accountIdx = candidates.findIndex((c) => c.account.id === accountId);
  if (cursorIdx < 0 || accountIdx < 0) {
    return false;
  }
  return accountIdx > cursorIdx;
}
