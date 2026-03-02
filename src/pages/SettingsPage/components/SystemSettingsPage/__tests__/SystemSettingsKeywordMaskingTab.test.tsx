import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SystemSettingsKeywordMaskingTab from "../SystemSettingsKeywordMaskingTab";

// Mock fetch globally
global.fetch = vi.fn();

describe("SystemSettingsKeywordMaskingTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [] }),
    });
  });

  it("applies example selection to pattern and match type", async () => {
    render(<SystemSettingsKeywordMaskingTab />);

    const addButton = await screen.findByTestId("add-keyword");
    // The button is disabled while initial config load is in-flight; avoid flakiness
    // under parallel test execution.
    await waitFor(() => expect(addButton).not.toBeDisabled());
    fireEvent.click(addButton);

    // AntD Select roles/structures can vary in jsdom; use a stable test id.
    const examplesSelect = await screen.findByTestId("keyword-examples-select");
    const trigger =
      examplesSelect.querySelector(".ant-select-selector") ?? examplesSelect;
    fireEvent.mouseDown(trigger);

    const exampleOption = await screen.findByText("Mask GitHub tokens");
    fireEvent.click(exampleOption);

    await waitFor(() => {
      const input = screen.getByPlaceholderText("Enter pattern to match");
      expect((input as HTMLInputElement).value).toBe("ghp_[A-Za-z0-9]+");
    });
  });
});
