import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  Button,
  Card,
  Input,
  Radio,
  Space,
  Typography,
  message,
  theme,
} from "antd";
import { agentApiClient } from "../../services/api";
import { useAppStore } from "../../pages/ChatPage/store";
import { AgentClient } from "../../services/chat/AgentService";
import { useActiveModel } from "../../pages/ChatPage/hooks/useActiveModel";
import styles from "./QuestionDialog.module.css";

const { Text, Title } = Typography;
const { useToken } = theme;

export interface PendingQuestion {
  has_pending_question: boolean;
  question?: string;
  options?: string[];
  allow_custom?: boolean;
  tool_call_id?: string;
}

interface QuestionDialogProps {
  sessionId: string;
  onResponseSubmitted?: () => void;
}

export const QuestionDialog: React.FC<QuestionDialogProps> = ({
  sessionId,
  onResponseSubmitted,
}) => {
  const { token } = useToken();
  const [pendingQuestion, setPendingQuestion] =
    useState<PendingQuestion | null>(null);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [customInput, setCustomInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // NOTE: We intentionally avoid permanently stopping polling. The agent may ask
  // questions later in the session; stopping polling would prevent the dialog
  // from ever appearing.
  const emptyCountRef = useRef(0);

  const setChatProcessing = useAppStore((state) => state.setChatProcessing);
  const selectedModel = useAppStore((state) => state.selectedModel);
  const activeModel = useActiveModel();

  // v2: chatId === sessionId
  const chatId = sessionId;
  const isChatProcessing = useAppStore((state) =>
    chatId ? state.isChatProcessing(chatId) : false,
  );

  // Fetch pending question
  const fetchPendingQuestion = useCallback(async () => {
    try {
      const data = await agentApiClient.get<PendingQuestion>(
        `respond/${sessionId}/pending`,
      );
      if (data.has_pending_question) {
        setPendingQuestion(data);
        emptyCountRef.current = 0;
      } else {
        setPendingQuestion(null);
        emptyCountRef.current += 1;
      }
    } catch (err) {
      // Handle 404 - no pending question for this session
      if (err instanceof Error && err.message.includes("404")) {
        setPendingQuestion(null);
        emptyCountRef.current += 1;
        return;
      }
      console.error("Failed to fetch pending question:", err);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  // Reset polling when session changes
  useEffect(() => {
    emptyCountRef.current = 0;
    setIsLoading(true);
  }, [sessionId]);

  // Poll for pending question periodically
  // When the agent is actively running, poll faster so the dialog shows quickly.
  // Otherwise keep it light.
  const pollInterval =
    pendingQuestion?.has_pending_question || isChatProcessing ? 3000 : 15000;

  useEffect(() => {
    fetchPendingQuestion();

    const interval = setInterval(() => {
      if (!isSubmitting) {
        fetchPendingQuestion();
      }
    }, pollInterval);

    return () => clearInterval(interval);
  }, [fetchPendingQuestion, isSubmitting, pollInterval]);

  // Submit response
  const handleSubmit = async () => {
    const response =
      selectedOption === "custom" ? customInput.trim() : selectedOption;

    if (!response) {
      message.warning("Please select an option or enter a custom answer");
      return;
    }

    setIsSubmitting(true);

    try {
      // Step 1: Submit response to backend
      await agentApiClient.post(`respond/${sessionId}`, { response });

      message.success("Response submitted, AI will continue processing");
      setPendingQuestion(null);
      setSelectedOption(null);
      setCustomInput("");
      emptyCountRef.current = 0;

      // Step 2: Restart agent execution
      try {
        // Prefer the chat-selected model (if any), otherwise fall back to the
        // provider's configured default model.
        const modelToUse = selectedModel?.trim() || activeModel?.trim();
        if (!modelToUse) {
          // Do not guess a model here. The user must explicitly configure one.
          message.error(
            "No model configured. Please select a default model in Provider Settings, then resume the agent.",
          );
        } else {
          const executeResult = await AgentClient.getInstance().execute(
            sessionId,
            modelToUse,
          );
          console.log(
            "[QuestionDialog] Agent execution restarted:",
            executeResult.status,
          );

          // Set processing flag to activate event subscription
          if (["started", "already_running"].includes(executeResult.status)) {
            if (chatId) {
              setChatProcessing(chatId, true);
            }
          }
        }
      } catch (execError) {
        console.error(
          "[QuestionDialog] Failed to restart agent execution:",
          execError,
        );
        // Don't show error to user - response was saved successfully
        // Agent may resume on next interaction
      }

      // Notify parent (optional)
      onResponseSubmitted?.();
    } catch (err) {
      console.error("Failed to submit response:", err);
      message.error(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading || !pendingQuestion?.has_pending_question) {
    return null;
  }

  const { question, options, allow_custom } = pendingQuestion;

  return (
    <Card
      className={styles.questionCard}
      bordered={true}
      style={{
        background: token.colorBgContainer,
        borderColor: token.colorBorderSecondary,
      }}
    >
      <div
        className={styles.questionHeader}
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Title
          level={5}
          className={styles.questionTitle}
          style={{
            color: token.colorPrimary,
          }}
        >
          🤔 AI Needs Your Decision
        </Title>
      </div>

      <div className={styles.questionContent}>
        <Text
          className={styles.questionText}
          style={{
            color: token.colorText,
          }}
        >
          {question}
        </Text>

        <Radio.Group
          className={styles.optionsGroup}
          value={selectedOption}
          onChange={(e) => setSelectedOption(e.target.value)}
        >
          <Space direction="vertical" style={{ width: "100%" }}>
            {options?.map((option, index) => (
              <Radio
                key={index}
                value={option}
                className={styles.optionItem}
                style={{
                  background: token.colorBgContainer,
                  borderColor: token.colorBorderSecondary,
                }}
              >
                <Text style={{ color: token.colorText }}>{option}</Text>
              </Radio>
            ))}

            {allow_custom && (
              <Radio
                value="custom"
                className={styles.optionItem}
                style={{
                  background: token.colorBgContainer,
                  borderColor: token.colorBorderSecondary,
                }}
              >
                <div className={styles.customOption}>
                  <Text style={{ color: token.colorText }}>
                    Other (custom input)
                  </Text>
                  {selectedOption === "custom" && (
                    <Input.TextArea
                      className={styles.customInput}
                      placeholder="Enter your answer..."
                      value={customInput}
                      onChange={(e) => setCustomInput(e.target.value)}
                      rows={2}
                      autoFocus
                    />
                  )}
                </div>
              </Radio>
            )}
          </Space>
        </Radio.Group>
      </div>

      <div
        className={styles.questionFooter}
        style={{
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Button
          type="primary"
          onClick={handleSubmit}
          loading={isSubmitting}
          disabled={
            !selectedOption ||
            (selectedOption === "custom" && !customInput.trim())
          }
        >
          Confirm Selection
        </Button>
      </div>
    </Card>
  );
};

export default QuestionDialog;
