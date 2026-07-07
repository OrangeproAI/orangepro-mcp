import { OrangeProConfig } from "./config.js";

export type FetchLike = typeof fetch;

export class OrangeProApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = "OrangeProApiError";
  }
}

export class OrangeProClient {
  constructor(
    private readonly config: OrangeProConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const url = `${this.config.apiBaseUrl}${path}`;

    try {
      const response = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      if (!response.ok) {
        throw new OrangeProApiError(`OrangePro API ${method} ${path} failed with HTTP ${response.status}`, response.status, text);
      }
      return parseJson<T>(text);
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json"
    };
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
      headers["X-API-Key"] = this.config.apiKey;
    }
    if (this.config.userEmail) {
      headers["X-User-Email"] = this.config.userEmail;
    }
    if (this.config.organizationName) {
      headers["X-Organization-Name"] = this.config.organizationName;
    }
    return headers;
  }
}

function parseJson<T>(text: string): T {
  if (!text) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}
