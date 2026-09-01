export interface TestSelectionNormalizationInput {
  modelKey: string;
  modelKeys: readonly string[];
  endpointKey: string;
  endpointKeys: readonly string[];
  defaultEndpointKey: string;
}

export interface TestSelectionNormalizationResult {
  modelKey: string;
  endpointKey: string;
  changed: boolean;
}

export function normalizeProviderModelTestSelection(
  input: TestSelectionNormalizationInput
): TestSelectionNormalizationResult {
  const modelKey = input.modelKeys.includes(input.modelKey)
    ? input.modelKey
    : input.modelKeys[0] ?? "";
  const endpointKey =
    input.endpointKey && input.endpointKeys.includes(input.endpointKey)
      ? input.endpointKey
      : input.defaultEndpointKey;

  return {
    modelKey,
    endpointKey,
    changed: modelKey !== input.modelKey || endpointKey !== input.endpointKey
  };
}
