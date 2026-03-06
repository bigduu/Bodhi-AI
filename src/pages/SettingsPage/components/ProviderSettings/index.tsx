import React, { useState, useEffect } from "react";
import {
  Form,
  Select,
  Input,
  Button,
  Card,
  message,
  Space,
  Divider,
  Typography,
  Alert,
  Tag,
  Spin,
  Modal,
  Switch,
  Tooltip,
} from "antd";
import {
  SaveOutlined,
  KeyOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoginOutlined,
  LogoutOutlined,
  CopyOutlined,
} from "@ant-design/icons";
import { isApiError } from "@services/api/client";
import {
  settingsService,
  type CopilotAuthStatus,
  type DeviceCodeInfo,
} from "@services/config/SettingsService";
import type {
  ProviderConfig,
  ProviderType,
} from "../../../ChatPage/types/providerConfig";
import {
  PROVIDER_LABELS,
  OPENAI_MODELS,
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
} from "../../../ChatPage/types/providerConfig";
import { modelService } from "@services/chat/ModelService";
import {
  ServiceFactory,
  type BambooConfigValidationIssue,
} from "../../../../services/common/ServiceFactory";
import { copyText } from "@shared/utils/clipboard";

const { Option } = Select;
const { Password } = Input;
const { Text, Paragraph } = Typography;

const RESPONSES_ONLY_MODELS_HELP = (
  <Space direction="vertical" size={4}>
    <Text type="secondary">
      Some models only support the OpenAI Responses API (not chat/completions).
      Add model ids here to force Bamboo to use upstream <Text code>/responses</Text>.
    </Text>
    <Text type="secondary">
      Supports exact match (e.g. <Text code>gpt-5.3-codex</Text>) and prefix
      match with a trailing <Text code>*</Text> (e.g. <Text code>gpt-5*</Text>).
    </Text>
  </Space>
);

/**
 * Provider Settings Component
 *
 * Allows users to configure and switch between different LLM providers.
 */
