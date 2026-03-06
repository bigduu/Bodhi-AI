import React, { useState, useEffect } from "react";
import { Modal, Button, Typography, Space } from "antd";
import { LogoutOutlined, CheckOutlined } from "@ant-design/icons";

const { Title, Paragraph, Text } = Typography;

interface StartupConfirmationProps {
  onConfirm: () => void;
  onDecline: () => void;
}

/**
 * Startup confirmation dialog for internal builds
 * Asks user to acknowledge usage terms before entering the application
 */
export const StartupConfirmation: React.FC<StartupConfirmationProps> = ({
  onConfirm,
  onDecline,
}) => {
  const [visible, setVisible] = useState(true);

  const handleConfirm = () => {
    setVisible(false);
    // Remember user's choice for this session
    sessionStorage.setItem("startup_confirmed", "true");
    onConfirm();
  };

  const handleDecline = () => {
    Modal.confirm({
      title: "Exit Application?",
      content: "Are you sure you want to exit? The application will close.",
      okText: "Yes, Exit",
      cancelText: "Cancel",
      okType: "danger",
      onOk: () => {
        setVisible(false);
        onDecline();
      },
    });
  };

  return (
    <Modal
      open={visible}
      closable={false}
      maskClosable={false}
      keyboard={false}
      footer={null}
      width={600}
      centered
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <div style={{ textAlign: "center" }}>
          <Title level={3} style={{ marginBottom: 8 }}>
            Welcome to Bodhi
          </Title>
          <Text type="secondary">Internal Development Build</Text>
        </div>

        <div>
          <Paragraph>
            <Text strong>Before you continue, please acknowledge the following:</Text>
          </Paragraph>

          <div
            style={{
              background: "var(--ant-color-bg-text-hover)",
              padding: "16px",
              borderRadius: "8px",
              marginBottom: "16px",
            }}
          >
            <Space direction="vertical" size="small" style={{ width: "100%" }}>
              <Paragraph style={{ marginBottom: 8 }}>
                • This is an <Text strong>internal development build</Text> of Bodhi
              </Paragraph>
              <Paragraph style={{ marginBottom: 8 }}>
                • This software is for <Text strong>development and testing purposes only</Text>
              </Paragraph>
              <Paragraph style={{ marginBottom: 8 }}>
                • Features may be experimental, unstable, or change without notice
              </Paragraph>
              <Paragraph style={{ marginBottom: 8 }}>
                • <Text strong>Not intended for production use</Text> or public distribution
              </Paragraph>
              <Paragraph style={{ marginBottom: 0 }}>
                • By continuing, you agree to use this software in accordance with your
                organization's policies
              </Paragraph>
            </Space>
          </div>

          <Paragraph type="secondary" style={{ fontSize: "12px", marginBottom: 0 }}>
            This confirmation dialog only appears in internal development builds.
            Public release builds (Bamboo) will not show this message.
          </Paragraph>
        </div>

        <div style={{ display: "flex", justifyContent: "center", gap: "12px" }}>
          <Button
            size="large"
            icon={<LogoutOutlined />}
            onClick={handleDecline}
            danger
          >
            Decline and Exit
          </Button>
          <Button
            size="large"
            type="primary"
            icon={<CheckOutlined />}
            onClick={handleConfirm}
          >
            Accept and Continue
          </Button>
        </div>
      </Space>
    </Modal>
  );
};

/**
 * Hook to manage startup confirmation state
 * Only shows confirmation for internal builds
 */
export const useStartupConfirmation = (isInternal: boolean) => {
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    // Only show for internal builds
    if (!isInternal) {
      setConfirmed(true);
      return;
    }

    // Check if already confirmed in this session
    const sessionConfirmed = sessionStorage.getItem("startup_confirmed");
    if (sessionConfirmed === "true") {
      setConfirmed(true);
      return;
    }

    // Show confirmation dialog
    setShowConfirmation(true);
  }, [isInternal]);

  const handleConfirm = () => {
    setShowConfirmation(false);
    setConfirmed(true);
  };

  const handleDecline = () => {
    setShowConfirmation(false);
    if (typeof window !== "undefined") {
      window.close();
    }
  };

  return {
    showConfirmation,
    confirmed,
    handleConfirm,
    handleDecline,
  };
};
