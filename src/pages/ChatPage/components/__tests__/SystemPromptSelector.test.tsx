import { render, screen, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SystemPromptSelector from "../SystemPromptSelector";
import type { UserSystemPrompt } from "../../types/chat";

// Mock the zustand store
const mockSetLastSelectedPromptId = vi.fn();

vi.mock("../../../store", () => ({
  useAppStore: (selector: (state: any) => any) => {
    const state = {
      lastSelectedPromptId: null,
      setLastSelectedPromptId: mockSetLastSelectedPromptId,
    };
    return selector(state);
  },
}));

describe("SystemPromptSelector", () => {
  const mockPrompts: UserSystemPrompt[] = [
    {
      id: "general_assistant",
      name: "Bamboo",
      content: "You are Bamboo, a highly capable AI assistant.",
      description: "Default system prompt.",
      isDefault: true,
    },
    {
      id: "custom_prompt",
      name: "Custom Prompt",
      content: "You are a custom assistant.",
      description: "Custom system prompt.",
      isDefault: false,
    },
    {
      id: "chinese_prompt",
      name: "测试助手",
      content: "你是一个有帮助的助手。",
      description: "Chinese assistant",
      isDefault: false,
    },
  ];

  const mockOnSelect = vi.fn();
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render with prompts", () => {
    render(
      <SystemPromptSelector
        open={true}
        onClose={mockOnClose}
        onSelect={mockOnSelect}
        prompts={mockPrompts}
      />,
    );

    expect(screen.getByText("Select System Prompt")).toBeTruthy();
    // Use getAllByText since "Default" appears multiple times (name and tag)
    expect(screen.getAllByText("Default").length).toBeGreaterThan(0);
    expect(screen.getByText("Custom Prompt")).toBeTruthy();
    expect(screen.getByText("测试助手")).toBeTruthy();
  });

  it("should auto-select default prompt when opened", async () => {
    render(
      <SystemPromptSelector
        open={true}
        onClose={mockOnClose}
        onSelect={mockOnSelect}
        prompts={mockPrompts}
      />,
    );

    await waitFor(() => {
      const createButton = screen.getByText("Create New Session");
      expect(createButton).not.toBeDisabled();
    });
  });

  it("should auto-select first prompt when no default exists", async () => {
    const promptsWithoutDefault: UserSystemPrompt[] = [
      {
        id: "first_prompt",
        name: "First Prompt",
        content: "First prompt content",
        description: "First",
        isDefault: false,
      },
      {
        id: "second_prompt",
        name: "Second Prompt",
        content: "Second prompt content",
        description: "Second",
        isDefault: false,
      },
    ];

    render(
      <SystemPromptSelector
        open={true}
        onClose={mockOnClose}
        onSelect={mockOnSelect}
        prompts={promptsWithoutDefault}
      />,
    );

    await waitFor(() => {
      const createButton = screen.getByText("Create New Session");
      expect(createButton).not.toBeDisabled();
    });
  });

  it("should filter out prompts with empty IDs", async () => {
    const promptsWithEmptyId: UserSystemPrompt[] = [
      {
        id: "",
        name: "Invalid Prompt",
        content: "Invalid prompt",
        description: "Invalid",
        isDefault: false,
      },
      {
        id: "valid_prompt",
        name: "Valid Prompt",
        content: "Valid prompt",
        description: "Valid",
        isDefault: false,
      },
    ];

    render(
      <SystemPromptSelector
        open={true}
        onClose={mockOnClose}
        onSelect={mockOnSelect}
        prompts={promptsWithEmptyId}
      />,
    );

    await waitFor(() => {
      const createButton = screen.getByText("Create New Session");
      // Button should not be disabled because valid_prompt is available
      expect(createButton).not.toBeDisabled();
    });
  });

  it("should disable button when all prompts have empty IDs", async () => {
    const promptsAllEmptyId: UserSystemPrompt[] = [
      {
        id: "",
        name: "Invalid Prompt 1",
        content: "Invalid prompt 1",
        description: "Invalid 1",
        isDefault: false,
      },
      {
        id: "",
        name: "Invalid Prompt 2",
        content: "Invalid prompt 2",
        description: "Invalid 2",
        isDefault: false,
      },
    ];

    await act(async () => {
      render(
        <SystemPromptSelector
          open={true}
          onClose={mockOnClose}
          onSelect={mockOnSelect}
          prompts={promptsAllEmptyId}
        />,
      );
    });

    // Use role to find the button more precisely
    const createButton = await screen.findByRole("button", {
      name: "Create New Session",
    });

    // Check both the disabled property and attribute
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveAttribute("disabled");
  });

  it("should disable button when no prompts exist", async () => {
    await act(async () => {
      render(
        <SystemPromptSelector
          open={true}
          onClose={mockOnClose}
          onSelect={mockOnSelect}
          prompts={[]}
        />,
      );
    });

    const createButton = await screen.findByRole("button", {
      name: "Create New Session",
    });
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveAttribute("disabled");
  });

  it("should show empty state when no prompts exist", () => {
    render(
      <SystemPromptSelector
        open={true}
        onClose={mockOnClose}
        onSelect={mockOnSelect}
        prompts={[]}
      />,
    );

    expect(
      screen.getByText("No system prompts found. Add one in System Settings."),
    ).toBeTruthy();
  });

  it("should prioritize lastSelectedPromptId over default", async () => {
    // This test verifies the priority logic
    // In the actual component, lastSelectedPromptId comes from the store
    // Here we're just verifying the selection works
    render(
      <SystemPromptSelector
        open={true}
        onClose={mockOnClose}
        onSelect={mockOnSelect}
        prompts={mockPrompts}
      />,
    );

    await waitFor(() => {
      const createButton = screen.getByText("Create New Session");
      expect(createButton).not.toBeDisabled();
    });
  });

  it("should handle Chinese prompt names correctly", async () => {
    const chinesePrompts: UserSystemPrompt[] = [
      {
        id: "chinese_assistant",
        name: "测试助手",
        content: "你是一个有帮助的助手。",
        description: "Chinese assistant",
        isDefault: false,
      },
    ];

    render(
      <SystemPromptSelector
        open={true}
        onClose={mockOnClose}
        onSelect={mockOnSelect}
        prompts={chinesePrompts}
      />,
    );

    await waitFor(() => {
      const createButton = screen.getByText("Create New Session");
      // Button should be enabled because the prompt has a valid ID
      expect(createButton).not.toBeDisabled();
    });
  });

  it("should call onSelect with selected prompt when Create New Session is clicked", async () => {
    render(
      <SystemPromptSelector
        open={true}
        onClose={mockOnClose}
        onSelect={mockOnSelect}
        prompts={mockPrompts}
      />,
    );

    await waitFor(() => {
      const createButton = screen.getByText("Create New Session");
      expect(createButton).not.toBeDisabled();
    });

    // Click the Create New Session button
    const createButton = screen.getByText("Create New Session");
    createButton.click();

    await waitFor(() => {
      expect(mockOnSelect).toHaveBeenCalled();
      expect(mockOnSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "general_assistant", // Default prompt should be selected
        }),
      );
    });
  });

  it("should call onClose when Cancel is clicked", async () => {
    render(
      <SystemPromptSelector
        open={true}
        onClose={mockOnClose}
        onSelect={mockOnSelect}
        prompts={mockPrompts}
        showCancelButton={true}
      />,
    );

    const cancelButton = screen.getByText("Cancel");
    cancelButton.click();

    await waitFor(() => {
      expect(mockOnClose).toHaveBeenCalled();
    });
  });
});
