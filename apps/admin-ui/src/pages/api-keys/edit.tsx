import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTitle,
  Button,
} from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import type { ApiKeyRow } from "./status.js";

export interface EditApiKeyModalProps {
  keyRow: ApiKeyRow | null;
  onClose: () => void;
  onSaved: () => void;
}

// ADR-012 Phase A (PR A5, AC7): only these two fields are ever editable —
// name/scopes/oidcClientId stay permanently immutable after creation
// (see update.ts's own comment for the full reasoning). Mirrors
// PATCH /api-keys/:id's UpdateApiKeySchema exactly.
export function EditApiKeyModal({
  keyRow,
  onClose,
  onSaved,
}: EditApiKeyModalProps): React.ReactElement {
  const [applicationDescription, setApplicationDescription] = useState("");
  const [applicationContactEmail, setApplicationContactEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (keyRow) {
      setApplicationDescription(keyRow.applicationDescription ?? "");
      setApplicationContactEmail(keyRow.applicationContactEmail ?? "");
      setError(null);
    }
  }, [keyRow]);

  const isValid = applicationContactEmail.trim().length > 0;

  async function handleSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!keyRow || !isValid) return;
    setSaving(true);
    setError(null);
    try {
      await fetchWithAuth(`${API_URL}/api-keys/${keyRow.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          applicationDescription: applicationDescription.trim() || null,
          applicationContactEmail: applicationContactEmail.trim(),
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={keyRow !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent showCloseButton={false} style={{ maxWidth: 480 }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <div>
            <DialogTitle asChild>
              <h2 className="page-title">Edit {keyRow?.applicationName}</h2>
            </DialogTitle>
            <p className="page-subtitle">
              Only the description and contact email can be changed here —
              permissions and identity are fixed for the life of the key.
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

        <form onSubmit={(e) => void handleSave(e)}>
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
            <label className="form-label">Application Contact Email *</label>
            <input
              className="form-input"
              type="email"
              placeholder="ops@example.com"
              value={applicationContactEmail}
              onChange={(e) => setApplicationContactEmail(e.target.value)}
              required
            />
          </div>

          <Button
            type="submit"
            variant="primary"
            disabled={!isValid || saving}
            style={{ marginTop: "16px" }}
          >
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
