import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpServerFormModal } from "../McpServerFormModal";

describe("McpServerFormModal", () => {
  let unhandledRejectionHandler:
    | ((event: PromiseRejectionEvent) => void)
    | null;

  beforeEach(() => {
    unhandledRejectionHandler = null;
  });

  afterEach(() => {
    if (unhandledRejectionHandler) {
      window.removeEventListener(
        "unhandledrejection",
        unhandledRejectionHandler,
      );
    }
  });

  it("submits stdio server configuration", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <McpServerFormModal
        open
        mode="create"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    // Let the modal/form effects apply initial values before we start interacting.
    await waitFor(() => {
      expect(screen.getByPlaceholderText("filesystem")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("filesystem"), {
      target: { value: "filesystem" },
    });

    fireEvent.change(screen.getByPlaceholderText("Filesystem MCP"), {
      target: { value: "Filesystem" },
    });

    fireEvent.change(screen.getByPlaceholderText("npx"), {
      target: { value: "npx" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());

    const submitted = onSubmit.mock.calls[0]?.[0];
    expect(submitted).toEqual(
      expect.objectContaining({
        id: "filesystem",
        name: "Filesystem",
        transport: expect.objectContaining({
          type: "stdio",
          command: "npx",
        }),
      }),
    );
  });

  it("preserves form data when submission fails", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Connection failed"));
    const onCancel = vi.fn();

    // Suppress the unhandled rejection that occurs due to Modal's void handleSubmit() usage
    unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
      if (event.reason?.message === "Connection failed") {
        event.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", unhandledRejectionHandler);

    render(
      <McpServerFormModal
        open
        mode="create"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );

    // Fill out the form
    fireEvent.change(screen.getByPlaceholderText("filesystem"), {
      target: { value: "my-server" },
    });

    fireEvent.change(screen.getByPlaceholderText("Filesystem MCP"), {
      target: { value: "My Server" },
    });

    fireEvent.change(screen.getByPlaceholderText("npx"), {
      target: { value: "node" },
    });

    // Submit the form (it will fail)
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });

    // Verify form data is preserved after error
    const serverIdInput = screen.getByPlaceholderText(
      "filesystem",
    ) as HTMLInputElement;
    const displayNameInput = screen.getByPlaceholderText(
      "Filesystem MCP",
    ) as HTMLInputElement;
    const commandInput = screen.getByPlaceholderText("npx") as HTMLInputElement;

    expect(serverIdInput.value).toBe("my-server");
    expect(displayNameInput.value).toBe("My Server");
    expect(commandInput.value).toBe("node");

    // Verify modal is still open (user can retry)
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("submits via JSON editor", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <McpServerFormModal
        open
        mode="create"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    // Switch to JSON mode
    fireEvent.click(screen.getByRole("radio", { name: /json/i }));

    // Wait for textarea to appear
    await waitFor(() => {
      expect(document.querySelector("textarea")).not.toBeNull();
    });

    const config = {
      id: "json-server",
      enabled: true,
      transport: {
        type: "stdio" as const,
        command: "node",
        args: ["server.js"],
        env: {},
      },
      request_timeout_ms: 60000,
      healthcheck_interval_ms: 30000,
      allowed_tools: [],
      denied_tools: [],
    };

    const textarea = document.querySelector("textarea");
    fireEvent.change(textarea!, {
      target: { value: JSON.stringify(config, null, 2) },
    });

    // Submit the form
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "json-server",
          transport: expect.objectContaining({
            type: "stdio",
            command: "node",
          }),
        }),
      );
    });
  });

  it("shows error for invalid JSON", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <McpServerFormModal
        open
        mode="create"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    // Switch to JSON mode
    fireEvent.click(screen.getByRole("radio", { name: /json/i }));

    await waitFor(() => {
      expect(document.querySelector("textarea")).not.toBeNull();
    });

    const textarea = document.querySelector("textarea");
    fireEvent.change(textarea!, {
      target: { value: "{ invalid json" },
    });

    // Submit the form
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("JSON Error")).toBeDefined();
    });

    // Should not call onSubmit
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
