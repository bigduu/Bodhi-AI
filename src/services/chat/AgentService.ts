/**
 * Agent Client Service
 *
 * HTTP client for communicating with local copilot-agent endpoints
 * Handles SSE streaming and AgentEvent processing
 */
import { agentApiClient } from "../api";

// Agent Event Types (matching Rust backend)
export type AgentEventType =
  | "token"
  | "tool_token"
  | "tool_start"
  | "tool_complete"
  | "tool_error"
  | "todo_list_updated"
  | "todo_list_item_progress"
  | "todo_list_completed"
  | "todo_evaluation_started"
  | "todo_evaluation_completed"
  | "token_budget_updated"
  | "context_summarized"
  | "sub_session_started"
  | "sub_session_event"
  | "sub_session_heartbeat"
  | "sub_session_completed"
  | "complete"
  | "error";

export interface TokenBudgetUsage {
  system_tokens: number;
  summary_tokens: number;
  window_tokens: number;
  total_tokens: number;
  budget_limit: number;
  truncation_occurred: boolean;
  segments_removed: number;
}

export interface ContextSummaryInfo {
  summary: string;
  messages_summarized: number;
  tokens_saved: number;
}

// TodoList Types
export type TodoItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked";

export interface TodoItem {
  id: string;
  description: string;
  status: TodoItemStatus;
  depends_on: string[];
  notes: string;
}

export interface TodoList {
  session_id: string;
  title: string;
  items: TodoItem[];
  created_at: string;
  updated_at: string;
}

export interface TodoListDelta {
  session_id: string;
  item_id: string;
  status: TodoItemStatus;
  tool_calls_count: number;
  version: number;
}

export interface AgentEvent {
  type: AgentEventType;
  content?: string;
  tool_call_id?: string;
  tool_name?: string;
  arguments?: Record<string, unknown>;
  result?: {
    success: boolean;
    result: string;
    display_preference?: string;
  };
  error?: string;
  message?: string; // For Error events
  // Union type because 'usage' field has different shapes for different events
  usage?:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }
    | TokenBudgetUsage;
  summary_info?: ContextSummaryInfo;
  // TodoList events
  todo_list?: TodoList;
  // TodoList delta
  session_id?: string;
  item_id?: string;
  status?: TodoItemStatus | string;
  tool_calls_count?: number;
  version?: number;
  completed_at?: string;
  total_rounds?: number;
  total_tool_calls?: number;
  // TodoList evaluation (NEW)
  items_count?: number;
  updates_count?: number;
  reasoning?: string;
  // Sub-session events
  parent_session_id?: string;
  child_session_id?: string;
  title?: string;
  event?: AgentEvent;
  timestamp?: string;
}

export interface ChatRequest {
  message: string;
  session_id?: string;
  system_prompt?: string;
  enhance_prompt?: string;
  workspace_path?: string;
  images?: Array<{
    base64: string;
    name?: string;
    size?: number;
    type?: string;
  }>;
  model: string; // Required
}

export interface ChatResponse {
  session_id: string;
  status: string;
}

export interface ExecuteResponse {
  session_id: string;
  status: "started" | "already_running" | "completed" | "error" | "cancelled";
  events_url: string;
}

export interface HistoryResponse {
  session_id: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    content_parts?: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail?: string } }
    >;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
    tool_call_id?: string;
    created_at: string;
  }>;
}

export type SessionKind = "root" | "child";

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  title: string;
  pinned: boolean;
  parent_session_id?: string | null;
  root_session_id: string;
  spawn_depth: number;
  created_by_schedule_id?: string | null;
  token_usage?: TokenBudgetUsage;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  message_count: number;
  has_attachments: boolean;
  is_running: boolean;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
}

export interface CreateSessionRequest {
  title?: string;
  system_prompt?: string;
  model?: string;
}

export interface CreateSessionResponse {
  session: SessionSummary;
}

export interface PatchSessionRequest {
  title?: string;
  pinned?: boolean;
}

export interface ScheduleRunConfig {
  system_prompt?: string;
  task_message?: string;
  model?: string;
  workspace_path?: string;
  enhance_prompt?: string;
  auto_execute?: boolean;
}

