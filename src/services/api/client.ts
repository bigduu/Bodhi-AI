/**
 * Unified HTTP API Client
 *
 * Provides a consistent interface for making HTTP requests to the backend API.
 * Eliminates duplicate fetch logic across services.
 *
 * Backend has two route prefixes:
 * - /v1/*       - Standard web_service routes (models, bamboo/*, workspace/*, mcp/*, claude/*)
 * - /api/v1/*   - Agent server routes (chat, stream, todo, respond, sessions, metrics)
 */
import { getBackendBaseUrlSync } from "../../shared/utils/backendBaseUrl";

export interface ApiClientConfig {
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public statusText: string,
    public body?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export class ApiClient {
  private baseUrl: string;
  private defaultHeaders: Record<string, string>;

  constructor(config: ApiClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? this.resolveBaseUrl();
    this.defaultHeaders = config.defaultHeaders ?? {
      "Content-Type": "application/json",
    };
  }

  private resolveBaseUrl(): string {
    let normalized = getBackendBaseUrlSync().trim().replace(/\/+$/, "");

    // Default to /v1 (standard web_service routes)
    if (normalized.endsWith("/v1")) {
      return normalized;
    }

    return `${normalized}/v1`;
  }

  private buildUrl(path: string): string {
    const cleanPath = path.replace(/^\/+/, "");
    return `${this.baseUrl}/${cleanPath}`;
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const body = await response.text().catch(() => undefined);

      // Try to parse error details from response body
      let errorMessage = response.statusText;
      if (body) {
        try {
          const errorData = JSON.parse(body);
          // Check for common error field names.
          //
          // Bamboo backend ResponseError shape:
          //   { "error": { "message": "...", "type": "...", "code": "..." } }
          // Some endpoints also return:
          //   { "success": false, "error": "..." }
          const nestedMessage =
            typeof errorData?.error === "object"
              ? (errorData.error?.message as unknown)
              : undefined;
          const directError =
            typeof errorData?.error === "string" ? errorData.error : undefined;

          errorMessage =
            directError ||
            (typeof nestedMessage === "string" ? nestedMessage : undefined) ||
            errorData.message ||
            errorData.detail ||
            response.statusText;
        } catch {
          // If not JSON, use the raw body as error message
          errorMessage = body || response.statusText;
        }
      }

      throw new ApiError(
        errorMessage,
        response.status,
        response.statusText,
        body,
      );
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    // Check content type to determine how to parse response
    const contentType = response.headers?.get?.("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }

    // For non-JSON responses (like health check returning "OK")
    // Use text() if available, otherwise fall back to json() for test mocks
    if (typeof response.text === "function") {
      const text = await response.text();
      return text as T;
    }
    return response.json();
  }

  /**
   * Delay helper for retries
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fetch with retry logic for transient failures
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries: number = 3,
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);

        // Retry on 5xx errors
        if (response.status >= 500 && attempt < maxRetries - 1) {
          const delayMs = 1000 * Math.pow(2, attempt); // Exponential backoff: 1s, 2s, 4s
          console.warn(
            `Request failed with ${response.status}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          await this.delay(delayMs);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error as Error;

        // Only retry on network errors, not on client errors
        if (attempt < maxRetries - 1) {
          const delayMs = 1000 * Math.pow(2, attempt);
          console.warn(
            `Network error: ${lastError.message}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          await this.delay(delayMs);
        }
      }
    }

    throw lastError || new Error("Max retries exceeded");
  }

  /**
   * Make a GET request with timeout and retry
   */
  async get<T>(path: string, options?: RequestInit): Promise<T> {
    const url = this.buildUrl(path);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await this.fetchWithRetry(
        url,
        {
          ...options,
          method: "GET",
          headers: {
            ...this.defaultHeaders,
            ...options?.headers,
          },
          signal: controller.signal,
        },
        3, // 3 retries
      );
      return this.handleResponse<T>(response);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a POST request with timeout and retry
   */
  async post<T>(
    path: string,
    data?: unknown,
    options?: RequestInit,
  ): Promise<T> {
    const url = this.buildUrl(path);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await this.fetchWithRetry(
        url,
        {
          ...options,
          method: "POST",
          headers: {
            ...this.defaultHeaders,
            ...options?.headers,
          },
          body: data ? JSON.stringify(data) : undefined,
          signal: controller.signal,
        },
        3, // 3 retries
      );
      return this.handleResponse<T>(response);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a PUT request with timeout and retry
   */
  async put<T>(
    path: string,
    data?: unknown,
    options?: RequestInit,
  ): Promise<T> {
    const url = this.buildUrl(path);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await this.fetchWithRetry(
        url,
        {
          ...options,
          method: "PUT",
          headers: {
            ...this.defaultHeaders,
            ...options?.headers,
          },
          body: data ? JSON.stringify(data) : undefined,
          signal: controller.signal,
        },
        3, // 3 retries
      );
      return this.handleResponse<T>(response);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a PATCH request with timeout and retry
   */
  async patch<T>(
    path: string,
    data?: unknown,
    options?: RequestInit,
  ): Promise<T> {
    const url = this.buildUrl(path);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await this.fetchWithRetry(
        url,
        {
          ...options,
          method: "PATCH",
          headers: {
            ...this.defaultHeaders,
            ...options?.headers,
          },
          body: data ? JSON.stringify(data) : undefined,
          signal: controller.signal,
        },
        3,
      );
      return this.handleResponse<T>(response);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a DELETE request with timeout and retry
   */
  async delete<T>(path: string, options?: RequestInit): Promise<T> {
    const url = this.buildUrl(path);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await this.fetchWithRetry(
        url,
        {
          ...options,
          method: "DELETE",
          headers: {
            ...this.defaultHeaders,
            ...options?.headers,
          },
          signal: controller.signal,
        },
        3, // 3 retries
      );
      return this.handleResponse<T>(response);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a request with custom method and timeout
   */
  async request<T>(
    method: string,
    path: string,
    options?: RequestInit,
  ): Promise<T> {
    const url = this.buildUrl(path);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await this.fetchWithRetry(
        url,
        {
          ...options,
          method,
          headers: {
            ...this.defaultHeaders,
            ...options?.headers,
          },
          signal: controller.signal,
        },
        3, // 3 retries
      );
      return this.handleResponse<T>(response);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a request and return raw Response for streaming
   * Note: No retry logic for streaming endpoints
   */
  async fetchRaw(path: string, options?: RequestInit): Promise<Response> {
    const url = this.buildUrl(path);
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.defaultHeaders,
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new ApiError(
        `API request failed: ${response.statusText}`,
        response.status,
        response.statusText,
      );
    }

    return response;
  }
}

// Export singleton instance for standard API (/v1)
export const apiClient = new ApiClient();

/**
 * Agent API Client for /api/v1 routes
 *
 * Used for agent-specific endpoints:
 * - chat, stream, stop, history
 * - todo, respond, sessions
 * - metrics, health
 */
export const agentApiClient = new ApiClient({
  baseUrl: (() => {
    let normalized = getBackendBaseUrlSync().trim().replace(/\/+$/, "");
    // Remove /v1 suffix if present, then add /api/v1
    if (normalized.endsWith("/v1")) {
      normalized = normalized.slice(0, -3);
    }
    return `${normalized}/api/v1`;
  })(),
});
