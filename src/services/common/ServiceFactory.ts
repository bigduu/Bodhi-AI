import { apiClient } from "../api";
import { copyText } from "@shared/utils/clipboard";

/**
 * Bamboo configuration structure
 */
export interface BambooConfig {
  model?: string;
  api_key?: string;
  api_base?: string;
  http_proxy?: string;
  https_proxy?: string;
  headless_auth?: boolean;
  [key: string]: unknown;
}

/**
 * Anthropic model mapping configuration
 */
export interface AnthropicModelMapping {
  mappings: Record<string, string>;
}

/**
 * Generic API success response
 */
export interface ApiSuccessResponse {
  success: boolean;
}

export interface BambooConfigValidationIssue {
  path: string;
  message: string;
}

export interface ValidateBambooConfigResponse {
  valid: boolean;
  errors: Record<string, BambooConfigValidationIssue[]>;
}

export interface UtilityService {
  /**
   * Copy text to clipboard
   */
  copyToClipboard(text: string): Promise<void>;

  /**
   * Get Bamboo config
   */
  getBambooConfig(): Promise<BambooConfig>;

  /**
   * Set Bamboo config
   */
  setBambooConfig(config: BambooConfig): Promise<BambooConfig>;

  /**
   * Validate a Bamboo config patch without saving.
   */
  validateBambooConfigPatch(
    patch: BambooConfig,
  ): Promise<ValidateBambooConfigResponse>;

  /**
   * Set proxy auth credentials
   */
  setProxyAuth(auth: {
    username: string;
    password: string;
  }): Promise<ApiSuccessResponse>;

  /**
   * Get proxy auth status (returns whether proxy auth is configured, without password)
   */
  getProxyAuthStatus(): Promise<{
    configured: boolean;
    username: string | null;
  }>;

  /**
   * Clear proxy auth credentials
   */
  clearProxyAuth(): Promise<ApiSuccessResponse>;

  /**
   * Get Anthropic model mapping
   */
  getAnthropicModelMapping(): Promise<AnthropicModelMapping>;

  /**
   * Set Anthropic model mapping
   */
  setAnthropicModelMapping(
    mapping: AnthropicModelMapping,
  ): Promise<AnthropicModelMapping>;

  /**
   * Reset Bamboo config (delete config.json)
   */
  resetBambooConfig(): Promise<ApiSuccessResponse>;

  /**
   * Reset setup status (mark as incomplete)
   */
  resetSetupStatus(): Promise<void>;

  /**
   * Workflow management
   */
  saveWorkflow(
    name: string,
    content: string,
  ): Promise<{ success: boolean; path: string }>;
  deleteWorkflow(name: string): Promise<ApiSuccessResponse>;

  /**
   * Keyword masking
   */
  getKeywordMaskingConfig(): Promise<{
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>;
  }>;
  updateKeywordMaskingConfig(
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>,
  ): Promise<{
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>;
  }>;
  validateKeywordEntries(
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>,
  ): Promise<{
    valid: boolean;
    errors?: Array<{ index: number; message: string }>;
  }>;

  /**
   * Setup status
   */
  getSetupStatus(): Promise<{
    is_complete: boolean;
    has_proxy_config: boolean;
    has_proxy_env: boolean;
    message: string;
  }>;
  markSetupComplete(): Promise<ApiSuccessResponse>;
}

class HttpUtilityService implements Partial<UtilityService> {
  async copyToClipboard(text: string): Promise<void> {
    await copyText(text);
  }

  async getBambooConfig(): Promise<BambooConfig> {
    try {
      return await apiClient.get<BambooConfig>("bamboo/config");
    } catch (error) {
      console.error("Failed to fetch Bamboo config:", error);
      return {};
    }
  }

  async setBambooConfig(config: BambooConfig): Promise<BambooConfig> {
    return apiClient.post<BambooConfig>("bamboo/config", config);
  }

  async validateBambooConfigPatch(
    patch: BambooConfig,
  ): Promise<ValidateBambooConfigResponse> {
    return apiClient.post<ValidateBambooConfigResponse>(
      "bamboo/config/validate",
      patch,
    );
  }

  async setProxyAuth(auth: {
    username: string;
    password: string;
  }): Promise<ApiSuccessResponse> {
    return apiClient.post<ApiSuccessResponse>("bamboo/proxy-auth", auth);
  }

  async getProxyAuthStatus(): Promise<{
    configured: boolean;
    username: string | null;
  }> {
    try {
      return await apiClient.get<{
        configured: boolean;
        username: string | null;
      }>("bamboo/proxy-auth/status");
    } catch (error) {
      console.error("Failed to fetch proxy auth status:", error);
      return { configured: false, username: null };
    }
  }

