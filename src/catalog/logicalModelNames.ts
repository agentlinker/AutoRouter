/**
 * 归一化成 logical model 名：剥掉 provider 前缀，统一分隔符与大小写。
 *
 * 刻意不在字母与数字之间插入分隔符：上游 id 里的 `v4` / `qwen3` 是不可拆的整体，
 * 强行拆开会造出 `deepseek-v-4-pro` 这种上游和官方都不存在的名字。
 * 代价是 `grok4.5` 不再被并到 `grok-4.5`——同一模型的不同写法靠
 * logical_models.aliases_json 关联，不靠猜测性改写。
 */
export function toLogicalModelName(modelName: string): string {
  const trimmed = modelName.trim();
  const basename = trimmed.split(/[/:]/).filter(Boolean).at(-1) ?? trimmed;
  return basename
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
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
