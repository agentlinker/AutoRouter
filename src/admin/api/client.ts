export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
  }
}

export async function requestJson<T>(
  url: string,
  token: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null) as {
      error?: {
        code?: string;
        message?: string;
      };
    } | null;
    throw new ApiError(
      body?.error?.message ?? `Request failed: ${response.status}`,
      response.status,
      body?.error?.code
    );
  }

  if (response.status === 204) {
    return null as T;
  }

  return response.json() as Promise<T>;
}
