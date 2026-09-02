import React, { useState } from "react";
import { Button } from "@platform/ui";
import { ApiKeys } from "./index.js";
import { ThirdPartyAccessLogsPage } from "../third-party-access-logs.js";

type ApiKeysView = "keys" | "logs";

/**
 * Top-level /admin/api-keys page — an internal switchable view between the
 * API Keys card grid and the (unfiltered) API Access Logs, so both live
 * under one sidebar entry instead of two. The standalone
 * /admin/third-party-access-logs route + sidebar entry stay in place
 * alongside this — this is an additional way to reach the same page, not a
 * replacement for it.
 */
export function ApiKeysPage(): React.ReactElement {
  const [view, setView] = useState<ApiKeysView>("keys");

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <Button
          type="button"
          variant={view === "keys" ? "primary" : "secondary"}
          onClick={() => setView("keys")}
        >
          API Keys
        </Button>
        <Button
          type="button"
          variant={view === "logs" ? "primary" : "secondary"}
          onClick={() => setView("logs")}
        >
          API Access Logs
        </Button>
      </div>

      {view === "keys" ? <ApiKeys /> : <ThirdPartyAccessLogsPage />}
    </div>
  );
}
