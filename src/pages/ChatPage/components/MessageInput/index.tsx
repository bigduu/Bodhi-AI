import React, { useRef, useMemo } from "react";
import { Flex, message, theme } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { ImageFile } from "../../utils/imageUtils";
import ImagePreviewModal from "../ImagePreviewModal";
import {
  getInputHighlightSegments,
  WorkflowCommandInfo,
  FileReferenceInfo,
} from "../../utils/inputHighlight";
import { ProcessedFile } from "../../utils/fileUtils";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import MessageInputDragOverlay from "./MessageInputDragOverlay";
import MessageInputImageStrip from "./MessageInputImageStrip";
import MessageInputField from "./MessageInputField";
import MessageInputControlsLeft from "./MessageInputControlsLeft";
import MessageInputControlsRight from "./MessageInputControlsRight";
import MessageInputFooter from "./MessageInputFooter";
import { useMessageInputAttachments } from "./useMessageInputAttachments";
import { useMessageInputEffects } from "./useMessageInputEffects";
import { useMessageInputHandlers } from "./useMessageInputHandlers";
// ToolService import removed - no longer needed for tool validation

export interface MessageInputInteractionControls {
  isStreaming: boolean;
  hasMessages: boolean;
  allowRetry?: boolean;
  onRetry?: () => void;
  onCancel?: () => void;
  onHistoryNavigate?: (
    direction: "previous" | "next",
    currentValue: string,
  ) => string | null;
}

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (content: string, images?: ImageFile[]) => void;
  placeholder?: string;
  disabled?: boolean;
  interaction: MessageInputInteractionControls;
  images?: ImageFile[];
  onImagesChange?: (images: ImageFile[]) => void;
  allowImages?: boolean;
  isWorkflowSelectorVisible?: boolean; // Prevent Enter key handling when workflow selector is open
  textAreaRef?: React.RefObject<TextAreaRef>; // Add textAreaRef prop
  statusIndicator?: React.ReactNode;
  validateMessage?: (message: string) => {
    isValid: boolean;
    errorMessage?: string;
  };
  onAttachmentsAdded?: (files: ProcessedFile[]) => void;
  onWorkflowCommandChange?: (info: WorkflowCommandInfo) => void;
  onFileReferenceChange?: (info: FileReferenceInfo) => void;
  onFileReferenceButtonClick?: () => void;
  maxCharCount?: number;
}

