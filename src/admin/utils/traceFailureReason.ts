import type { RouteOutcomeItem } from "../api/traces.js";

type FailureEvidence = Partial<Pick<RouteOutcomeItem,
  "failure_kind" | "failure_scope" | "failure_confidence" | "status_code" | "provider_code" | "provider_type"
>>;

export function traceFailureAttribution(item: FailureEvidence): string {
  return [
    item.failure_kind
      ? `${item.failure_kind} · ${item.failure_scope ?? "unknown"} · ${item.failure_confidence ?? "unknown"}`
      : null,
    item.status_code ? `HTTP ${item.status_code}` : null,
    item.provider_code ?? item.provider_type
  ].filter(Boolean).join(" · ");
}

export function truncateTraceFailureText(text: string): string {
  const characters = Array.from(text.replace(/\s+/g, " ").trim());
  return characters.length > 120 ? characters.slice(0, 120).join("") + "…" : characters.join("");
}
