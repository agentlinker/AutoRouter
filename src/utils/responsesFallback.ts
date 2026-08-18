import { HttpError } from "./httpErrors.js";

export function isResponsesUnsupportedError(error: unknown): boolean {
  const statusCode = error instanceof HttpError ? error.statusCode : null;
  if (statusCode === 404 || statusCode === 405 || statusCode === 501) {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("not implemented") ||
    message.includes("unsupported responses") ||
    message.includes("responses unsupported") ||
    message.includes("responses not supported")
  );
}
