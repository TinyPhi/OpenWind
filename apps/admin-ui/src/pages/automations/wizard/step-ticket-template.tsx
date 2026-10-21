import React, { useEffect, useState } from "react";
import { fetchWithAuth, API_URL } from "../../../lib/api.js";
import { useUsers } from "../../../lib/use-users.js";
import {
  MAX_DUE_DAYS,
  TICKET_SEVERITIES,
  templateOf,
  ticketActionProblem,
} from "./ticket-template.js";
import type { TicketSeverity, TicketTemplate } from "./ticket-template.js";

type WorkflowOption = { id: string; name: string; entityTypeId: string };
type TeamOption = { id: string; name: string };
type AssignMode = "owner" | "user" | "team";

function useOptions<T>(path: string | null): T[] {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    fetchWithAuth(`${API_URL}${path}`).then(
      (res) => {
        // Every list route answers with the { data: T[] } envelope.
        if (!cancelled) setItems((res as { data: T[] }).data);
      },
      () => {
        if (!cancelled) setItems([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path]);
  return items;
}

/**
 * The ticket template of a "Create ticket" / "Create sub-task" action
 * (docs/specs/mandatory-ticket-fields.md R7).
 */
export function TicketTemplateConfig({
  type,
  config,
  onChange,
}: {
  type: "create_entity" | "create_child";
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  const workflows = useOptions<WorkflowOption>(
    type === "create_entity" ? "/workflows?activeOnly=true" : null,
  );
  const teams = useOptions<TeamOption>("/admin/teams");
  const { users } = useUsers();

  const template = templateOf(config);
  const [mode, setMode] = useState<AssignMode>(
    template.teamId ? "team" : template.assignedTo ? "user" : "owner",
  );
  const problem = ticketActionProblem(type, config);
  const entityTypeId =
    typeof config.entityTypeId === "string" ? config.entityTypeId : "";
  const workflowId =
    workflows.find((w) => w.entityTypeId === entityTypeId)?.id ?? "";

  function patchTemplate(next: TicketTemplate): void {
    onChange({ template: { ...template, ...next } });
  }

  function switchMode(next: AssignMode): void {
    setMode(next);
    const { assignedTo: _a, teamId: _t, ...rest } = template;
    onChange({ template: rest });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {type === "create_entity" && (
        <div className="form-group">
          <label className="form-label" htmlFor="ticket-action-workflow">
            Workflow
          </label>
          <select
            id="ticket-action-workflow"
            className="form-input"
            value={workflowId}
            onChange={(e) => {
              const wf = workflows.find((w) => w.id === e.target.value);
              onChange({ entityTypeId: wf?.entityTypeId ?? "" });
            }}
          >
            <option value="">Select a workflow…</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="form-group">
        <label className="form-label" htmlFor="ticket-action-title">
          Title
        </label>
        <input
          id="ticket-action-title"
          className="form-input"
          value={template.title ?? ""}
          placeholder={
            type === "create_entity"
              ? "The rule's name"
              : "<rule name>: <parent ticket title>"
          }
          onChange={(e) => patchTemplate({ title: e.target.value })}
        />
      </div>
      <div style={{ display: "flex", gap: "10px" }}>
        <div className="form-group" style={{ flex: 1 }}>
          <label className="form-label" htmlFor="ticket-action-due">
            Due in (days)
          </label>
          <input
            id="ticket-action-due"
            className="form-input"
            type="number"
            min={0}
            max={MAX_DUE_DAYS}
            step={1}
            value={template.due_days ?? ""}
            onChange={(e) =>
              patchTemplate({
                due_days:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
          />
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label className="form-label" htmlFor="ticket-action-severity">
            Severity
          </label>
          <select
            id="ticket-action-severity"
            className="form-input"
            value={template.severity ?? ""}
            onChange={(e) =>
              patchTemplate({
                // Options are TICKET_SEVERITIES plus "", which clears it.
                severity: (e.target.value || undefined) as
                  | TicketSeverity
                  | undefined,
              })
            }
          >
            <option value="">Select…</option>
            {TICKET_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="ticket-action-remark">
          Remark
        </label>
        <textarea
          id="ticket-action-remark"
          className="form-input"
          rows={2}
          value={template.remark ?? ""}
          placeholder="Created by automation: <rule name>"
          onChange={(e) => patchTemplate({ remark: e.target.value })}
        />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="ticket-action-assign">
          Assign to
        </label>
        <select
          id="ticket-action-assign"
          className="form-input"
          value={mode}
          // Options are exactly the three AssignMode values.
          onChange={(e) => switchMode(e.target.value as AssignMode)}
        >
          <option value="owner">Workflow owner (automatic)</option>
          <option value="user">A person</option>
          <option value="team">A team (its on-call person)</option>
        </select>
        {mode === "user" && (
          <select
            aria-label="Person"
            className="form-input"
            style={{ marginTop: "6px" }}
            value={template.assignedTo ?? ""}
            onChange={(e) => patchTemplate({ assignedTo: e.target.value })}
          >
            <option value="">Select a person…</option>
            {users.map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.displayName ?? u.email}
              </option>
            ))}
          </select>
        )}
        {mode === "team" && (
          <select
            aria-label="Team"
            className="form-input"
            style={{ marginTop: "6px" }}
            value={template.teamId ?? ""}
            onChange={(e) => patchTemplate({ teamId: e.target.value })}
          >
            <option value="">Select a team…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {problem && (
        <p
          role="status"
          style={{ fontSize: "12px", color: "var(--text-muted)", margin: 0 }}
        >
          {problem}
        </p>
      )}
    </div>
  );
}
