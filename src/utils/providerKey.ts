export const providerKeyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const chineseCharacterPattern = /[\u3400-\u9fff]/;

function asciiSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function providerKeyFromName(displayName: string): Promise<string> {
  const trimmed = displayName.trim();
  if (!chineseCharacterPattern.test(trimmed)) {
    return asciiSlug(trimmed);
  }
  const { pinyin } = await import("pinyin-pro");
  const transliterated = pinyin(displayName.trim(), {
    toneType: "none",
    type: "string",
    separator: "-",
    nonZh: "consecutive"
  });
  return asciiSlug(transliterated);
}

function providerKeyFromUrl(baseUrl: string): string {
  try {
    return asciiSlug(new URL(baseUrl).hostname);
  } catch {
    return "";
  }
}

function createRandomSuffix(): string {
  const bytes = new Uint8Array(3);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function suggestProviderKey(input: {
  suggestedKey?: string | null;
  displayName: string;
  baseUrl?: string | null;
  randomSuffix?: string;
}): Promise<string> {
  const suggested = asciiSlug(input.suggestedKey ?? "");
  if (suggested) {
    return suggested;
  }

  const fromName = await providerKeyFromName(input.displayName);
  if (fromName) {
    return fromName;
  }

  const fromUrl = providerKeyFromUrl(input.baseUrl ?? "");
  if (fromUrl) {
    return fromUrl;
  }

  const suffix = asciiSlug(input.randomSuffix ?? createRandomSuffix()) || createRandomSuffix();
  return `provider-${suffix}`;
}
