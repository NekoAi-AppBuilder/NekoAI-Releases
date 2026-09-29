import React from "react";

export interface RuntimePermissionCardProps {
  cardData: {
    requestId: string;
    runtimeId: string;
    technology: string;
    version: string;
    reason: string;
    officialOrigin: string;
    downloadUrl: string;
    expectedSizeBytes?: number;
    expectedSha256: string;
    platform: string;
    architecture: string;
  };
  onApprove: (cardData: any) => void;
  onDeny: (cardData: any) => void;
  isProcessing?: boolean;
}

export const RuntimePermissionCard: React.FC<RuntimePermissionCardProps> = ({
  cardData,
  onApprove,
  onDeny,
  isProcessing = false,
}) => {
  const sizeMb = cardData.expectedSizeBytes
    ? (cardData.expectedSizeBytes / (1024 * 1024)).toFixed(1) + " MB"
    : "Desconhecido";

  return (
    <div
      className="runtime-permission-card"
      style={{
        border: "1px solid rgba(255, 255, 255, 0.15)",
        borderRadius: "8px",
        padding: "16px",
        backgroundColor: "rgba(30, 30, 35, 0.95)",
        color: "#ffffff",
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: "500px",
        margin: "12px 0",
        boxShadow: "0 4px 14px rgba(0, 0, 0, 0.35)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" }}>
        <div
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "8px",
            backgroundColor: "#2563eb",
            color: "#ffffff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: "bold",
            fontSize: "14px",
            boxShadow: "0 2px 6px rgba(37, 99, 235, 0.4)",
          }}
        >
          {cardData.technology.slice(0, 2).toUpperCase()}
        </div>
        <div>
          <h4 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "#f3f4f6" }}>
            {cardData.technology} <span style={{ color: "#60a5fa" }}>v{cardData.version}</span>
          </h4>
          <span style={{ fontSize: "12px", color: "#9ca3af" }}>Instalação de Runtime Necessária</span>
        </div>
      </div>

      <p style={{ fontSize: "13px", color: "#d1d5db", margin: "8px 0 12px 0", lineHeight: "1.4" }}>
        {cardData.reason}
      </p>

      <div
        style={{
          fontSize: "12px",
          color: "#9ca3af",
          backgroundColor: "rgba(0, 0, 0, 0.3)",
          padding: "10px 12px",
          borderRadius: "6px",
          marginBottom: "14px",
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          border: "1px solid rgba(255, 255, 255, 0.05)",
        }}
      >
        <div>
          <strong style={{ color: "#e5e7eb" }}>Origem Oficial:</strong> {cardData.officialOrigin}
        </div>
        <div>
          <strong style={{ color: "#e5e7eb" }}>Tamanho Estimado:</strong> {sizeMb}
        </div>
        <div>
          <strong style={{ color: "#e5e7eb" }}>Plataforma Alvo:</strong> {cardData.platform} ({cardData.architecture})
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
        <button
          onClick={() => onDeny(cardData)}
          disabled={isProcessing}
          style={{
            padding: "7px 16px",
            borderRadius: "6px",
            border: "1px solid rgba(255, 255, 255, 0.2)",
            backgroundColor: "transparent",
            color: "#e5e7eb",
            cursor: isProcessing ? "not-allowed" : "pointer",
            fontSize: "13px",
            fontWeight: 500,
            transition: "all 0.2s",
          }}
        >
          Cancelar
        </button>
        <button
          onClick={() => onApprove(cardData)}
          disabled={isProcessing}
          style={{
            padding: "7px 16px",
            borderRadius: "6px",
            border: "none",
            backgroundColor: "#2563eb",
            color: "#ffffff",
            fontWeight: 600,
            cursor: isProcessing ? "not-allowed" : "pointer",
            fontSize: "13px",
            boxShadow: "0 2px 8px rgba(37, 99, 235, 0.4)",
            transition: "all 0.2s",
          }}
        >
          {isProcessing ? "Instalando..." : "Instalar Runtime"}
        </button>
      </div>
    </div>
  );
};