  async clearProxyAuth(): Promise<ApiSuccessResponse> {
    return apiClient.post<ApiSuccessResponse>("bamboo/proxy-auth", {
      username: "",
      password: "",
    });
  }

  async getAnthropicModelMapping(): Promise<AnthropicModelMapping> {
    try {
      return await apiClient.get<AnthropicModelMapping>(
        "bamboo/anthropic-model-mapping",
      );
    } catch (error) {
      console.error("Failed to fetch Anthropic model mapping:", error);
      return { mappings: {} };
    }
  }

  async setAnthropicModelMapping(
    mapping: AnthropicModelMapping,
  ): Promise<AnthropicModelMapping> {
    return apiClient.post<AnthropicModelMapping>(
      "bamboo/anthropic-model-mapping",
      mapping,
    );
  }

  async resetBambooConfig(): Promise<ApiSuccessResponse> {
    return apiClient.post<ApiSuccessResponse>("bamboo/config/reset", {});
  }

  async saveWorkflow(
    name: string,
    content: string,
  ): Promise<{ success: boolean; path: string }> {
    return apiClient.post<{ success: boolean; path: string }>(
      "bamboo/workflows",
      { name, content },
    );
  }

  async deleteWorkflow(name: string): Promise<ApiSuccessResponse> {
    return apiClient.delete<ApiSuccessResponse>(
      `bamboo/workflows/${encodeURIComponent(name)}`,
    );
  }

  async getKeywordMaskingConfig(): Promise<{
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>;
  }> {
    try {
      return await apiClient.get<{
        entries: Array<{
          pattern: string;
          match_type: string;
          enabled: boolean;
        }>;
      }>("bamboo/keyword-masking");
    } catch (error) {
      console.error("Failed to fetch keyword masking config:", error);
      return { entries: [] };
    }
  }

  async updateKeywordMaskingConfig(
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>,
  ): Promise<{
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>;
  }> {
    return apiClient.post<{
      entries: Array<{ pattern: string; match_type: string; enabled: boolean }>;
    }>("bamboo/keyword-masking", entries);
  }

  async validateKeywordEntries(
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>,
  ): Promise<{
    valid: boolean;
    errors?: Array<{ index: number; message: string }>;
  }> {
    return apiClient.post<{
      valid: boolean;
      errors?: Array<{ index: number; message: string }>;
    }>("bamboo/keyword-masking/validate", entries);
  }

  async getSetupStatus(): Promise<{
    is_complete: boolean;
    has_proxy_config: boolean;
    has_proxy_env: boolean;
    message: string;
  }> {
    // Important: do not swallow network/startup failures here. The app bootstrap
    // flow distinguishes "setup incomplete" from "backend not reachable yet".
    return await apiClient.get<{
      is_complete: boolean;
      has_proxy_config: boolean;
      has_proxy_env: boolean;
      message: string;
    }>("bamboo/setup/status");
  }

  async markSetupComplete(): Promise<ApiSuccessResponse> {
    return apiClient.post<ApiSuccessResponse>("bamboo/setup/complete", {});
  }

  async resetSetupStatus(): Promise<void> {
    await apiClient.post<ApiSuccessResponse>("bamboo/setup/incomplete", {});
  }
}

/**
 * ServiceFactory - Simplified to use only Web/HTTP mode
 * All services now use HTTP API calls to the backend
 */
export class ServiceFactory {
  private static instance: ServiceFactory;

  // Service instances
  private httpUtilityService = new HttpUtilityService();

  private constructor() {
    // No mode switching needed - always use Web/HTTP mode
  }

  static getInstance(): ServiceFactory {
    if (!ServiceFactory.instance) {
      ServiceFactory.instance = new ServiceFactory();
    }
    return ServiceFactory.instance;
  }

