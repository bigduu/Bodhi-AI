import React from "react";
import { Card, Flex, Image, theme, Typography } from "antd";
import { EyeOutlined } from "@ant-design/icons";
import { MessageImage } from "../../types/chat";

const { useToken } = theme;
const { Text } = Typography;

export interface ImageGridProps {
  images: MessageImage[];
  className?: string;
  style?: React.CSSProperties;
  maxHeight?: {
    single?: number;
    multiple?: number;
  };
}

export const ImageGrid: React.FC<ImageGridProps> = ({
  images,
  className,
  style,
  maxHeight = { single: 400, multiple: 200 },
}) => {
  const { token } = useToken();

  if (!images || images.length === 0) {
    return null;
  }

  return (
    <Card
      className={className}
      style={{ marginBottom: token.marginMD, ...style }}
      styles={{ body: { padding: 0 } }}
      variant="borderless"
    >
      <Flex wrap="wrap" gap={token.marginSM} style={{ width: "100%" }}>
        {images.map((image) => (
          <Card
            size="small"
            key={image.id}
            style={{
              flex: images.length === 1 ? "1 1 100%" : "1 1 200px",
              overflow: "hidden",
              position: "relative",
              borderRadius: token.borderRadius,
              border: `1px solid ${token.colorBorderSecondary}`,
              backgroundColor: token.colorBgLayout,
            }}
            styles={{ body: { padding: 0 } }}
          >
            <Image
              src={image.url || image.base64}
              alt={image.name}
              style={{
                width: "100%",
                height: "auto",
                maxHeight:
                  images.length === 1 ? maxHeight.single : maxHeight.multiple,
                objectFit: "cover",
              }}
              preview={{
                mask: (
                  <Flex
                    align="center"
                    justify="center"
                    gap={token.marginXS}
                    style={{
                      color: token.colorTextLightSolid,
                    }}
                  >
                    <EyeOutlined />
                    <Text style={{ color: token.colorTextLightSolid }}>
                      Preview
                    </Text>
                  </Flex>
                ),
              }}
            />
            {/* Image info overlay */}
            <Flex
              vertical
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                background: "linear-gradient(transparent, rgba(0,0,0,0.7))",
                color: token.colorTextLightSolid,
                padding: `${token.paddingXS}px ${token.paddingSM}px`,
                fontSize: token.fontSizeSM,
              }}
            >
              <Text style={{ color: token.colorTextLightSolid }} strong>
                {image.name}
              </Text>
              {image.size && (
                <Text
                  style={{
                    fontSize: token.fontSizeSM * 0.85,
                    opacity: 0.8,
                    color: token.colorTextLightSolid,
                  }}
                >
                  {(image.size / 1024).toFixed(1)} KB
                  {image.width &&
                    image.height &&
                    ` • ${image.width}×${image.height}`}
                </Text>
              )}
            </Flex>
          </Card>
        ))}
      </Flex>
    </Card>
  );
};

export default ImageGrid;
