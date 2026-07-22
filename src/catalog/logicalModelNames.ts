export function toLogicalModelName(modelName: string): string {
  const trimmed = modelName.trim();
  const basename = trimmed.split(/[/:]/).filter(Boolean).at(-1) ?? trimmed;
  const spaced = basename
    .replace(/[_\s]+/g, "-")
    .replace(/([a-z])([0-9])/gi, "$1-$2")
    .replace(/([0-9])([a-z])/gi, "$1-$2")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return spaced;
}

export function displayNameFromLogicalName(logicalName: string): string {
  return logicalName;
}

export function mergeAliases(...values: Array<string | null | undefined>): string | null {
  const aliases = Array.from(new Set(
    values
      .flatMap((value) => {
        if (!value) {
          return [];
        }
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
      })
  ));

  return aliases.length > 0 ? JSON.stringify(aliases) : null;
}
