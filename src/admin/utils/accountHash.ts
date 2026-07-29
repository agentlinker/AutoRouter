export function formatAccountHashHint(value: string | null | undefined): string {
  if (!value) {
    return "未命中";
  }
  return `...${value.slice(-4)}`;
}
