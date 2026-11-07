import React from "react";
import { useTranslation } from "react-i18next";
import { TOKENS } from "@platform/ui";
import { AccessLogsPanel } from "../components/access-logs-panel.js";

export function ThirdPartyAccessLogsPage(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div>
      <div style={{ marginBottom: "24px" }}>
        <h2 className="page-title">{t("logs.thirdPartyTitle")}</h2>
        <p className="page-subtitle">{t("logs.thirdPartySubtitle")}</p>
      </div>

      <div
        className="alert"
        style={{
          marginBottom: "16px",
          background: "hsla(38, 92%, 50%, 0.12)",
          border: "1px solid hsl(38, 92%, 50%)",
          color: TOKENS.textPrimary,
          fontSize: "13px",
          padding: "10px 14px",
          borderRadius: TOKENS.radiusSm,
        }}
      >
        <strong>{t("logs.residualRiskLabel")}</strong>{" "}
        {t("logs.residualRiskBody")}
      </div>

      <AccessLogsPanel />
    </div>
  );
}
