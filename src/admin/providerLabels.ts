export const PROVIDER_KIND_LABELS = {
  official: "官方",
  relay: "中转站",
  custom: "自定义"
} as const;

export function providerKindLabel(kind: string | null | undefined): string {
  if (kind === "official" || kind === "relay" || kind === "custom") {
    return PROVIDER_KIND_LABELS[kind];
  }
  return PROVIDER_KIND_LABELS.custom;
}
