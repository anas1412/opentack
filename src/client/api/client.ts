const BASE = "";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });

  if (res.status === 204) return undefined as T;

  const body = await res.json();

  if (!res.ok) {
    throw new ApiError(
      res.status,
      body.error || "UNKNOWN",
      body.message || "Request failed",
      body.details,
    );
  }

  return body as T;
}
