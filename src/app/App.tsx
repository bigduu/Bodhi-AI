import { useEffect, useState } from "react";
import { App as AntApp, ConfigProvider, theme } from "antd";
import "./App.css";
import { MainLayout } from "./MainLayout";
import { SetupPage } from "../pages/SetupPage";
import { initializeStore } from "../pages/ChatPage/store";
import { ServiceFactory } from "../services/common/ServiceFactory";
import { StartupConfirmation } from "../shared/components/StartupConfirmation";
import { getBackendBaseUrlSync } from "../shared/utils/backendBaseUrl";
import { Button } from "antd";

const THEME_STORAGE_KEY = "copilot_ui_theme_v1";

// Determine if this is an internal build
// This should be set during build time via Vite define
const IS_INTERNAL_BUILD = import.meta.env.VITE_INTERNAL_BUILD === "true";

function App() {
  const [themeMode, setThemeMode] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return (saved as "light" | "dark") || "light";
  });
  const [isSetupComplete, setIsSetupComplete] = useState<boolean | null>(null);
  const [backendStartupError, setBackendStartupError] = useState<string | null>(
    null,
  );
  const [startupConfirmed, setStartupConfirmed] = useState(!IS_INTERNAL_BUILD);
  const [setupProbeNonce, setSetupProbeNonce] = useState(0);

  // Save theme to localStorage when it changes
  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    const checkSetupStatus = async () => {
      try {
        const serviceFactory = ServiceFactory.getInstance();
        const status = await serviceFactory.getSetupStatus();
        if (cancelled) return;
        setBackendStartupError(null);
        setIsSetupComplete(status.is_complete);
      } catch (error) {
        if (cancelled) return;

        const elapsedMs = Date.now() - startedAt;
        // Give a local backend (embedded or standalone) time to come up before treating this
        // as a real "setup incomplete" signal.
        const maxWaitMs = import.meta.env.MODE === "test" ? 250 : 20_000;

        if (elapsedMs >= maxWaitMs) {
          const baseUrl = getBackendBaseUrlSync();
          const message =
            error instanceof Error && error.message.trim()
              ? error.message
              : "Unknown error";
          setBackendStartupError(
            `Backend not reachable at ${baseUrl} (last error: ${message})`,
          );
          // Keep `isSetupComplete` as null so we don't incorrectly show SetupPage.
          return;
        }

        // Retry with a small backoff. ApiClient already retries per request;
        // this loop handles the "backend not listening yet" startup window.
        const delayMs = Math.min(500 + Math.floor(elapsedMs / 2), 2000);
        setTimeout(() => {
          if (!cancelled) void checkSetupStatus();
        }, delayMs);
      }
    };

    void checkSetupStatus();
    return () => {
      cancelled = true;
    };
  }, [setupProbeNonce]);

  useEffect(() => {
    document.body.setAttribute("data-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (isSetupComplete) {
      initializeStore();
    }
  }, [isSetupComplete]);

  // Show startup confirmation for internal builds
  if (IS_INTERNAL_BUILD && !startupConfirmed) {
    return (
      <ConfigProvider
        theme={{
          token: {
            colorPrimary: "#1677ff",
            borderRadius: 6,
          },
          algorithm:
            themeMode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        }}
      >
        <AntApp>
          <StartupConfirmation
            onConfirm={() => setStartupConfirmed(true)}
            onDecline={() => {
              if (typeof window !== "undefined") {
                window.close();
              }
            }}
          />
        </AntApp>
      </ConfigProvider>
    );
  }

  if (isSetupComplete === null) {
    if (backendStartupError) {
      return (
        <div style={{ padding: 40, textAlign: "center" }}>
          <div style={{ marginBottom: 12 }}>{backendStartupError}</div>
          <Button
            type="primary"
            onClick={() => {
              setBackendStartupError(null);
              setIsSetupComplete(null);
              setSetupProbeNonce((v) => v + 1);
            }}
          >
            Retry
          </Button>
        </div>
      );
    }
    return <div style={{ padding: 40, textAlign: "center" }}>Loading...</div>;
  }

  const appContent = isSetupComplete ? (
    <MainLayout themeMode={themeMode} onThemeModeChange={setThemeMode} />
  ) : (
    <SetupPage />
  );

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#1677ff",
          borderRadius: 6,
        },
        algorithm:
          themeMode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
      <AntApp>
        <div style={{ position: "relative" }}>{appContent}</div>
      </AntApp>
    </ConfigProvider>
  );
}

export default App;
