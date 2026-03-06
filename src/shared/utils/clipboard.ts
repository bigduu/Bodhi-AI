/**
 * Unified clipboard helper for both browser and desktop webview environments.
 *
 * Preferred path: navigator.clipboard.writeText
 * Fallback path: document.execCommand("copy")
 */

const copyWithNavigatorClipboard = async (text: string): Promise<void> => {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("navigator.clipboard.writeText is unavailable");
  }
  await navigator.clipboard.writeText(text);
};

const copyWithExecCommand = (text: string): void => {
  if (typeof document === "undefined") {
    throw new Error("document is unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  textarea.focus();
  textarea.select();

  const success = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!success) {
    throw new Error("document.execCommand('copy') returned false");
  }
};

export const copyText = async (text: string): Promise<void> => {
  try {
    await copyWithNavigatorClipboard(text);
    return;
  } catch (navigatorError) {
    try {
      copyWithExecCommand(text);
      return;
    } catch (fallbackError) {
      const navigatorMessage =
        navigatorError instanceof Error
          ? navigatorError.message
          : String(navigatorError);
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      throw new Error(
        `Clipboard copy failed: navigator(${navigatorMessage}); fallback(${fallbackMessage})`,
      );
    }
  }
};
