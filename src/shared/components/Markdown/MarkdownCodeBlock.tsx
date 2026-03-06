import React, { useState } from "react";
import { Button, Card, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import LazyMermaidChart from "../MermaidChart/LazyMermaidChart";
import { copyText } from "@shared/utils/clipboard";
import {
  getSyntaxTheme,
  registeredLanguages,
  SyntaxHighlighter,
} from "./markdownSyntax";

interface CodeBlockWithCopyProps {
  language: string;
  codeString: string;
  token: any;
}

const CodeBlockWithCopy: React.FC<CodeBlockWithCopyProps> = ({
  language,
  codeString,
  token,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const handleCopy = async () => {
    try {
      await copyText(codeString);
      message.success("Code copied to clipboard");
    } catch (error) {
      console.error("Copy failed:", error);
      message.error("Copy failed");
    }
  };

  const normalizedLanguage = language.toLowerCase();
  const isSupported = registeredLanguages.includes(normalizedLanguage);

  return (
    <Card
      size="small"
      styles={{ body: { padding: 0 } }}
      style={{
        position: "relative",
        maxWidth: "100%",
        overflow: "auto",
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <SyntaxHighlighter
        style={getSyntaxTheme()}
        language={isSupported ? normalizedLanguage : "text"}
        PreTag="div"
        customStyle={{
          margin: `${token.marginXS}px 0`,
          borderRadius: token.borderRadiusSM,
          fontSize: token.fontSizeSM,
          maxWidth: "100%",
          paddingRight: "50px",
        }}
        showLineNumbers={codeString.split("\n").length > 10}
        wrapLines={true}
        wrapLongLines={true}
      >
        {codeString}
      </SyntaxHighlighter>

      {isHovered && (
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          onClick={handleCopy}
          style={{
            position: "absolute",
            top: token.paddingSM,
            right: token.paddingSM,
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            color: "white",
            border: "none",
            borderRadius: token.borderRadiusSM,
            opacity: 0.8,
            transition: "opacity 0.2s",
            zIndex: 10,
          }}
          onMouseEnter={(e) => {
            const target = e.currentTarget as HTMLElement;
            target.style.opacity = "1";
          }}
          onMouseLeave={(e) => {
            const target = e.currentTarget as HTMLElement;
            target.style.opacity = "0.8";
          }}
        />
      )}
    </Card>
  );
};

export const renderCodeBlock = (
  language: string,
  codeString: string,
  token: any,
  onFixMermaid?: (chart: string) => Promise<void> | void,
) => {
  try {
    if (!codeString || typeof codeString !== "string") {
      console.warn(
        "Invalid codeString provided to renderCodeBlock:",
        codeString,
      );
      return null;
    }

    const normalizedLanguage = language.toLowerCase();

    if (normalizedLanguage === "mermaid") {
      const trimmedChart = codeString.trim();
      if (!trimmedChart) {
        console.warn("Empty Mermaid chart content");
        return null;
      }
      return <LazyMermaidChart chart={trimmedChart} onFix={onFixMermaid} />;
    }

    return (
      <CodeBlockWithCopy
        language={normalizedLanguage}
        codeString={codeString}
        token={token}
      />
    );
  } catch (error) {
    console.warn("Syntax highlighting failed:", error);
    return (
      <Card
        size="small"
        styles={{ body: { padding: 0 } }}
        style={{
          position: "relative",
          margin: `${token.marginXS}px 0`,
        }}
        onMouseEnter={(e) => {
          const copyBtn = e.currentTarget.querySelector(
            ".fallback-copy-btn",
          ) as HTMLElement;
          if (copyBtn) copyBtn.style.display = "block";
        }}
        onMouseLeave={(e) => {
          const copyBtn = e.currentTarget.querySelector(
            ".fallback-copy-btn",
          ) as HTMLElement;
          if (copyBtn) copyBtn.style.display = "none";
        }}
      >
        <pre
          style={{
            backgroundColor: token.colorBgContainer,
            border: `1px solid ${token.colorBorder}`,
            padding: token.padding,
            borderRadius: token.borderRadiusSM,
            overflow: "auto",
            fontSize: token.fontSizeSM,
            paddingRight: "50px",
            margin: 0,
          }}
        >
          <code style={{ color: token.colorText }}>{codeString}</code>
        </pre>
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          className="fallback-copy-btn"
          onClick={async () => {
            try {
              await copyText(codeString);
              message.success("Code copied to clipboard");
            } catch (error) {
              console.error("Copy failed:", error);
              message.error("Copy failed");
            }
          }}
          style={{
            position: "absolute",
            top: token.paddingSM,
            right: token.paddingSM,
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            color: "white",
            border: "none",
            borderRadius: token.borderRadiusSM,
            display: "none",
            zIndex: 10,
          }}
        />
      </Card>
    );
  }
};
