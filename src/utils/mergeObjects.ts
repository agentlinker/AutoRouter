function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeObjects<T extends Record<string, unknown>>(
  target: T,
  ...sources: Array<Record<string, unknown>>
): T {
  const output: Record<string, unknown> = { ...target };

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const existingValue = output[key];

      if (isPlainObject(existingValue) && isPlainObject(value)) {
        output[key] = mergeObjects(existingValue, value);
        continue;
      }

      output[key] = value;
    }
  }

  return output as T;
}
