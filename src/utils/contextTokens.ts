/**
 * Context token estimation for routing filters.
 *
 * Priority:
 * 1. Explicit client metadata (context_tokens / context_tokens_est / input_tokens / prompt_tokens)
 * 2. Heuristic text+image estimate (NOT raw JSON character length)
 */

const IMAGE_TOKEN_ESTIMATE = 765;
const MIN_TOKENS = 1;

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function readExplicitContextTokens(
  metadata?: Record<string, unknown> | null
): number | undefined {
  if (!metadata) {
    return undefined;
  }

  for (const key of [
    "context_tokens",
    "context_tokens_est",
    "input_tokens",
    "prompt_tokens"
  ] as const) {
    const value = metadata[key];
    if (isFiniteNonNegativeNumber(value)) {
      return Math.max(MIN_TOKENS, Math.ceil(value));
    }
  }

  return undefined;
}

export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }

  // CJK characters are typically closer to 1 token each; Latin/other ~4 chars/token.
  let cjk = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk += 1;
    }
  }

  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk + other / 4);
}

function appendText(parts: string[], value: unknown): number {
  let imageCount = 0;

  if (value == null) {
    return imageCount;
  }

  if (typeof value === "string") {
    parts.push(value);
    return imageCount;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    parts.push(String(value));
    return imageCount;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      imageCount += appendText(parts, item);
    }
    return imageCount;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;

    if (
      type === "image_url" ||
      type === "input_image" ||
      type === "image" ||
      record.image_url !== undefined
    ) {
      return imageCount + 1;
    }

    if (typeof record.text === "string") {
      parts.push(record.text);
    }
    if (typeof record.content === "string") {
      parts.push(record.content);
    }
    if (typeof record.output === "string") {
      parts.push(record.output);
    }
    if (typeof record.arguments === "string") {
      parts.push(record.arguments);
    }
    if (typeof record.name === "string") {
      parts.push(record.name);
    }

    if (record.content !== undefined && typeof record.content !== "string") {
      imageCount += appendText(parts, record.content);
    }
    if (record.output !== undefined && typeof record.output !== "string") {
      imageCount += appendText(parts, record.output);
    }
    if (Array.isArray(record.parts)) {
      imageCount += appendText(parts, record.parts);
    }
    if (Array.isArray(record.tool_calls)) {
      imageCount += appendText(parts, record.tool_calls);
    }
    if (record.function !== undefined) {
      imageCount += appendText(parts, record.function);
    }
    if (record.input !== undefined) {
      imageCount += appendText(parts, record.input);
    }
    if (record.messages !== undefined) {
      imageCount += appendText(parts, record.messages);
    }
  }

  return imageCount;
}

export function estimateContextTokens(input: {
  content?: unknown;
  tools?: unknown;
  metadata?: Record<string, unknown> | null;
}): number {
  const explicit = readExplicitContextTokens(input.metadata);
  if (explicit !== undefined) {
    return explicit;
  }

  const textParts: string[] = [];
  let imageCount = 0;
  imageCount += appendText(textParts, input.content);
  imageCount += appendText(textParts, input.tools);

  const textTokens = estimateTextTokens(textParts.join("\n"));
  const imageTokens = imageCount * IMAGE_TOKEN_ESTIMATE;
  return Math.max(MIN_TOKENS, textTokens + imageTokens);
}

export function estimateChatContextTokens(input: {
  messages: unknown;
  tools?: unknown;
  metadata?: Record<string, unknown> | null;
}): number {
  return estimateContextTokens({
    content: input.messages,
    tools: input.tools,
    metadata: input.metadata
  });
}

export function estimateResponsesContextTokens(input: {
  input: unknown;
  instructions?: string;
  tools?: unknown;
  metadata?: Record<string, unknown> | null;
}): number {
  return estimateContextTokens({
    content: [input.instructions, input.input],
    tools: input.tools,
    metadata: input.metadata
  });
}