export const MessageInput: React.FC<MessageInputProps> = ({
  value,
  onChange,
  onSubmit,
  interaction,
  placeholder = "Send a message...",
  disabled = false,
  images: propImages,
  onImagesChange,
  allowImages = true,
  isWorkflowSelectorVisible = false,
  textAreaRef: externalTextAreaRef, // External ref from parent
  statusIndicator,
  validateMessage,
  onAttachmentsAdded,
  onWorkflowCommandChange,
  onFileReferenceChange,
  onFileReferenceButtonClick,
  maxCharCount = 8000,
}) => {
  const {
    isStreaming,
    hasMessages,
    allowRetry = true,
    onRetry,
    onCancel,
    onHistoryNavigate,
  } = interaction;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const internalTextAreaRef = useRef<TextAreaRef>(null);
  const textAreaRef = externalTextAreaRef || internalTextAreaRef; // Use external ref if provided
  const highlightOverlayRef = useRef<HTMLDivElement>(null);
  const { token } = theme.useToken();
  const [messageApi, contextHolder] = message.useMessage();
  const charCount = value.length;
  const isOverCharLimit = charCount > maxCharCount;
  const isNearCharLimit = !isOverCharLimit && charCount >= maxCharCount * 0.9;

  const {
    images,
    setImages,
    previewModalVisible,
    setPreviewModalVisible,
    previewImageIndex,
    handleImagePreview,
    clearImages,
    isProcessingAttachments,
    isDragOver,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
    handleFileInputChange,
  } = useMessageInputAttachments({
    allowImages,
    onAttachmentsAdded,
    messageApi,
  });

  // Use debounced value only for triggering workflow/file search to avoid excessive API calls
  // But use real-time value for highlighting to prevent input lag
  const debouncedValue = useDebouncedValue(value, 80);

  const highlightSegments = useMemo(
    () => getInputHighlightSegments(value),
    [value],
  );

  const syncOverlayScroll = () => {
    const textArea = textAreaRef.current?.resizableTextArea?.textArea;
    if (!textArea || !highlightOverlayRef.current) return;
    const scrollTop = textArea.scrollTop;
    const scrollLeft = textArea.scrollLeft;
    highlightOverlayRef.current.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
  };

  useMessageInputEffects({
    value,
    debouncedValue,
    onWorkflowCommandChange,
    onFileReferenceChange,
    onImagesChange,
    images,
    propImages,
    setImages,
    syncOverlayScroll,
  });

  // Note: Tool validation logic removed - users no longer input tool commands directly
  // Tools are now called autonomously by LLM based on user intent

  const { handleKeyDown, handleSubmit, handleRetry } = useMessageInputHandlers({
    value,
    images,
    isStreaming,
    disabled,
    isWorkflowSelectorVisible,
    onChange,
    onSubmit,
    onRetry,
    onHistoryNavigate,
    validateMessage,
    isOverCharLimit,
    maxCharCount,
    messageApi,
    clearImages,
    textAreaRef,
  });

  return (
    <>
      {/* Ant Design message context holder */}
      {contextHolder}

      {/* Input Container with Drag & Drop */}
      <div
        style={{
          position: "relative",
          border: isDragOver ? `2px dashed ${token.colorPrimary}` : "none",
          borderRadius: token.borderRadius,
          backgroundColor: isDragOver ? token.colorPrimaryBg : "transparent",
          transition: "all 0.2s ease",
          width: "100%",
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <MessageInputImageStrip
          images={images}
          token={token}
          allowImages={allowImages}
          onPreview={handleImagePreview}
          onClear={clearImages}
        />
        <MessageInputDragOverlay visible={isDragOver} token={token} />

        {/* Input with integrated buttons */}
        <Flex
          align="stretch"
          style={{
            gap: token.marginXS,
            backgroundColor: token.colorBgContainer,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
            padding: `${token.paddingXS}px ${token.paddingSM}px`,
            transition: "border-color 0.2s",
            minHeight: 60,
            flex: 1,
            width: "100%",
          }}
        >
          {/* Left side buttons */}
          <MessageInputControlsLeft
            allowImages={allowImages}
            disabled={disabled}
            isStreaming={isStreaming}
            token={token}
            fileInputRef={fileInputRef}
            onFileInputChange={handleFileInputChange}
            onFileReferenceButtonClick={onFileReferenceButtonClick}
          />

          {/* Text input */}
          <MessageInputField
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            token={token}
            highlightSegments={highlightSegments}
            textAreaRef={textAreaRef}
            highlightOverlayRef={highlightOverlayRef}
            onChange={onChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScrollSync={syncOverlayScroll}
          />

          {/* Right side buttons */}
          <MessageInputControlsRight
            allowRetry={allowRetry}
            hasMessages={hasMessages}
            isStreaming={isStreaming}
            disabled={disabled}
            onRetry={handleRetry}
            onCancel={onCancel}
            onSubmit={handleSubmit}
            value={value}
            images={images}
            isOverCharLimit={isOverCharLimit}
            token={token}
            statusIndicator={statusIndicator}
          />
        </Flex>
      </div>

      <MessageInputFooter
        charCount={charCount}
        maxCharCount={maxCharCount}
        isOverCharLimit={isOverCharLimit}
        isNearCharLimit={isNearCharLimit}
        isProcessingAttachments={isProcessingAttachments}
        token={token}
      />
      {allowImages && (
        <ImagePreviewModal
          visible={previewModalVisible}
          images={images}
          currentIndex={previewImageIndex}
          onClose={() => setPreviewModalVisible(false)}
        />
      )}
    </>
  );
};
