import type { TodoListMsg } from "./todoList";
import type { TokenUsage } from "./tokenBudget";

export type AgentRole = "planner" | "actor";

export type MessageType =
  | "text"
  | "plan"
  | "question"
  | "tool_call"
  | "tool_result";

export interface PlanMessage {
  goal: string;
  steps: PlanStep[];
  estimated_total_time: string;
  risks: string[];
  prerequisites?: string[];
}

export interface PlanStep {
  step_number: number;
  action: string;
  reason: string;
  tools_needed: string[];
  estimated_time: string;
}

export interface QuestionMessage {
  type: "question";
  question: string;
  context: string;
  severity: "critical" | "major" | "minor";
  options: QuestionOption[];
  default?: string;
  allow_custom?: boolean;
}

export interface QuestionOption {
  label: string;
  value: string;
  description: string;
}

export interface MessageImage {
  id: string;
  // For newly added images (before backend persistence), we keep base64.
  // For persisted sessions, the backend stores attachments by reference; we render via URL.
  base64?: string;
  url?: string;
  name: string;
  size: number;
  type: string;
  width?: number;
  height?: number;
}

export type DisplayPreference = "Default" | "Collapsible" | "Hidden";

export interface ToolExecutionResult {
  tool_name: string;
  result: string;
  display_preference: DisplayPreference;
}

export type ExecutionStatus = "success" | "error" | "warning";

interface BaseMessage {
  id: string;
  createdAt: string;
  isError?: boolean;
  isAuthError?: boolean;
}

export interface SystemMessage extends BaseMessage {
  role: "system";
  content: string;
}

export interface UserMessage extends BaseMessage {
  role: "user";
  content: string;
  images?: MessageImage[];
}

export interface UserFileReferenceMessage extends BaseMessage {
  role: "user";
  type: "file_reference";
  paths: string[];
  displayText: string;
}

export interface AssistantTextMessage extends BaseMessage {
  role: "assistant";
  type: "text";
  content: string;
  model?: string;
  finishReason?: "stop" | "length" | "error";
  tokenUsage?: { promptTokens: number; completionTokens: number };
  latency?: { firstTokenMs: number; totalDurationMs: number };
  metadata?: {
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    should_continue?: boolean;
    continue_reason?: string;
    continuation_count?: number;
    [key: string]: any;
  };
}

export interface AssistantToolCallMessage extends BaseMessage {
  role: "assistant";
  type: "tool_call";
  toolCalls: {
    toolCallId: string;
    toolName: string;
    parameters: Record<string, any>;
    // Optional live output streamed during tool execution (e.g. Claude Code CLI).
    streamingOutput?: string;
  }[];
  model?: string;
  finishReason?: "tool_calls";
}

export interface AssistantToolResultMessage extends BaseMessage {
  role: "assistant";
  type: "tool_result";
  toolName: string;
  toolCallId: string;
  result: ToolExecutionResult;
  isError: boolean;
}

export interface WorkflowResultMessage extends BaseMessage {
  role: "assistant";
  type: "workflow_result";
  workflowName: string;
  parameters?: Record<string, unknown> | string | null;
  status?: ExecutionStatus;
  content: string;
}

export interface AssistantTodoListMessage extends BaseMessage {
  role: "assistant";
  type: "todo_list";
  todoList: TodoListMsg;
}

export type Message =
  | UserMessage
  | UserFileReferenceMessage
  | AssistantTextMessage
  | AssistantToolCallMessage
  | AssistantToolResultMessage
  | AssistantTodoListMessage
  | WorkflowResultMessage
  | SystemMessage;

export interface ChatItem {
  id: string;
  // Backend session metadata (V2).
  kind?: "root" | "child";
  parentSessionId?: string | null;
  rootSessionId?: string;
  spawnDepth?: number;
  createdByScheduleId?: string | null;
  isRunning?: boolean;
  updatedAt?: string;
  lastActivityAt?: string;
  messageCount?: number;
  hasAttachments?: boolean;
  title: string;
  createdAt: number;
  pinned?: boolean;
  messages: Message[];
  config: {
    systemPromptId: string;
    baseSystemPrompt: string;
    lastUsedEnhancedPrompt: string | null;
    agentRole?: AgentRole;
    workspacePath?: string;
    tokenUsage?: TokenUsage;
    truncationOccurred?: boolean;
    segmentsRemoved?: number;
  };
  currentInteraction: {
    machineState: string; // Legacy field, no longer used
    streamingMessageId: string | null;
    streamingContent: string | null;
    pendingApproval?: {
      toolCallId: string;
      toolName: string;
      parameters: Record<string, any>;
    };
    error?: {
      message: string;
      details?: any;
    };
  } | null;
}
