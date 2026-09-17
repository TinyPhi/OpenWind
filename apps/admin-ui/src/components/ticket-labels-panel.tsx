import React, { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { showAlert } from "./global-alert-dialog.js";

export interface TicketLabel {
  labelId: string;
  name: string;
  color: string;
  description: string | null;
}

interface AvailableLabel {
  id: string;
  name: string;
  color: string;
}

/**
 * Assigned-label chips + an "add label" picker for a single ticket —
 * docs/specs/oncall-routing.md T20/T38. Labels are a many-to-many
 * relationship independent of the ticket's own field values, so this is
 * managed on its own (like attachments) rather than folded into the
 * edit-mode field grid.
 */
export function TicketLabelsPanel({
  ticketId,
}: {
  ticketId: string;
}): React.ReactElement {
  const [assigned, setAssigned] = useState<TicketLabel[]>([]);
  const [available, setAvailable] = useState<AvailableLabel[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const requestIdRef = useRef(0);
  const pickerRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback((): void => {
    const requestId = ++requestIdRef.current;
    fetchWithAuth(`${API_URL}/entities/${ticketId}/labels`)
      .then((res) => {
        if (requestId !== requestIdRef.current) return;
        setAssigned((res as { data: TicketLabel[] }).data);
      })
      .catch(() => showAlert("Failed to load labels."));
  }, [ticketId]);

  useEffect(() => {
    refresh();
    const requestId = requestIdRef.current;
    fetchWithAuth(`${API_URL}/admin/labels`)
      .then((res) => {
        if (requestId !== requestIdRef.current) return;
        setAvailable((res as { data: AvailableLabel[] }).data);
      })
      .catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent): void {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  async function assign(labelId: string): Promise<void> {
    try {
      await fetchWithAuth(`${API_URL}/entities/${ticketId}/labels`, {
        method: "POST",
        body: JSON.stringify({ labelId }),
      });
      setPickerOpen(false);
      refresh();
    } catch {
      showAlert("Failed to assign label.");
    }
  }

  async function unassign(labelId: string): Promise<void> {
    try {
      await fetchWithAuth(`${API_URL}/entities/${ticketId}/labels/${labelId}`, {
        method: "DELETE",
      });
      refresh();
    } catch {
      showAlert("Failed to remove label.");
    }
  }

  const assignedIds = new Set(assigned.map((l) => l.labelId));
  const pickable = available.filter((a) => !assignedIds.has(a.id));

  return (
    <div className="rcd-expand-attachments">
      <div className="rcd-expand-attachments-hdr">
        <span className="rcd-expand-attachments-title">
          Labels
          {assigned.length > 0 && (
            <span className="rcd-sidebar-count">{assigned.length}</span>
          )}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "6px",
          alignItems: "center",
          marginTop: "8px",
        }}
      >
        {assigned.map((label) => (
          <span
            key={label.labelId}
            title={label.description ?? undefined}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "3px 8px",
              borderRadius: "999px",
              fontSize: "12px",
              fontWeight: 500,
              background: label.color,
              color: "#fff",
            }}
          >
            {label.name}
            <span
              role="button"
              aria-label={`Remove ${label.name}`}
              onClick={() => void unassign(label.labelId)}
              style={{ cursor: "pointer", lineHeight: 1 }}
            >
              ×
            </span>
          </span>
        ))}

        <div ref={pickerRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="portal-btn-secondary"
            style={{ padding: "3px 10px", fontSize: "12px" }}
            onClick={() => setPickerOpen((o) => !o)}
          >
            + Add label
          </button>
          {pickerOpen && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                zIndex: 50,
                minWidth: "180px",
                background: "var(--bg-primary)",
                border: "1.5px solid var(--border-primary)",
                borderRadius: "var(--radius-sm)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                maxHeight: "220px",
                overflowY: "auto",
              }}
            >
              {pickable.length === 0 ? (
                <div
                  style={{
                    padding: "10px 12px",
                    fontSize: "12px",
                    color: "var(--text-tertiary)",
                  }}
                >
                  No more labels to add
                </div>
              ) : (
                pickable.map((label) => (
                  <div
                    key={label.id}
                    onClick={() => void assign(label.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "8px 12px",
                      cursor: "pointer",
                      fontSize: "13px",
                    }}
                  >
                    <span
                      style={{
                        width: "10px",
                        height: "10px",
                        borderRadius: "50%",
                        background: label.color,
                        flexShrink: 0,
                      }}
                    />
                    {label.name}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
