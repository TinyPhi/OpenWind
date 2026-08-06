import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";

function toWorkflowSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function toSnake(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function toAutoPlural(name: string): string {
  const t = name.trim();
  if (!t) return "";
  if (t.endsWith("s") || t.endsWith("x") || t.endsWith("z")) return t + "es";
  return t + "s";
}

export function CreateWorkflow(): React.ReactElement {
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [plural, setPlural] = useState("");
  const [icon, setIcon] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = name.trim().length > 0 && plural.trim().length > 0;

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!isValid) return;
    setSaving(true);
    setError(null);
    try {
      // Create entity type (same name — 1:1 with workflow)
      const etRes = (await fetchWithAuth(`${API_URL}/entity-types`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          plural: plural.trim(),
          icon: icon.trim() || undefined,
          allowCustomFields: true,
        }),
      })) as { data: { id: string } };
      const entityTypeId = etRes.data.id;

      // Placeholder — no states exist yet, so this can't name a real one.
      // addWorkflowState auto-heals initialState to whichever state is
      // created first; PATCH /workflows/:id lets an admin repoint it later.
      await fetchWithAuth(`${API_URL}/workflows`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          entityTypeId,
          initialState: toSnake(name.trim()) || "new",
        }),
      });

      navigate(`/workflows/${toWorkflowSlug(name.trim())}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create workflow",
      );
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: "560px" }}>
      <div style={{ marginBottom: "28px" }}>
        <button
          className="back-link"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
          onClick={() => navigate("/workflows")}
        >
          ← Workflows
        </button>
        <h2 className="page-title" style={{ marginTop: "8px" }}>
          New Workflow
        </h2>
        <p className="page-subtitle">
          Give it a name — add states, transitions, and fields from the detail
          page.
        </p>
      </div>

      <div className="data-panel" style={{ padding: "32px" }}>
        {error && (
          <div className="alert alert-error" style={{ marginBottom: "20px" }}>
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleCreate(e)}>
          <div className="form-group">
            <label className="form-label">Workflow Name *</label>
            <input
              className="form-input"
              placeholder="e.g. Support Ticket, Leave Request, Bug Report"
              value={name}
              autoFocus
              onChange={(e) => {
                const v = e.target.value;
                setName(v);
                if (!plural || plural === toAutoPlural(name))
                  setPlural(toAutoPlural(v));
              }}
              required
            />
            <span
              style={{
                fontSize: "12px",
                color: "var(--text-muted)",
                marginTop: "6px",
                display: "block",
              }}
            >
              An entity type with this name will be created automatically.
            </span>
          </div>

          <div className="form-row" style={{ marginTop: "20px" }}>
            <div className="form-group">
              <label className="form-label">Plural Label *</label>
              <input
                className="form-input"
                placeholder="e.g. Support Tickets"
                value={plural}
                onChange={(e) => setPlural(e.target.value)}
                required
              />
            </div>
            <div className="form-group" style={{ maxWidth: "120px" }}>
              <label className="form-label">Icon (emoji)</label>
              <input
                className="form-input"
                placeholder="🎫"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                style={{ textAlign: "center", fontSize: "20px" }}
              />
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "12px",
              marginTop: "32px",
              paddingTop: "20px",
              borderTop: "1px solid var(--border-color)",
            }}
          >
            <Button
              type="button"
              variant="secondary"
              onClick={() => navigate("/workflows")}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!isValid || saving}
            >
              {saving ? "Creating…" : "Create Workflow →"}
            </Button>
          </div>
        </form>
      </div>

      <div
        style={{
          marginTop: "16px",
          padding: "16px 20px",
          background: "hsla(250,84%,60%,.06)",
          border: "1px solid hsla(250,84%,60%,.15)",
          borderRadius: "var(--radius-md)",
          fontSize: "13px",
          color: "var(--text-muted)",
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: "var(--text-primary)" }}>
          What happens next?
        </strong>
        <br />
        You'll land on the workflow detail page where you can add states,
        transitions, SLA timers, and manage the fields your records collect.
      </div>
    </div>
  );
}