export interface ScheduleEntry {
  id: string;
  name: string;
  enabled: boolean;
  interval_seconds: number;
  created_at: string;
  updated_at: string;
  last_run_at?: string | null;
  next_run_at: string;
  run_config: ScheduleRunConfig;
}

export interface ListSchedulesResponse {
  schedules: ScheduleEntry[];
}

export interface CreateScheduleRequest {
  name: string;
  interval_seconds: number;
  enabled?: boolean;
  run_config?: ScheduleRunConfig;
}

export interface PatchScheduleRequest {
  name?: string;
  enabled?: boolean;
  interval_seconds?: number;
  run_config?: ScheduleRunConfig;
}

export interface ListScheduleSessionsResponse {
  schedule_id: string;
  sessions: SessionSummary[];
}

// Event handlers type
export interface AgentEventHandlers {
  onToken?: (content: string) => void;
  onToolToken?: (toolCallId: string, content: string) => void;
  onToolStart?: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => void;
  onToolComplete?: (toolCallId: string, result: AgentEvent["result"]) => void;
  onToolError?: (toolCallId: string, error: string) => void;
  onTodoListUpdated?: (todoList: TodoList) => void;
  onTodoListItemProgress?: (delta: TodoListDelta) => void;
  onTodoListCompleted?: (
    sessionId: string,
    totalRounds: number,
    totalToolCalls: number,
  ) => void;
  onTodoEvaluationStarted?: (sessionId: string, itemsCount: number) => void;
  onTodoEvaluationCompleted?: (
    sessionId: string,
    updatesCount: number,
    reasoning: string,
  ) => void;
  onTokenBudgetUpdated?: (usage: TokenBudgetUsage) => void;
  onContextSummarized?: (summaryInfo: ContextSummaryInfo) => void;
  onComplete?: (usage: AgentEvent["usage"]) => void;
  onError?: (message: string) => void;
  onSubSessionStarted?: (
    parentSessionId: string,
    childSessionId: string,
    title?: string,
  ) => void;
  onSubSessionEvent?: (
    parentSessionId: string,
    childSessionId: string,
    event: AgentEvent,
  ) => void;
  onSubSessionHeartbeat?: (
    parentSessionId: string,
    childSessionId: string,
    timestamp: string,
  ) => void;
  onSubSessionCompleted?: (
    parentSessionId: string,
    childSessionId: string,
    status: string,
    error?: string,
  ) => void;
}

/**
 * Agent Client - HTTP client for copilot-agent-server
 */
export class AgentClient {
  private static instance: AgentClient;

  static getInstance(): AgentClient {
    if (!AgentClient.instance) {
      AgentClient.instance = new AgentClient();
    }
    return AgentClient.instance;
  }