export const ProviderSettings: React.FC = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [applyingConfig, setApplyingConfig] = useState(false);
  const [currentProvider, setCurrentProvider] =
    useState<ProviderType>("copilot");
  const [configLoaded, setConfigLoaded] = useState(false);
  const [copilotAuthStatus, setCopilotAuthStatus] =
    useState<CopilotAuthStatus | null>(null);
  const [checkingCopilotAuth, setCheckingCopilotAuth] = useState(false);
  const [authenticatingCopilot, setAuthenticatingCopilot] = useState(false);
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<DeviceCodeInfo | null>(
    null,
  );
  const [isDeviceCodeModalVisible, setIsDeviceCodeModalVisible] =
    useState(false);
  const [completingAuth, setCompletingAuth] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<number>(0);
  const [copiedUserCode, setCopiedUserCode] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<
    Array<{ value: string; label: string }>
  >([]);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [hasTriedFetchModels, setHasTriedFetchModels] = useState(false);

  const [modelAutoSaveStatus, setModelAutoSaveStatus] = useState<
    "idle" | "saving" | "success" | "error"
  >("idle");
  const [modelAutoSaveError, setModelAutoSaveError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (modelAutoSaveStatus !== "success") return;

    const timer = setTimeout(() => {
      setModelAutoSaveStatus("idle");
      setModelAutoSaveError(null);
    }, 2000);

    return () => clearTimeout(timer);
  }, [modelAutoSaveStatus]);

  // If the user edits provider credentials, clear the model cache and allow
  // auto-fetch to run again the next time the dropdown opens.
  const openaiApiKey = Form.useWatch(["providers", "openai", "api_key"], form);
  const openaiBaseUrl = Form.useWatch(
    ["providers", "openai", "base_url"],
    form,
  );
  const anthropicApiKey = Form.useWatch(
    ["providers", "anthropic", "api_key"],
    form,
  );
  const anthropicBaseUrl = Form.useWatch(
    ["providers", "anthropic", "base_url"],
    form,
  );
  const geminiApiKey = Form.useWatch(["providers", "gemini", "api_key"], form);
  const geminiBaseUrl = Form.useWatch(
    ["providers", "gemini", "base_url"],
    form,
  );

  useEffect(() => {
    if (currentProvider !== "openai") return;
    setAvailableModels([]);
    setModelsFetchError(null);
    setHasTriedFetchModels(false);
  }, [currentProvider, openaiApiKey, openaiBaseUrl]);

  useEffect(() => {
    if (currentProvider !== "anthropic") return;
    setAvailableModels([]);
    setModelsFetchError(null);
    setHasTriedFetchModels(false);
  }, [currentProvider, anthropicApiKey, anthropicBaseUrl]);

  useEffect(() => {
    if (currentProvider !== "gemini") return;
    setAvailableModels([]);
    setModelsFetchError(null);
    setHasTriedFetchModels(false);
  }, [currentProvider, geminiApiKey, geminiBaseUrl]);

  // Countdown timer for device code expiration
  useEffect(() => {
    if (!isDeviceCodeModalVisible || !deviceCodeInfo) {
      setTimeRemaining(0);
      return;
    }

    setTimeRemaining(deviceCodeInfo.expires_in);

    const timer = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isDeviceCodeModalVisible, deviceCodeInfo]);

  useEffect(() => {
    loadConfig();
  }, []);

  useEffect(() => {
    if (currentProvider === "copilot") {
      checkCopilotAuthStatus();
    }
  }, [currentProvider]);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const response = await settingsService.getProviderConfig();

      // Transform backend response to frontend format
      // Backend returns: { provider, providers: { openai: {...} } }
      // Frontend expects: { provider, providers: { openai: {...} } }
      const config: ProviderConfig = {
        provider: response.provider,
        providers: (response as any).providers || {},
      };

      // Copilot needs a model selected for the UI to enable chat. If the backend
      // config doesn't include one yet, default to a sensible option.
      if (config.provider === "copilot") {
        const copilot = (config.providers as any).copilot || {};
        if (!copilot.model) {
          (config.providers as any).copilot = { ...copilot, model: "gpt-4o" };
        }
      }

      console.log("Loaded provider config:", config);
      setCurrentProvider(config.provider as ProviderType);
      form.setFieldsValue(config);
      setConfigLoaded(true);
    } catch (error) {
      message.error("Failed to load provider config");
      console.error("Failed to load provider config:", error);
    } finally {
      setLoading(false);
    }
  };

  const checkCopilotAuthStatus = async () => {
    try {
      setCheckingCopilotAuth(true);
      const status = await settingsService.getCopilotAuthStatus();
      setCopilotAuthStatus(status);
    } catch (error) {
      console.error("Failed to check Copilot auth status:", error);
      setCopilotAuthStatus({
        authenticated: false,
        message: "Failed to check status",
      });
    } finally {
      setCheckingCopilotAuth(false);
    }
  };

  const handleCopilotAuthenticate = async () => {
    try {
      setAuthenticatingCopilot(true);
      // Start authentication - get device code
      const deviceCode = await settingsService.startCopilotAuth();
      setDeviceCodeInfo(deviceCode);
      setIsDeviceCodeModalVisible(true);
    } catch (error) {
      message.error("Failed to start Copilot authentication");
      console.error("Failed to start Copilot authentication:", error);
    } finally {
      setAuthenticatingCopilot(false);
    }
  };

  const handleCompleteAuth = async () => {
    if (!deviceCodeInfo) return;

    try {
      setCompletingAuth(true);
      // Complete authentication - poll for token
      await settingsService.completeCopilotAuth({
        device_code: deviceCodeInfo.device_code, // Use the actual device code, not user code!
        interval: deviceCodeInfo.interval || 5,
        expires_in: deviceCodeInfo.expires_in,
      });
      message.success("Copilot authentication successful!");
      setIsDeviceCodeModalVisible(false);
      setDeviceCodeInfo(null);
      await checkCopilotAuthStatus();
      // Reload provider to use the new authentication
      await settingsService.reloadConfig();
      message.success("Provider reloaded with new authentication.");
    } catch (error) {
      message.error("Authentication completion failed. Please try again.");
      console.error("Authentication completion failed:", error);
    } finally {
      setCompletingAuth(false);
    }
  };

  // Note: Browser is opened automatically by backend when starting auth

  const handleCopyUserCode = async () => {
    if (deviceCodeInfo) {
      try {
        await copyText(deviceCodeInfo.user_code);
        setCopiedUserCode(true);
        message.success("User code copied to clipboard!");
        setTimeout(() => setCopiedUserCode(false), 2000);
      } catch (error) {
        message.error(
          "Failed to copy code. Please manually copy: " +
            deviceCodeInfo.user_code,
        );
      }
    }
  };

  const handleCopilotLogout = async () => {
    try {
      setAuthenticatingCopilot(true);
      await settingsService.logoutCopilot();
      message.success("Logged out from Copilot");
      await checkCopilotAuthStatus();
    } catch (error) {
      message.error("Failed to logout from Copilot");
      console.error("Failed to logout:", error);
    } finally {
      setAuthenticatingCopilot(false);
    }
  };

  const handleProviderChange = (value: ProviderType) => {
    setCurrentProvider(value);
    form.setFieldsValue({ provider: value });
    setAvailableModels([]); // Clear models when switching provider
    setModelsFetchError(null);
    setHasTriedFetchModels(false);
    setModelAutoSaveStatus("idle");
    setModelAutoSaveError(null);
  };

  const getErrorMessage = (error: unknown): string => {
    if (isApiError(error)) return error.message;
    if (error instanceof Error) return error.message;
    return "Unknown error";
  };

  const clearProviderValidationErrors = (provider: ProviderType) => {
    // Clear the most common provider-scoped fields to avoid stale errors.
    form.setFields([
      { name: ["provider"], errors: [] },
      { name: ["providers", provider, "api_key"], errors: [] },
      { name: ["providers", provider, "model"], errors: [] },
    ]);
  };

  const pathToName = (path: string): Array<string | number> | null => {
    const trimmed = path.trim();
    if (!trimmed) return null;
    if (trimmed.includes(".")) return trimmed.split(".").filter(Boolean);
    if (trimmed === "provider") return ["provider"];
    if (trimmed === "provider/providers") return ["provider"];
    return null;
  };

  const applyValidationIssuesToForm = (
    issues: BambooConfigValidationIssue[],
    provider: ProviderType,
  ) => {
    if (!issues.length) return;

    const fields = issues
      .map((issue) => {
        // Prefer backend-provided paths (e.g. providers.openai.api_key).
        const direct = pathToName(issue.path);
        if (direct) {
          return { name: direct, errors: [issue.message] };
        }

        // Fallback mapping for older/less specific server errors.
        if (issue.message.toLowerCase().includes("api key")) {
          return {
            name: ["providers", provider, "api_key"],
            errors: [issue.message],
          };
        }

        return { name: ["provider"], errors: [issue.message] };
      })
      // De-dupe by name to avoid antd warnings.
      .filter(
        (field, index, arr) =>
          arr.findIndex((f) => JSON.stringify(f.name) === JSON.stringify(field.name)) === index,
      );

    if (fields.length) {
      form.setFields(fields as any);
    }
  };

  const validateProviderPatch = async (values: ProviderConfig): Promise<{
    valid: boolean;
    message?: string;
  }> => {
    const provider = (values.provider || currentProvider) as ProviderType;
    clearProviderValidationErrors(provider);

    try {
      const serviceFactory = ServiceFactory.getInstance();
      const result = await serviceFactory.validateBambooConfigPatch({
        provider: values.provider,
        providers: values.providers || {},
      });

      if (result.valid) {
        return { valid: true };
      }

      const providerIssues = result.errors?.provider || [];
      applyValidationIssuesToForm(providerIssues, provider);
      const first = providerIssues[0];
      return { valid: false, message: first?.message || "Invalid configuration" };
    } catch (error) {
      // Validation is best-effort; if it fails (network/server mismatch), fall back to strict
      // backend validation on save.
      console.warn("Config validation failed, falling back to save:", error);
      return { valid: true };
    }
  };

  const handleFetchOpenAIModels = async (options?: {
    force?: boolean;
    showMessage?: boolean;
  }) => {
    if (!options?.force && availableModels.length > 0) return;

    try {
      setFetchingModels(true);
      setModelsFetchError(null);
      setHasTriedFetchModels(true);

      // Use backend to fetch models with real API key
      const models = await settingsService.fetchProviderModels("openai");

      // Format models for Select component
      const formattedModels = models.map((model: string) => ({
        value: model,
        label: model,
      }));

      setAvailableModels(formattedModels);
      if (options?.showMessage !== false) {
        message.success(`Found ${formattedModels.length} available models`);
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      setModelsFetchError(errorMessage);
      if (options?.showMessage !== false) {
        message.error(
          errorMessage
            ? `Failed to fetch models: ${errorMessage}`
            : "Failed to fetch models. Please check your API key and base URL.",
        );
      }
      console.error("Failed to fetch OpenAI models:", error);
    } finally {
      setFetchingModels(false);
    }
  };

  const handleFetchAnthropicModels = async (options?: {
    force?: boolean;
    showMessage?: boolean;
  }) => {
    if (!options?.force && availableModels.length > 0) return;

    try {
      setFetchingModels(true);
      setModelsFetchError(null);
      setHasTriedFetchModels(true);

      // Use backend to fetch models with real API key
      const models = await settingsService.fetchProviderModels("anthropic");

      // Format models for Select component
      const formattedModels = models.map((model: string) => ({
        value: model,
        label: model,
      }));

      setAvailableModels(formattedModels);
      if (options?.showMessage !== false) {
        message.success(`Found ${formattedModels.length} available models`);
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      setModelsFetchError(errorMessage);
      if (options?.showMessage !== false) {
        message.error(
          errorMessage
            ? `Failed to fetch models: ${errorMessage}`
            : "Failed to fetch models. Please check your API key and base URL.",
        );
      }
      console.error("Failed to fetch Anthropic models:", error);
    } finally {
      setFetchingModels(false);
    }
  };

  const handleFetchGeminiModels = async (options?: {
    force?: boolean;
    showMessage?: boolean;
  }) => {
    if (!options?.force && availableModels.length > 0) return;

    try {
      setFetchingModels(true);
      setModelsFetchError(null);
      setHasTriedFetchModels(true);

      // Use backend to fetch models with real API key
      const models = await settingsService.fetchProviderModels("gemini");

      // Format models for Select component
      const formattedModels = models.map((model: string) => ({
        value: model,
        label: model,
      }));

      setAvailableModels(formattedModels);
      if (options?.showMessage !== false) {
        message.success(`Found ${formattedModels.length} available models`);
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      setModelsFetchError(errorMessage);
      if (options?.showMessage !== false) {
        message.error(
          errorMessage
            ? `Failed to fetch models: ${errorMessage}`
            : "Failed to fetch models. Please check your API key and base URL.",
        );
      }
      console.error("Failed to fetch Gemini models:", error);
    } finally {
      setFetchingModels(false);
    }
  };

  const handleFetchCopilotModels = async (options?: {
    force?: boolean;
    showMessage?: boolean;
  }) => {
    if (!options?.force && availableModels.length > 0) return;

    try {
      setFetchingModels(true);
      setModelsFetchError(null);
      setHasTriedFetchModels(true);

      // Copilot models are exposed via the OpenAI-compatible /openai/v1/models endpoint.
      const models = await modelService.getModels();
      const formattedModels = models.map((model: string) => ({
        value: model,
        label: model,
      }));

      setAvailableModels(formattedModels);

      if (formattedModels.length === 0) {
        const msg =
          "No models returned. Authenticate Copilot first, then fetch models.";
        setModelsFetchError(msg);
        if (options?.showMessage !== false) message.warning(msg);
        return;
      }

      if (options?.showMessage !== false) {
        message.success(`Found ${formattedModels.length} available models`);
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      setModelsFetchError(errorMessage);
      if (options?.showMessage !== false) {
        message.error(
          errorMessage
            ? `Failed to fetch models: ${errorMessage}`
            : "Failed to fetch models. Please authenticate Copilot and try again.",
        );
      }
      console.error("Failed to fetch Copilot models:", error);
    } finally {
      setFetchingModels(false);
    }
  };

  const handleSave = async (
    values: ProviderConfig,
    options?: { showMessage?: boolean; throwOnError?: boolean },
  ) => {
    try {
      setLoading(true);

      // Transform frontend format to backend format
      // Frontend has: { provider, providers: { openai: {...} } }
      // Backend expects: { provider, providers: { openai: {...} } }
      const payload = {
        provider: values.provider,
        providers: values.providers || {},
      };

      const validation = await validateProviderPatch(values);
      if (!validation.valid) {
        const errorMessage = validation.message || "Invalid configuration";
        if (options?.showMessage !== false) {
          message.error(`Invalid configuration: ${errorMessage}`);
        }
        if (options?.throwOnError) throw new Error(errorMessage);
        return;
      }

      console.log("Saving provider config:", payload);
      await settingsService.saveProviderConfig(payload);
      if (options?.showMessage !== false) {
        message.success("Configuration saved successfully");
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (options?.showMessage !== false) {
        message.error(
          errorMessage
            ? `Failed to save configuration: ${errorMessage}`
            : "Failed to save configuration",
        );
      }
      console.error("Failed to save configuration:", error);
      if (options?.throwOnError) throw error;
    } finally {
      setLoading(false);
    }
  };

  const handleApply = async (options?: {
    showMessage?: boolean;
    throwOnError?: boolean;
  }) => {
    try {
      setApplyingConfig(true);

      // POST /bamboo/settings/provider already saves the config and reloads the provider
      // on the backend. Here we just refresh the frontend store so useActiveModel()
      // reflects the updated provider/model immediately.
      const { useProviderStore } = await import(
        "../../../ChatPage/store/slices/providerSlice"
      );
      await useProviderStore.getState().loadProviderConfig();

      if (options?.showMessage !== false) {
        message.success(
          "Configuration applied successfully. Changes will take effect for new conversations.",
        );
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (options?.showMessage !== false) {
        message.error(
          errorMessage
            ? `Failed to apply configuration: ${errorMessage}`
            : "Failed to apply configuration",
        );
      }
      console.error("Failed to apply configuration:", error);
      if (options?.throwOnError) throw error;
    } finally {
      setApplyingConfig(false);
    }
  };

  const handleSaveAndApply = async (values: ProviderConfig) => {
    try {
      await handleSave(values, { throwOnError: true });
      await handleApply({ throwOnError: true });
    } catch {
      // Errors already shown via handleSave/handleApply
    }
  };

  const handleFetchModelsWithSave = async (
    provider: "openai" | "anthropic" | "gemini" | "copilot",
    options?: { force?: boolean },
  ) => {
    // If we already have models and this isn't an explicit refresh, do nothing.
    if (!options?.force && availableModels.length > 0) return;

    // Ensure latest API key/base URL is persisted before we fetch models.
    try {
      const values = form.getFieldsValue(true) as ProviderConfig;
      await handleSave(values, {
        showMessage: false,
        throwOnError: true,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      setModelsFetchError(errorMessage);
      setHasTriedFetchModels(true);
      message.error(
        errorMessage
          ? `Failed to save configuration: ${errorMessage}`
          : "Failed to save configuration",
      );
      return;
    }

    if (provider === "openai") {
      await handleFetchOpenAIModels({ force: options?.force });
    } else if (provider === "anthropic") {
      await handleFetchAnthropicModels({ force: options?.force });
    } else if (provider === "gemini") {
      await handleFetchGeminiModels({ force: options?.force });
    } else {
      await handleFetchCopilotModels({ force: options?.force });
    }
  };

  const handleModelDropdownOpen = async (
    provider: "openai" | "anthropic" | "gemini" | "copilot",
    open: boolean,
  ) => {
    if (!open) return;
    if (fetchingModels) return;
    if (availableModels.length > 0) return;
    if (hasTriedFetchModels && modelsFetchError) return;

    await handleFetchModelsWithSave(provider);
  };

  const handleModelChange = async (
    provider: "openai" | "anthropic" | "gemini" | "copilot",
    value: string | undefined,
  ) => {
    if (!value) return; // Don't auto-save cleared values
    if (modelAutoSaveStatus === "saving") return;

    setModelAutoSaveStatus("saving");
    setModelAutoSaveError(null);

    try {
      const currentValues = form.getFieldsValue(true) as ProviderConfig;

      // Ensure we save with the newly-selected model even if Form's internal
      // update hasn't propagated yet.
      currentValues.providers = currentValues.providers || {};
      (currentValues.providers as any)[provider] = {
        ...(currentValues.providers as any)[provider],
        model: value,
      };

      await handleSave(currentValues, {
        showMessage: false,
        throwOnError: true,
      });
      await handleApply({ showMessage: false, throwOnError: true });

      setModelAutoSaveStatus("success");
      message.success("Model updated successfully");
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      setModelAutoSaveStatus("error");
      setModelAutoSaveError(errorMessage);
      message.error(
        errorMessage ? `Failed to update model: ${errorMessage}` : "Failed to update model",
      );
    }
  };

  const renderProviderFields = () => {
    switch (currentProvider) {
      case "openai":
        return (
          <>
            <Alert
              message="OpenAI Configuration"
              description="Enter your OpenAI API key to use GPT models. You can optionally specify a custom base URL for proxy servers."
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
            />
            <Form.Item
              name={["providers", "openai", "api_key"]}
              label="OpenAI API Key"
              rules={[
                { required: true, message: "Please enter your OpenAI API key" },
              ]}
            >
              <Input.Password data-testid="api-key-input" placeholder="sk-..." prefix={<KeyOutlined />} />
            </Form.Item>
            <Form.Item
              name={["providers", "openai", "base_url"]}
              label="Base URL (Optional)"
              extra="Leave empty to use the default OpenAI API endpoint. Include full path (e.g., /v1) if needed."
            >
              <Input placeholder="https://api.openai.com/v1" />
            </Form.Item>
            <Form.Item
              name={["providers", "openai", "model"]}
              label="Default Model"
              rules={[{ required: true, message: "Please select a model" }]}
              extra={
                <Space direction="vertical" size={4}>
                  <Space size="small">
                    <Button
                      type="link"
                      size="small"
                      onClick={() =>
                        handleFetchModelsWithSave("openai", { force: true })
                      }
                      loading={fetchingModels}
                      style={{ padding: 0 }}
                    >
                      {fetchingModels
                        ? "Fetching models..."
                        : availableModels.length > 0
                          ? "Refresh available models from API"
                          : "Fetch available models from API"}
                    </Button>
                    {modelAutoSaveStatus === "saving" && <Spin size="small" />}
                    {modelAutoSaveStatus === "success" && (
                      <CheckCircleOutlined style={{ color: "#52c41a" }} />
                    )}
                    {modelAutoSaveStatus === "error" && (
                      <Tooltip
                        title={
                          modelAutoSaveError || "Failed to save model change"
                        }
                      >
                        <CloseCircleOutlined style={{ color: "#ff4d4f" }} />
                      </Tooltip>
                    )}
                  </Space>
                  {modelsFetchError && (
                    <Space size="small">
                      <Tooltip title={modelsFetchError}>
                        <Text type="danger">Failed to fetch models</Text>
                      </Tooltip>
                      <Button
                        size="small"
                        onClick={() =>
                          handleFetchModelsWithSave("openai", { force: true })
                        }
                        loading={fetchingModels}
                      >
                        Retry
                      </Button>
                    </Space>
                  )}
                </Space>
              }
            >
              <Select
                placeholder="Select a model"
                allowClear
                showSearch
                loading={fetchingModels}
                disabled={modelAutoSaveStatus === "saving"}
                notFoundContent={fetchingModels ? <Spin size="small" /> : null}
                onDropdownVisibleChange={(open) =>
                  handleModelDropdownOpen("openai", open)
                }
                onChange={(value) => handleModelChange("openai", value)}
              >
                {(availableModels.length > 0
                  ? availableModels
                  : OPENAI_MODELS
                ).map((model) => (
                  <Option key={model.value} value={model.value}>
                    {model.label}
                  </Option>
                ))}
              </Select>
            </Form.Item>

            <Form.Item
              name={["providers", "openai", "responses_only_models"]}
              label="Responses-Only Models (Optional)"
              extra={RESPONSES_ONLY_MODELS_HELP}
            >
              <Select
                mode="tags"
                placeholder='e.g. "gpt-5.3-codex", "gpt-5*"'
                tokenSeparators={[",", " ", "\n", "\t"]}
              />
            </Form.Item>
          </>
        );

      case "anthropic":
        return (
          <>
            <Alert
              message="Anthropic Configuration"
              description="Enter your Anthropic API key to use Claude models."
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
            />
            <Form.Item
              name={["providers", "anthropic", "api_key"]}
              label="Anthropic API Key"
              rules={[
                {
                  required: true,
                  message: "Please enter your Anthropic API key",
                },
              ]}
            >
              <Password placeholder="sk-ant-..." prefix={<KeyOutlined />} />
            </Form.Item>
            <Form.Item
              name={["providers", "anthropic", "base_url"]}
              label="Base URL (Optional)"
              extra="Leave empty to use the default Anthropic API endpoint. Include full path (e.g., /v1) if needed."
            >
              <Input placeholder="https://api.anthropic.com/v1" />
            </Form.Item>
            <Form.Item
              name={["providers", "anthropic", "model"]}
              label="Default Model"
              rules={[{ required: true, message: "Please select a model" }]}
              extra={
                <Space direction="vertical" size={4}>
                  <Space size="small">
                    <Button
                      type="link"
                      size="small"
                      onClick={() =>
                        handleFetchModelsWithSave("anthropic", { force: true })
                      }
                      loading={fetchingModels}
                      style={{ padding: 0 }}
                    >
                      {fetchingModels
                        ? "Fetching models..."
                        : availableModels.length > 0
                          ? "Refresh available models from API"
                          : "Fetch available models from API"}
                    </Button>
                    {modelAutoSaveStatus === "saving" && <Spin size="small" />}
                    {modelAutoSaveStatus === "success" && (
                      <CheckCircleOutlined style={{ color: "#52c41a" }} />
                    )}
                    {modelAutoSaveStatus === "error" && (
                      <Tooltip
                        title={
                          modelAutoSaveError || "Failed to save model change"
                        }
                      >
                        <CloseCircleOutlined style={{ color: "#ff4d4f" }} />
                      </Tooltip>
                    )}
                  </Space>
                  {modelsFetchError && (
                    <Space size="small">
                      <Tooltip title={modelsFetchError}>
                        <Text type="danger">Failed to fetch models</Text>
                      </Tooltip>
                      <Button
                        size="small"
                        onClick={() =>
                          handleFetchModelsWithSave("anthropic", { force: true })
                        }
                        loading={fetchingModels}
                      >
                        Retry
                      </Button>
                    </Space>
                  )}
                </Space>
              }
            >
              <Select
                placeholder="Select a model"
                allowClear
                showSearch
                loading={fetchingModels}
                disabled={modelAutoSaveStatus === "saving"}
                notFoundContent={fetchingModels ? <Spin size="small" /> : null}
                onDropdownVisibleChange={(open) =>
                  handleModelDropdownOpen("anthropic", open)
                }
                onChange={(value) => handleModelChange("anthropic", value)}
              >
                {(availableModels.length > 0
                  ? availableModels
                  : ANTHROPIC_MODELS
                ).map((model) => (
                  <Option key={model.value} value={model.value}>
                    {model.label}
                  </Option>
                ))}
              </Select>
            </Form.Item>
            <Form.Item
              name={["providers", "anthropic", "max_tokens"]}
              label="Max Tokens (Optional)"
              extra="Maximum number of tokens to generate"
            >
              <Input type="number" placeholder="4096" min={1} max={100000} />
            </Form.Item>
          </>
        );

      case "gemini":
        return (
          <>
            <Alert
              message="Google Gemini Configuration"
              description="Enter your Google AI API key to use Gemini models."
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
            />
            <Form.Item
              name={["providers", "gemini", "api_key"]}
              label="Gemini API Key"
              rules={[
                { required: true, message: "Please enter your Gemini API key" },
              ]}
            >
              <Password placeholder="AIza..." prefix={<KeyOutlined />} />
            </Form.Item>
            <Form.Item
              name={["providers", "gemini", "base_url"]}
              label="Base URL (Optional)"
              extra="Leave empty to use the default Google AI API endpoint. Include full path if needed."
            >
              <Input placeholder="https://generativelanguage.googleapis.com/v1beta" />
            </Form.Item>
            <Form.Item
              name={["providers", "gemini", "model"]}
              label="Default Model"
              rules={[{ required: true, message: "Please select a model" }]}
              extra={
                <Space direction="vertical" size={4}>
                  <Space size="small">
                    <Button
                      type="link"
                      size="small"
                      onClick={() =>
                        handleFetchModelsWithSave("gemini", { force: true })
                      }
                      loading={fetchingModels}
                      style={{ padding: 0 }}
                    >
                      {fetchingModels
                        ? "Fetching models..."
                        : availableModels.length > 0
                          ? "Refresh available models from API"
                          : "Fetch available models from API"}
                    </Button>
                    {modelAutoSaveStatus === "saving" && <Spin size="small" />}
                    {modelAutoSaveStatus === "success" && (
                      <CheckCircleOutlined style={{ color: "#52c41a" }} />
                    )}
                    {modelAutoSaveStatus === "error" && (
                      <Tooltip
                        title={
                          modelAutoSaveError || "Failed to save model change"
                        }
                      >
                        <CloseCircleOutlined style={{ color: "#ff4d4f" }} />
                      </Tooltip>
                    )}
                  </Space>
                  {modelsFetchError && (
                    <Space size="small">
                      <Tooltip title={modelsFetchError}>
                        <Text type="danger">Failed to fetch models</Text>
                      </Tooltip>
                      <Button
                        size="small"
                        onClick={() =>
                          handleFetchModelsWithSave("gemini", { force: true })
                        }
                        loading={fetchingModels}
                      >
                        Retry
                      </Button>
                    </Space>
                  )}
                </Space>
              }
            >
              <Select
                placeholder="Select a model"
                allowClear
                showSearch
                loading={fetchingModels}
                disabled={modelAutoSaveStatus === "saving"}
                notFoundContent={fetchingModels ? <Spin size="small" /> : null}
                onDropdownVisibleChange={(open) =>
                  handleModelDropdownOpen("gemini", open)
                }
                onChange={(value) => handleModelChange("gemini", value)}
              >
                {(availableModels.length > 0
                  ? availableModels
                  : GEMINI_MODELS
                ).map((model) => (
                  <Option key={model.value} value={model.value}>
                    {model.label}
                  </Option>
                ))}
              </Select>
            </Form.Item>
          </>
        );

      case "copilot": {
        const configuredCopilotModel = form.getFieldValue([
          "providers",
          "copilot",
          "model",
        ]) as string | undefined;

        // Prefer the real /v1/models list. If it's not loaded yet, keep showing the currently
        // configured model so the Select doesn't appear blank.
        const copilotModelOptions =
          availableModels.length > 0
            ? availableModels
            : configuredCopilotModel
              ? [{ value: configuredCopilotModel, label: configuredCopilotModel }]
              : [];

        return (
          <>
            <Alert
              message="GitHub Copilot Configuration"
              description="GitHub Copilot uses OAuth authentication. No API key is required. Make sure you have an active GitHub Copilot subscription."
              type="info"
              showIcon
            />

            <Card
              size="small"
              style={{ marginTop: 16, marginBottom: 16 }}
              title="Authentication Status"
              extra={
                checkingCopilotAuth ? (
                  <Spin size="small" />
                ) : copilotAuthStatus?.authenticated ? (
                  <Tag icon={<CheckCircleOutlined />} color="success">
                    Authenticated
                  </Tag>
                ) : (
                  <Tag icon={<CloseCircleOutlined />} color="error">
                    Not Authenticated
                  </Tag>
                )
              }
            >
              {copilotAuthStatus?.message && (
                <Paragraph type="secondary" style={{ marginBottom: 16 }}>
                  {copilotAuthStatus.message}
                </Paragraph>
              )}

              <Space>
                {copilotAuthStatus?.authenticated ? (
                  <Button
                    danger
                    icon={<LogoutOutlined />}
                    onClick={handleCopilotLogout}
                    loading={authenticatingCopilot}
                  >
                    Logout from Copilot
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    icon={<LoginOutlined />}
                    onClick={handleCopilotAuthenticate}
                    loading={authenticatingCopilot}
                  >
                    Authenticate Copilot
                  </Button>
                )}
                <Button
                  onClick={checkCopilotAuthStatus}
                  loading={checkingCopilotAuth}
                >
                  Refresh Status
                </Button>
              </Space>
            </Card>

            <Form.Item
              name={["providers", "copilot", "headless_auth"]}
              label="Headless Authentication"
              valuePropName="checked"
              extra="Print login URL in console instead of opening browser automatically"
            >
              <Switch />
            </Form.Item>

            <Form.Item
              name={["providers", "copilot", "model"]}
              label="Default Model"
              rules={[{ required: true, message: "Please select a model" }]}
              extra={
                <Space direction="vertical" size={4}>
                  <Space size="small">
                    <Button
                      type="link"
                      size="small"
                      onClick={() =>
                        handleFetchModelsWithSave("copilot", { force: true })
                      }
                      loading={fetchingModels}
                      style={{ padding: 0 }}
                    >
                      {fetchingModels
                        ? "Fetching models..."
                        : availableModels.length > 0
                          ? "Refresh available models from backend"
                          : "Fetch available models from backend"}
                    </Button>
                    {modelAutoSaveStatus === "saving" && <Spin size="small" />}
                    {modelAutoSaveStatus === "success" && (
                      <CheckCircleOutlined style={{ color: "#52c41a" }} />
                    )}
                    {modelAutoSaveStatus === "error" && (
                      <Tooltip
                        title={
                          modelAutoSaveError || "Failed to save model change"
                        }
                      >
                        <CloseCircleOutlined style={{ color: "#ff4d4f" }} />
                      </Tooltip>
                    )}
                  </Space>
                  {modelsFetchError && (
                    <Space size="small">
                      <Tooltip title={modelsFetchError}>
                        <Text type="danger">Failed to fetch models</Text>
                      </Tooltip>
                      <Button
                        size="small"
                        onClick={() =>
                          handleFetchModelsWithSave("copilot", { force: true })
                        }
                        loading={fetchingModels}
                      >
                        Retry
                      </Button>
                    </Space>
                  )}
                </Space>
              }
            >
              <Select
                placeholder="Select a model"
                allowClear
                showSearch
                loading={fetchingModels}
                disabled={modelAutoSaveStatus === "saving"}
                notFoundContent={
                  fetchingModels ? (
                    <Spin size="small" />
                  ) : (
                    <Text type="secondary">
                      {copilotAuthStatus?.authenticated
                        ? 'No models loaded yet. Click "Fetch available models from backend".'
                        : "Authenticate Copilot first, then fetch models."}
                    </Text>
                  )
                }
                onDropdownVisibleChange={(open) =>
                  handleModelDropdownOpen("copilot", open)
                }
                onChange={(value) => handleModelChange("copilot", value)}
              >
                {copilotModelOptions.map((model) => (
                  <Option key={model.value} value={model.value}>
                    {model.label}
                  </Option>
                ))}
              </Select>
            </Form.Item>

            <Form.Item
              name={["providers", "copilot", "responses_only_models"]}
              label="Responses-Only Models (Optional)"
              extra={RESPONSES_ONLY_MODELS_HELP}
            >
              <Select
                mode="tags"
                placeholder='e.g. "gpt-5.3-codex", "gpt-5*"'
                tokenSeparators={[",", " ", "\n", "\t"]}
              />
            </Form.Item>

            <Paragraph type="secondary">
              To use GitHub Copilot:
              <ul style={{ marginTop: 8, marginBottom: 0 }}>
                <li>Ensure you have an active GitHub Copilot subscription</li>
                <li>
                  Click "Authenticate Copilot" to start the device code flow
                </li>
                <li>
                  Follow the instructions in your terminal to complete
                  authentication
                </li>
              </ul>
            </Paragraph>
          </>
        );
      }

      default:
        return null;
    }
  };

  return (
    <Card
      title="LLM Provider Configuration"
      loading={loading && !configLoaded}
      extra={
        <Text type="secondary">
          Current Provider:{" "}
          <Text strong>{PROVIDER_LABELS[currentProvider]}</Text>
        </Text>
      }
    >
      <Paragraph type="secondary">
        Configure your preferred LLM provider. Configuration will be saved and
        applied when you click "Save and Apply Configuration".
      </Paragraph>

      <Divider />

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSaveAndApply}
        disabled={loading && !configLoaded}
      >
        <Form.Item
          name="provider"
          label="Active LLM Provider"
          rules={[{ required: true, message: "Please select a provider" }]}
        >
          <Select onChange={handleProviderChange} size="large">
            {(Object.keys(PROVIDER_LABELS) as ProviderType[]).map((key) => (
              <Option key={key} value={key}>
                {PROVIDER_LABELS[key]}
              </Option>
            ))}
          </Select>
        </Form.Item>

        <Divider />

        {renderProviderFields()}

        <Divider />

        <Space size="middle">
          <Button
            data-testid="save-api-settings"
            type="primary"
            htmlType="submit"
            icon={<SaveOutlined />}
            loading={loading || applyingConfig}
            size="large"
          >
            Save and Apply Configuration
          </Button>
        </Space>
      </Form>

      {/* Device Code Modal for Copilot Authentication */}
      <Modal
        title="Copilot Authentication"
        open={isDeviceCodeModalVisible}
        onCancel={() => setIsDeviceCodeModalVisible(false)}
        footer={[
          <Button
            key="cancel"
            onClick={() => setIsDeviceCodeModalVisible(false)}
          >
            Cancel
          </Button>,
          <Button
            key="complete"
            type="primary"
            onClick={handleCompleteAuth}
            loading={completingAuth}
          >
            I've Completed Authorization
          </Button>,
        ]}
      >
        {deviceCodeInfo && (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Alert
              message="Browser opened automatically"
              description={
                <ol>
                  <li>A GitHub page should have opened in your browser</li>
                  <li>Copy the code below and paste it on the GitHub page</li>
                  <li>Click "Continue" on GitHub to authorize</li>
                </ol>
              }
              type="info"
            />

            {/* Verification URL */}
            <Card size="small">
              <Space direction="vertical" style={{ width: "100%" }}>
                <Text type="secondary">1. Visit this URL:</Text>
                <Space>
                  <Text copyable={{ text: deviceCodeInfo.verification_uri }}>
                    {deviceCodeInfo.verification_uri}
                  </Text>
                </Space>
              </Space>
            </Card>

            {/* User Code */}
            <Card style={{ textAlign: "center", background: "#f5f5f5" }}>
              <Space direction="vertical" style={{ width: "100%" }}>
                <Text type="secondary">2. Enter this code:</Text>
                <Space>
                  <Text
                    style={{
                      fontSize: "32px",
                      fontFamily: "monospace",
                      fontWeight: "bold",
                      letterSpacing: "4px",
                    }}
                  >
                    {deviceCodeInfo.user_code}
                  </Text>
                  <Button
                    icon={
                      copiedUserCode ? (
                        <CheckCircleOutlined />
                      ) : (
                        <CopyOutlined />
                      )
                    }
                    onClick={handleCopyUserCode}
                    type={copiedUserCode ? "default" : "primary"}
                  >
                    {copiedUserCode ? "Copied!" : "Copy Code"}
                  </Button>
                </Space>
                <div style={{ marginTop: 8 }}>
                  <Tag
                    color={
                      timeRemaining < 60
                        ? "red"
                        : timeRemaining < 180
                          ? "orange"
                          : "green"
                    }
                  >
                    ⏱️ Expires in {Math.floor(timeRemaining / 60)}:
                    {(timeRemaining % 60).toString().padStart(2, "0")}
                  </Tag>
                </div>
              </Space>
            </Card>

            <Paragraph type="secondary">
              After clicking "Continue" on GitHub, click the "I've Completed
              Authorization" button below.
            </Paragraph>
          </Space>
        )}
      </Modal>
    </Card>
  );
};

export default ProviderSettings;
