import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTitle,
  Button,
} from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";

// Spec R8: presets are UI sugar only, mapping to the platform's real
// entity:ticket:<verb> vocabulary — never a stored boolean/enum tier.
const READ_ONLY_SCOPES = ["entity:ticket:read"];
const READ_WRITE_SCOPES = [
  "entity:ticket:create",
  "entity:ticket:read",
  "entity:ticket:comment",
  "entity:ticket:transition",
  "entity:ticket:subticket",
  "entity:ticket:attach",
];
const ALL_VERBS = READ_WRITE_SCOPES;

type ScopeMode = "read-only" | "read-write" | "custom";

export interface CreateApiKeyModalProps {
  open: boolean;
  onClose: () => void;
  /** Called once the key is created and the user dismisses the "copy it now" screen. */
  onCreated: () => void;
}

export function CreateApiKeyModal({
  open,
  onClose,
  onCreated,
}: CreateApiKeyModalProps): React.ReactElement {
  const [applicationName, setApplicationName] = useState("");
  const [applicationDescription, setApplicationDescription] = useState("");
  const [applicationContactEmail, setApplicationContactEmail] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");
  const [scopeMode, setScopeMode] = useState<ScopeMode>("read-only");
  const [customScopes, setCustomScopes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const scopes =
    scopeMode === "read-only"
      ? READ_ONLY_SCOPES
      : scopeMode === "read-write"
        ? READ_WRITE_SCOPES
        : customScopes;

  const isValid =
    applicationName.trim().length > 0 &&
    applicationContactEmail.trim().length > 0 &&
    oidcClientId.trim().length > 0 &&
    scopes.length > 0;

  function resetForm(): void {
    setApplicationName("");
    setApplicationDescription("");
    setApplicationContactEmail("");
    setOidcClientId("");
    setScopeMode("read-only");
    setCustomScopes([]);
    setError(null);
    setCreatedKey(null);
  }

  function toggleCustomScope(scope: string): void {
    setCustomScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!isValid) return;
    setSaving(true);
    setError(null);
    try {
      const res = (await fetchWithAuth(`${API_URL}/api-keys`, {
        method: "POST",
        body: JSON.stringify({
          name: applicationName.trim(),
          scopes,
          applicationName: applicationName.trim(),
          applicationDescription: applicationDescription.trim() || undefined,
          applicationContactEmail: applicationContactEmail.trim(),
          oidcClientId: oidcClientId.trim(),
        }),
      })) as { data: { key: string } };
      setCreatedKey(res.data.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setSaving(false);
    }
  }

  function handleOpenChange(next: boolean): void {
    if (next) return;
    // Closing after a successful create counts as "done" (refresh the list);
    // closing beforehand is a plain cancel.
    if (createdKey) onCreated();
    else onClose();
    resetForm();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} style={{ maxWidth: 480 }}>
        {createdKey ? (
          <>
            <DialogTitle asChild>
              <h2 className="page-title">Key created</h2>
            </DialogTitle>
            <p className="page-subtitle">
              Copy this key now — it cannot be shown again.
            </p>
            <pre
              style={{
                padding: "12px",
                background: "var(--surface-2, #f3f4f6)",
                borderRadius: "8px",
                wordBreak: "break-all",
                userSelect: "all",
              }}
            >
              {createdKey}
            </pre>
            <Button
              variant="primary"
              style={{ marginTop: "20px" }}
              onClick={() => {
                onCreated();
                resetForm();
              }}
            >
              Done
            </Button>
          </>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
              }}
            >
              <div>
                <DialogTitle asChild>
                  <h2 className="page-title">New API Key</h2>
                </DialogTitle>
                <p className="page-subtitle">
                  Register a third-party application that can access tickets via
                  API.
                </p>
              </div>
              <DialogClose asChild>
                <button
                  type="button"
                  aria-label="Close"
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontSize: 20,
                    lineHeight: 1,
                    color: "var(--text-muted)",
                  }}
                >
                  ×
                </button>
              </DialogClose>
            </div>

            {error && (
              <div className="alert alert-error" style={{ marginTop: "16px" }}>
                {error}
              </div>
            )}

            <form onSubmit={(e) => void handleCreate(e)}>
              <div className="form-group">
                <label className="form-label">Application Name *</label>
                <input
                  className="form-input"
                  placeholder="e.g. Acme Helpdesk Sync"
                  value={applicationName}
                  autoFocus
                  onChange={(e) => setApplicationName(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Description</label>
                <input
                  className="form-input"
                  placeholder="What this integration does"
                  value={applicationDescription}
                  onChange={(e) => setApplicationDescription(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">
                  Application Contact Email *
                </label>
                <input
                  className="form-input"
                  type="email"
                  placeholder="ops@example.com"
                  value={applicationContactEmail}
                  onChange={(e) => setApplicationContactEmail(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">OIDC Client ID *</label>
                <input
                  className="form-input"
                  placeholder="acme-helpdesk-sync-client"
                  value={oidcClientId}
                  onChange={(e) => setOidcClientId(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Permissions *</label>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <Button
                    type="button"
                    variant={
                      scopeMode === "read-only" ? "primary" : "secondary"
                    }
                    onClick={() => setScopeMode("read-only")}
                  >
                    Read-only
                  </Button>
                  <Button
                    type="button"
                    variant={
                      scopeMode === "read-write" ? "primary" : "secondary"
                    }
                    onClick={() => setScopeMode("read-write")}
                  >
                    Read-write
                  </Button>
                  <Button
                    type="button"
                    variant={scopeMode === "custom" ? "primary" : "secondary"}
                    onClick={() => setScopeMode("custom")}
                  >
                    Custom
                  </Button>
                </div>
                {scopeMode === "custom" && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      marginTop: 8,
                    }}
                  >
                    {ALL_VERBS.map((scope) => (
                      <label
                        key={scope}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 13,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={customScopes.includes(scope)}
                          onChange={() => toggleCustomScope(scope)}
                        />
                        {scope}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <Button
                type="submit"
                variant="primary"
                disabled={!isValid || saving}
                style={{ marginTop: "16px" }}
              >
                {saving ? "Creating…" : "Create Key"}
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
