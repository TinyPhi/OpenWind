import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Button,
  IconButton,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { ConfirmDeleteDialog } from "../../components/confirm-delete-dialog.js";

type AutomationRule = {
  id: string;
  name: string;
  triggerType: string;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
  isEnabled: boolean;
  priority: number;
  createdAt: string;
};

const TRIGGER_LABELS: Record<string, string> = {
  "workflow.entered_state": "State entered",
  "workflow.transitioned": "Transitioned",
  "workflow.sla_breached": "SLA breached",
  "field.changed": "Field changed",
  "entity.created": "Record created",
  "entity.assigned": "Record assigned",
  "schedule.cron": "Scheduled",
  "connector.event": "Connector event",
};

const TRIGGER_COLORS: Record<string, string> = {
  "workflow.entered_state": "#6366f1",
  "workflow.transitioned": "#8b5cf6",
  "workflow.sla_breached": "#ef4444",
  "field.changed": "#f59e0b",
  "entity.created": "#10b981",
  "entity.assigned": "#3b82f6",
  "schedule.cron": "#6b7280",
  "connector.event": "#ec4899",
};

export function Automations(): React.ReactElement {
  const navigate = useNavigate();
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AutomationRule | null>(
    null,
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback((): void => {
    setLoading(true);
    setError(null);
    fetchWithAuth(`${API_URL}/automation-rules`)
      .then((res) => {
        setRules((res as { data: AutomationRule[] }).data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load rules");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggle(rule: AutomationRule): Promise<void> {
    setTogglingId(rule.id);
    try {
      await fetchWithAuth(`${API_URL}/automation-rules/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isEnabled: !rule.isEnabled }),
      });
      setRules((prev) =>
        prev.map((r) =>
          r.id === rule.id ? { ...r, isEnabled: !r.isEnabled } : r,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update rule");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(rule: AutomationRule): Promise<void> {
    setDeletingId(rule.id);
    try {
      await fetchWithAuth(`${API_URL}/automation-rules/${rule.id}`, {
        method: "DELETE",
      });
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      setConfirmDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete rule");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div style={{ padding: "32px 36px", maxWidth: "1100px" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "28px",
        }}
      >
        <div>
          <h2 className="page-title">Automation Rules</h2>
          <p className="page-subtitle">
            Trigger actions automatically based on workflow events.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => void navigate("/automations/new")}
        >
          + New Rule
        </Button>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginBottom: "16px" }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="loading-center">
          <div className="spinner" />
          <p className="loader-text">Loading rules…</p>
        </div>
      ) : rules.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">⚡</div>
          <p style={{ fontWeight: 600, marginBottom: "4px" }}>
            No automation rules yet
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: "13px" }}>
            Create a rule to trigger actions when workflow events occur.
          </p>
          <Button
            variant="primary"
            style={{ marginTop: "16px" }}
            onClick={() => void navigate("/automations/new")}
          >
            + New Rule
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Actions</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => {
              const triggerColor =
                TRIGGER_COLORS[rule.triggerType] ?? "var(--accent-primary)";
              return (
                <TableRow key={rule.id}>
                  <TableCell>
                    <Link
                      to={`/automations/${rule.id}/edit`}
                      style={{
                        fontWeight: 600,
                        color: "var(--text-primary)",
                        textDecoration: "none",
                      }}
                    >
                      {rule.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span
                      className="badge"
                      style={{
                        background: `${triggerColor}22`,
                        color: triggerColor,
                        border: `1px solid ${triggerColor}44`,
                        fontSize: "11px",
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: "20px",
                      }}
                    >
                      {TRIGGER_LABELS[rule.triggerType] ?? rule.triggerType}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      style={{ color: "var(--text-muted)", fontSize: "13px" }}
                    >
                      {rule.actions.length}{" "}
                      {rule.actions.length === 1 ? "action" : "actions"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: "13px",
                      }}
                    >
                      {rule.priority}
                    </span>
                  </TableCell>
                  <TableCell>
                    <button
                      className={`form-checkbox ${rule.isEnabled ? "checked" : ""}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        background: "none",
                        border: "none",
                        cursor: togglingId === rule.id ? "wait" : "pointer",
                        padding: "2px 0",
                        color: rule.isEnabled
                          ? "var(--success)"
                          : "var(--text-muted)",
                        fontWeight: 600,
                        fontSize: "12px",
                        opacity: togglingId === rule.id ? 0.5 : 1,
                      }}
                      disabled={togglingId === rule.id}
                      onClick={() => void handleToggle(rule)}
                      title={rule.isEnabled ? "Disable rule" : "Enable rule"}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          width: "28px",
                          height: "16px",
                          borderRadius: "8px",
                          background: rule.isEnabled
                            ? "var(--success)"
                            : "var(--border-color)",
                          position: "relative",
                          transition: "background 0.2s",
                          flexShrink: 0,
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            width: "12px",
                            height: "12px",
                            borderRadius: "50%",
                            background: "#fff",
                            position: "absolute",
                            top: "2px",
                            left: rule.isEnabled ? "14px" : "2px",
                            transition: "left 0.2s",
                          }}
                        />
                      </span>
                      {rule.isEnabled ? "On" : "Off"}
                    </button>
                  </TableCell>
                  <TableCell>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <IconButton
                        variant="edit"
                        title="Edit rule"
                        onClick={() =>
                          void navigate(`/automations/${rule.id}/edit`)
                        }
                      >
                        ✏
                      </IconButton>
                      <IconButton
                        variant="delete"
                        title="Delete rule"
                        onClick={() => setConfirmDelete(rule)}
                      >
                        🗑
                      </IconButton>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {/* Delete confirm modal */}
      <ConfirmDeleteDialog
        open={confirmDelete !== null}
        title={
          confirmDelete
            ? `Delete "${confirmDelete.name}"?`
            : "Delete this item?"
        }
        message=""
        busy={!!deletingId}
        onConfirm={() => confirmDelete && void handleDelete(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
