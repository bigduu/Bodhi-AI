/**
 * Unified File Operations Service
 * Provides platform-specific save behavior for both browser and Tauri.
 */
import { isTauriEnvironment } from "../../../utils/environment";

export interface FileFilter {
  name: string;
  extensions: ReadonlyArray<string>;
}

export interface SaveFileOptions {
  content: Uint8Array | string;
  filters: ReadonlyArray<FileFilter>;
  defaultPath: string;
}

export interface SaveFileResult {
  filename: string;
  success: boolean;
  error?: string;
}

interface PlatformFileOperations {
  saveFile(options: SaveFileOptions): Promise<SaveFileResult>;
}

class TauriFileOperations implements PlatformFileOperations {
  async saveFile(options: SaveFileOptions): Promise<SaveFileResult> {
    const { content, filters, defaultPath } = options;

    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile, writeTextFile } = await import("@tauri-apps/plugin-fs");

    const filePath = await save({
      // Convert readonly arrays into the mutable shape expected by Tauri dialog types.
      filters: filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })),
      defaultPath,
    });

    if (!filePath) {
      throw new Error("User cancelled save operation");
    }

    if (typeof content === "string") {
      await writeTextFile(filePath, content);
    } else {
      await writeFile(filePath, content);
    }

    return {
      filename: extractFilename(filePath, defaultPath),
      success: true,
    };
  }
}

class BrowserFileOperations implements PlatformFileOperations {
  async saveFile(options: SaveFileOptions): Promise<SaveFileResult> {
    const { content, filters, defaultPath } = options;
    const filename = extractFilename(defaultPath, defaultPath);

    if (typeof window === "undefined" || typeof document === "undefined") {
      throw new Error("File save is unavailable in this environment");
    }

    const mimeType = inferMimeType(filters, content);
    const blob =
      typeof content === "string"
        ? new Blob([content], { type: `${mimeType};charset=utf-8` })
        : new Blob([content], { type: mimeType });

    const objectUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }

    return { filename, success: true };
  }
}

const tauriFileOperations = new TauriFileOperations();
const browserFileOperations = new BrowserFileOperations();

const extractFilename = (value: string, fallback: string): string =>
  value.split(/[/\\]/).pop() || fallback;

const inferMimeType = (
  filters: ReadonlyArray<FileFilter>,
  content: SaveFileOptions["content"],
): string => {
  const firstExtension = filters[0]?.extensions?.[0]?.toLowerCase() || "";

  switch (firstExtension) {
    case "md":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    default:
      return typeof content === "string"
        ? "text/plain"
        : "application/octet-stream";
  }
};

const getPlatformFileOperations = (): PlatformFileOperations =>
  isTauriEnvironment() ? tauriFileOperations : browserFileOperations;

export class FileOperationsService {
  /**
   * Save file with unified error handling
   */
  static async saveFile(options: SaveFileOptions): Promise<SaveFileResult> {
    try {
      return await getPlatformFileOperations().saveFile(options);
    } catch (error) {
      return {
        filename: "",
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Save text file (convenience method)
   */
  static async saveTextFile(
    content: string,
    filters: ReadonlyArray<FileFilter>,
    defaultPath: string,
  ): Promise<SaveFileResult> {
    return this.saveFile({ content, filters, defaultPath });
  }

  /**
   * Save binary file (convenience method)
   */
  static async saveBinaryFile(
    content: Uint8Array,
    filters: ReadonlyArray<FileFilter>,
    defaultPath: string,
  ): Promise<SaveFileResult> {
    return this.saveFile({ content, filters, defaultPath });
  }

  /**
   * Common file filters
   */
  static readonly FILTERS = {
    MARKDOWN: [{ name: "Markdown", extensions: ["md"] }],
    PDF: [{ name: "PDF", extensions: ["pdf"] }],
    TEXT: [{ name: "Text", extensions: ["txt"] }],
    JSON: [{ name: "JSON", extensions: ["json"] }],
    ALL: [{ name: "All Files", extensions: ["*"] }],
  } as const;

  /**
   * Generate timestamped filename
   */
  static generateTimestampedFilename(
    prefix: string,
    extension: string,
  ): string {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    return `${prefix}-${timestamp}.${extension}`;
  }
}
