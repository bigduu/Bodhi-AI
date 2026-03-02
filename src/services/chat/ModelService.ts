import { ApiClient, ApiError } from "../api";
import { getBackendBaseUrlSync } from "../../shared/utils/backendBaseUrl";

export class ProxyAuthRequiredError extends Error {
  readonly code = "proxy_auth_required";

  constructor(message = "Proxy authentication required") {
    super(message);
    this.name = "ProxyAuthRequiredError";
  }
}

export class ModelService {
  private static instance: ModelService;

  private constructor() {}

  static getInstance(): ModelService {
    if (!ModelService.instance) {
      ModelService.instance = new ModelService();
    }
    return ModelService.instance;
  }

  private resolveOpenAICompatBaseUrl(): string {
    // The UI stores the "standard" backend base URL as ".../v1".
    // OpenAI-compatible forwarding endpoints live under "/openai/v1/*".
    const base = getBackendBaseUrlSync().trim().replace(/\/+$/, "");

    // If the override already targets the OpenAI prefix, keep it.
    if (base.endsWith("/openai/v1")) return base;

    // Strip the standard v1 suffix if present.
    const origin = base.endsWith("/v1") ? base.slice(0, -"/v1".length) : base;

    return `${origin}/openai/v1`;
  }

  async getModels(): Promise<string[]> {
    try {
      const openaiClient = new ApiClient({
        baseUrl: this.resolveOpenAICompatBaseUrl(),
      });
      const data = await openaiClient.get<{ data: Array<{ id: string }> }>(
        "models",
      );
      return data.data.map((model) => model.id);
    } catch (error) {
      console.error("Failed to fetch models from HTTP API:", error);

      // Handle proxy auth error
      if (error instanceof ApiError) {
        if (error.status === 428) {
          throw new ProxyAuthRequiredError(error.message);
        }

        // Try to parse error code from body
        try {
          const body = JSON.parse(error.body || "{}");
          if (body.error?.code === "proxy_auth_required") {
            throw new ProxyAuthRequiredError(
              body.error.message || error.message,
            );
          }
        } catch {
          // Ignore parse errors
        }
      }

      throw error;
    }
  }
}

export const modelService = ModelService.getInstance();
