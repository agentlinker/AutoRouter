export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(
    statusCode: number,
    code: string,
    message: string,
    retryable = false
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