  /**
   * Send a chat message and get session ID
   */
  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    return agentApiClient.post<ChatResponse>("chat", request);
  }

  /**
   * Execute agent for a session (idempotent)
   * Returns status: started | already_running | completed | error | cancelled
   */
  async execute(sessionId: string, model: string): Promise<ExecuteResponse> {
    return agentApiClient.post<ExecuteResponse>(`execute/${sessionId}`, { model });
  }

  /**
   * List backend sessions (V2 index-backed).
   */
  async listSessions(): Promise<ListSessionsResponse> {
    return agentApiClient.get<ListSessionsResponse>("sessions");
  }

  /**
   * Create a new backend session (root).
   */
  async createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
    return agentApiClient.post<CreateSessionResponse>("sessions", req);
  }

  /**
   * Patch a session (title/pinned).
   */
  async patchSession(sessionId: string, req: PatchSessionRequest): Promise<void> {
    const encodedSessionId = encodeURIComponent(sessionId);
    await agentApiClient.patch(`sessions/${encodedSessionId}`, req);
  }

  /**
   * Clear a session's messages/events (keeps the session).
   */
  async clearSession(sessionId: string): Promise<void> {
    const encodedSessionId = encodeURIComponent(sessionId);
    await agentApiClient.post(`sessions/${encodedSessionId}/clear`);
  }

  /**
   * Cleanup sessions by mode.
   */
  async cleanupSessions(
    mode: "all" | "empty" | "children",
    keepPinned: boolean,
  ): Promise<void> {
    await agentApiClient.post("sessions/cleanup", {
      mode,
      keep_pinned: keepPinned,
    });
  }

  /**
   * Development-only: reset V2 session storage (deletes sessions/ and resets sessions.json index).
   */
  async devResetSessions(): Promise<void> {
    await agentApiClient.post("dev/reset");
  }

  async listSchedules(): Promise<ListSchedulesResponse> {
    return agentApiClient.get<ListSchedulesResponse>("schedules");
  }

  async createSchedule(req: CreateScheduleRequest): Promise<ScheduleEntry> {
    return agentApiClient.post<ScheduleEntry>("schedules", req);
  }

  async patchSchedule(
    scheduleId: string,
    req: PatchScheduleRequest,
  ): Promise<ScheduleEntry> {
    const encoded = encodeURIComponent(scheduleId);
    return agentApiClient.patch<ScheduleEntry>(`schedules/${encoded}`, req);
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    const encoded = encodeURIComponent(scheduleId);
    await agentApiClient.delete(`schedules/${encoded}`);
  }

  async runScheduleNow(scheduleId: string): Promise<void> {
    const encoded = encodeURIComponent(scheduleId);
    await agentApiClient.post(`schedules/${encoded}/run`);
  }

  async listScheduleSessions(
    scheduleId: string,
  ): Promise<ListScheduleSessionsResponse> {
    const encoded = encodeURIComponent(scheduleId);
    return agentApiClient.get<ListScheduleSessionsResponse>(
      `schedules/${encoded}/sessions`,
    );
  }

  /**
   * Subscribe to events only (no execution trigger)
   * Use this for passive observation like TodoList updates
   */
  async subscribeToEvents(
    sessionId: string,
    handlers: AgentEventHandlers,
    abortController?: AbortController,
  ): Promise<void> {
    const signal = abortController?.signal;
    console.log("[AgentClient] Subscribing to events for session:", sessionId);

    try {
      const response = await agentApiClient.fetchRaw(`events/${sessionId}`, {
        signal,
      });

      console.log(
        "[AgentClient] Events subscription response:",
        response.status,
        response.statusText,
        "Content-Type:",
        response.headers.get("content-type"),
      );

      if (!response.ok) {
        // Try to parse error details from response
        let errorMessage = `Failed to subscribe to events: ${response.statusText}`;
        try {
          const body = await response.text();
          if (body) {
            try {
              const errorData = JSON.parse(body);
              errorMessage =
                errorData.error ||
                errorData.message ||
                errorData.detail ||
                errorMessage;
            } catch {
              errorMessage = body || errorMessage;
            }
          }
        } catch (e) {
          console.error("Failed to parse error response:", e);
        }
        throw new Error(errorMessage);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          if (signal?.aborted) {
            break;
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process SSE lines
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);

              // Check for [DONE] marker
              if (data === "[DONE]") {
                return;
              }

              try {
                const event: AgentEvent = JSON.parse(data);
                this.handleEvent(event, handlers);
              } catch (e) {
                console.warn("Failed to parse event:", data, e);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (signal?.aborted) {
        // Normal lifecycle (caller aborted due to navigation, completion, etc.)
        console.debug(
          "[AgentClient] Events subscription aborted for session:",
          sessionId,
        );
        return;
      }
      console.error("[AgentClient] Events subscription error:", error);
      throw error;
    }
  }

  /**
   * Handle a single agent event
   */
  private handleEvent(event: AgentEvent, handlers: AgentEventHandlers): void {
    switch (event.type) {
      case "token":
        handlers.onToken?.(event.content || "");
        break;
      case "tool_token":
        handlers.onToolToken?.(event.tool_call_id || "", event.content || "");
        break;
      case "tool_start":
        handlers.onToolStart?.(
          event.tool_call_id || "",
          event.tool_name || "",
          event.arguments || {},
        );
        break;
      case "tool_complete":
        if (event.result) {
          handlers.onToolComplete?.(event.tool_call_id || "", event.result);
        }
        break;
      case "tool_error":
        handlers.onToolError?.(event.tool_call_id || "", event.error || "");
        break;
      case "todo_list_updated":
        if (event.todo_list) {
          handlers.onTodoListUpdated?.(event.todo_list);
        }
        break;
      case "todo_list_item_progress":
        if (
          event.session_id &&
          event.item_id &&
          event.status &&
          event.tool_calls_count !== undefined &&
          event.version !== undefined
        ) {
          const status = event.status;
          const isTodoStatus =
            status === "pending" ||
            status === "in_progress" ||
            status === "completed" ||
            status === "blocked";
          if (!isTodoStatus) {
            break;
          }
          handlers.onTodoListItemProgress?.({
            session_id: event.session_id,
            item_id: event.item_id,
            status,
            tool_calls_count: event.tool_calls_count,
            version: event.version,
          });
        }
        break;
      case "todo_list_completed":
        if (
          event.session_id &&
          event.total_rounds !== undefined &&
          event.total_tool_calls !== undefined
        ) {
          handlers.onTodoListCompleted?.(
            event.session_id,
            event.total_rounds,
            event.total_tool_calls,
          );
        }
        break;
      case "todo_evaluation_started":
        if (event.session_id && event.items_count !== undefined) {
          handlers.onTodoEvaluationStarted?.(
            event.session_id,
            event.items_count,
          );
        }
        break;
      case "todo_evaluation_completed":
        if (
          event.session_id &&
          event.updates_count !== undefined &&
          event.reasoning
        ) {
          handlers.onTodoEvaluationCompleted?.(
            event.session_id,
            event.updates_count,
            event.reasoning,
          );
        }
        break;
      case "token_budget_updated":
        if (event.usage && "system_tokens" in event.usage) {
          handlers.onTokenBudgetUpdated?.(event.usage);
        }
        break;
      case "context_summarized":
        if (event.summary_info) {
          handlers.onContextSummarized?.(event.summary_info);
        }
        break;
      case "sub_session_started":
        if (event.parent_session_id && event.child_session_id) {
          handlers.onSubSessionStarted?.(
            event.parent_session_id,
            event.child_session_id,
            event.title,
          );
        }
        break;
      case "sub_session_event":
        if (event.parent_session_id && event.child_session_id && event.event) {
          handlers.onSubSessionEvent?.(
            event.parent_session_id,
            event.child_session_id,
            event.event,
          );
        }
        break;
      case "sub_session_heartbeat":
        if (event.parent_session_id && event.child_session_id && event.timestamp) {
          handlers.onSubSessionHeartbeat?.(
            event.parent_session_id,
            event.child_session_id,
            event.timestamp,
          );
        }
        break;
      case "sub_session_completed":
        if (event.parent_session_id && event.child_session_id) {
          handlers.onSubSessionCompleted?.(
            event.parent_session_id,
            event.child_session_id,
            typeof event.status === "string" ? event.status : "completed",
            event.error,
          );
        }
        break;
      case "complete":
        handlers.onComplete?.(event.usage);
        break;
      case "error":
        // Error event uses 'message' field, not 'error' field
        handlers.onError?.(event.message || event.error || "Unknown error");
        break;
      default:
        console.warn("Unknown event type:", event);
    }
  }

  /**
   * Stop generation for a session
   */
  async stopGeneration(sessionId: string): Promise<void> {
    await agentApiClient.post(`stop/${sessionId}`);
  }

  /**
   * Delete a persisted backend session
   */
  async deleteSession(sessionId: string): Promise<void> {
    const encodedSessionId = encodeURIComponent(sessionId);
    await agentApiClient.delete(`sessions/${encodedSessionId}`);
  }

  /**
   * Get chat history
   */
  async getHistory(sessionId: string): Promise<HistoryResponse> {
    return agentApiClient.get<HistoryResponse>(`history/${sessionId}`);
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await agentApiClient.get("health");
      return true;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const agentClient = AgentClient.getInstance();
