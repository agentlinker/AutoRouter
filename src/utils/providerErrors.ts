import { HttpError } from "./httpErrors.js";

export const PROVIDER_ACCESS_BLOCKED_CODE = "provider_access_blocked";
export const PROVIDER_AUTH_FAILED_CODE = "provider_auth_failed";
export const PROVIDER_AUTH_FAILED_MESSAGE = "Invalid API key";

function normalizeContentType(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join(", ");
  }
  return null;
}

export function throwIfProviderAccessBlocked(input: {
  statusCode: number;
  contentType: unknown;
  operation: string;
  bodyText?: string;
}): void {
  if (input.statusCode !== 401 && input.statusCode !== 403) {
    return;
  }

  const contentType = normalizeContentType(input.contentType);
  const normalizedBody = input.bodyText?.trimStart().toLowerCase();
  const returnedHtml =
    contentType?.toLowerCase().includes("text/html") === true ||
    contentType?.toLowerCase().includes("application/xhtml+xml") === true ||
    normalizedBody?.startsWith("<!doctype html") === true ||
    normalizedBody?.startsWith("<html") === true;

  if (!returnedHtml) {
    return;
  }

  throw new HttpError(
    input.statusCode,
    PROVIDER_ACCESS_BLOCKED_CODE,
    `${input.operation} returned HTML with status ${input.statusCode}`,
    true,
    contentType ? { content_type: contentType } : undefined
  );
}
