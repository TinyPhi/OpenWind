import React from "react";
import { TOKENS } from "@platform/ui";
import { AccessLogsPanel } from "../components/access-logs-panel.js";

export function ThirdPartyAccessLogsPage(): React.ReactElement {
  return (
    <div>
      <div style={{ marginBottom: "24px" }}>
        <h2 className="page-title">Third-Party API Access Logs</h2>
        <p className="page-subtitle">
          Every third-party application request/attempt against a ticket —
          application, acting person, action, allowed vs. denied. The primary
          place to investigate a connected application's behavior, separate from
          the ticket timeline itself.
        </p>
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
        <strong>Known residual risk:</strong> the volume-spike misuse alert is
        threshold-based, not behavioral — sustained abuse that stays just under
        the threshold will not trigger a proactive alert. This log remains the
        way to manually spot that pattern.
      </div>

      <AccessLogsPanel />
    </div>
  );
}
