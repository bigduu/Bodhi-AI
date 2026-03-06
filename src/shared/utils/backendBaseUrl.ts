const BACKEND_BASE_URL_KEY = "copilot_backend_base_url";

const FALLBACK_BACKEND_BASE_URL = "http://127.0.0.1:9562/v1";

const DEFAULT_PORT = 9562;

export const normalizeBackendBaseUrl = (value: string): string =>
  value.trim().replace(/\/+$/, "");

export const getDefaultBackendBaseUrl = (): string => {
  const processEnvUrl = (globalThis as any).process?.env
    ?.VITE_BACKEND_BASE_URL as string | undefined;
  const envUrl =
    (import.meta.env.VITE_BACKEND_BASE_URL as string | undefined) ??
    processEnvUrl;
  if (envUrl) {
    return normalizeBackendBaseUrl(envUrl);
  }
  return FALLBACK_BACKEND_BASE_URL;
};

/**
 * Check if the backend server is healthy at the given URL
 */
const checkBackendHealth = async (baseUrl: string): Promise<boolean> => {
  try {
    // The UI stores a base like ".../v1". The health endpoint lives under "/api/v1/health".
    // Keep a legacy fallback to ".../health" for older deployments.
    const normalized = normalizeBackendBaseUrl(baseUrl);
    const origin = normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
    const healthUrls = [`${origin}/api/v1/health`, `${normalized}/health`];

    for (const healthUrl of healthUrls) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      try {
        const response = await fetch(healthUrl, {
          method: "GET",
          signal: controller.signal,
        });

        if (response.ok) return true;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return false;
  } catch (e) {
    // Backend not available at this URL
    return false;
  }
};

/**
 * Discover backend URL with health check
 * Tries configured port first, then default port
 */
export const getBackendBaseUrl = async (): Promise<string> => {
  // Check if port is provided via environment/config (for Tauri sidecar mode)
  const configPort = (window as any).__BAMBOO_BACKEND_PORT__;
  if (configPort) {
    const configuredUrl = normalizeBackendBaseUrl(`http://127.0.0.1:${configPort}/v1`);
    if (await checkBackendHealth(configuredUrl)) {
      return configuredUrl;
    }
    console.warn(`Backend not available at configured port ${configPort}, falling back to discovery`);
  }

  // Check localStorage for user-configured URL
  const stored = localStorage.getItem(BACKEND_BASE_URL_KEY);
  if (stored) {
    const normalized = normalizeBackendBaseUrl(stored);
    // Validate the URL before returning
    try {
      new URL(normalized);
      if (await checkBackendHealth(normalized)) {
        return normalized;
      }
      console.warn("Backend not available at stored URL, trying discovery:", normalized);
    } catch (e) {
      console.warn("Invalid stored backend URL, removing:", normalized);
      localStorage.removeItem(BACKEND_BASE_URL_KEY);
    }
  }

  // Try default port with health check
  const defaultUrl = normalizeBackendBaseUrl(`http://127.0.0.1:${DEFAULT_PORT}/v1`);
  if (await checkBackendHealth(defaultUrl)) {
    return defaultUrl;
  }

  // Fall back to environment-based URL without health check (for development)
  return getDefaultBackendBaseUrl();
};

/**
 * Synchronous version for backwards compatibility
 * Does not perform health check - uses localStorage or default
 */
export const getBackendBaseUrlSync = (): string => {
  const stored = localStorage.getItem(BACKEND_BASE_URL_KEY);
  if (stored) {
    const normalized = normalizeBackendBaseUrl(stored);
    try {
      new URL(normalized);
      return normalized;
    } catch (e) {
      console.warn("Invalid stored backend URL, using default:", normalized);
      localStorage.removeItem(BACKEND_BASE_URL_KEY);
    }
  }
  return getDefaultBackendBaseUrl();
};

export const setBackendBaseUrl = (value: string): void => {
  localStorage.setItem(BACKEND_BASE_URL_KEY, normalizeBackendBaseUrl(value));
};

export const clearBackendBaseUrlOverride = (): void => {
  localStorage.removeItem(BACKEND_BASE_URL_KEY);
};

export const hasBackendBaseUrlOverride = (): boolean =>
  localStorage.getItem(BACKEND_BASE_URL_KEY) !== null;

export const buildBackendUrl = (path: string): string => {
  const baseUrl = getBackendBaseUrlSync().replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "");
  return `${baseUrl}/${cleanPath}`;
};

// Global type for Tauri sidecar port injection
declare global {
  interface Window {
    __BAMBOO_BACKEND_PORT__?: number;
  }
}