  getUtilityService(): UtilityService {
    // All utility services are HTTP/web based.
    return {
      copyToClipboard: (text: string) =>
        this.httpUtilityService.copyToClipboard(text),
      getBambooConfig: () => this.httpUtilityService.getBambooConfig(),
      setBambooConfig: (config: BambooConfig) =>
        this.httpUtilityService.setBambooConfig(config),
      validateBambooConfigPatch: (patch: BambooConfig) =>
        this.httpUtilityService.validateBambooConfigPatch(patch),
      setProxyAuth: (auth: { username: string; password: string }) =>
        this.httpUtilityService.setProxyAuth(auth),
      getProxyAuthStatus: () => this.httpUtilityService.getProxyAuthStatus(),
      clearProxyAuth: () => this.httpUtilityService.clearProxyAuth(),
      getAnthropicModelMapping: () =>
        this.httpUtilityService.getAnthropicModelMapping(),
      setAnthropicModelMapping: (mapping: AnthropicModelMapping) =>
        this.httpUtilityService.setAnthropicModelMapping(mapping),
      resetBambooConfig: () => this.httpUtilityService.resetBambooConfig(),
      resetSetupStatus: () => this.httpUtilityService.resetSetupStatus(),
      // Workflow management
      saveWorkflow: (name: string, content: string) =>
        this.httpUtilityService.saveWorkflow(name, content),
      deleteWorkflow: (name: string) =>
        this.httpUtilityService.deleteWorkflow(name),
      // Keyword masking
      getKeywordMaskingConfig: () =>
        this.httpUtilityService.getKeywordMaskingConfig(),
      updateKeywordMaskingConfig: (entries) =>
        this.httpUtilityService.updateKeywordMaskingConfig(entries),
      validateKeywordEntries: (entries) =>
        this.httpUtilityService.validateKeywordEntries(entries),
      // Setup status
      getSetupStatus: () => this.httpUtilityService.getSetupStatus(),
      markSetupComplete: () => this.httpUtilityService.markSetupComplete(),
    };
  }

  // Convenience methods for direct access
  async copyToClipboard(text: string): Promise<void> {
    return this.getUtilityService().copyToClipboard(text);
  }

  async getBambooConfig(): Promise<BambooConfig> {
    return this.getUtilityService().getBambooConfig();
  }

  async setBambooConfig(config: BambooConfig): Promise<BambooConfig> {
    return this.getUtilityService().setBambooConfig(config);
  }

  async validateBambooConfigPatch(
    patch: BambooConfig,
  ): Promise<ValidateBambooConfigResponse> {
    return this.getUtilityService().validateBambooConfigPatch(patch);
  }

  async setProxyAuth(auth: {
    username: string;
    password: string;
  }): Promise<ApiSuccessResponse> {
    return this.getUtilityService().setProxyAuth(auth);
  }

  async getProxyAuthStatus(): Promise<{
    configured: boolean;
    username: string | null;
  }> {
    return this.getUtilityService().getProxyAuthStatus();
  }

  async clearProxyAuth(): Promise<ApiSuccessResponse> {
    return this.getUtilityService().clearProxyAuth();
  }

  async getAnthropicModelMapping(): Promise<AnthropicModelMapping> {
    return this.getUtilityService().getAnthropicModelMapping();
  }

  async setAnthropicModelMapping(
    mapping: AnthropicModelMapping,
  ): Promise<AnthropicModelMapping> {
    return this.getUtilityService().setAnthropicModelMapping(mapping);
  }

  async resetBambooConfig(): Promise<ApiSuccessResponse> {
    return this.getUtilityService().resetBambooConfig();
  }

  async resetSetupStatus(): Promise<void> {
    return this.getUtilityService().resetSetupStatus();
  }

  async saveWorkflow(
    name: string,
    content: string,
  ): Promise<{ success: boolean; path: string }> {
    return this.getUtilityService().saveWorkflow(name, content);
  }

  async deleteWorkflow(name: string): Promise<ApiSuccessResponse> {
    return this.getUtilityService().deleteWorkflow(name);
  }

  async getKeywordMaskingConfig(): Promise<{
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>;
  }> {
    return this.getUtilityService().getKeywordMaskingConfig();
  }

  async updateKeywordMaskingConfig(
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>,
  ): Promise<{
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>;
  }> {
    return this.getUtilityService().updateKeywordMaskingConfig(entries);
  }

  async validateKeywordEntries(
    entries: Array<{ pattern: string; match_type: string; enabled: boolean }>,
  ): Promise<{
    valid: boolean;
    errors?: Array<{ index: number; message: string }>;
  }> {
    return this.getUtilityService().validateKeywordEntries(entries);
  }

  async getSetupStatus(): Promise<{
    is_complete: boolean;
    has_proxy_config: boolean;
    has_proxy_env: boolean;
    message: string;
  }> {
    return this.getUtilityService().getSetupStatus();
  }

  async markSetupComplete(): Promise<ApiSuccessResponse> {
    return this.getUtilityService().markSetupComplete();
  }
}

// Export singleton instance for easy access
export const serviceFactory = ServiceFactory.getInstance();
