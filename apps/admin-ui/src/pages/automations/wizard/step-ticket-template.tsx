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

type LoadState = "loading" | "ready" | "failed";

function useOptions<T>(path: string | null): { items: T[]; state: LoadState } {
  const [items, setItems] = useState<T[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setState("loading");
    fetchWithAuth(`${API_URL}${path}`).then(
      (res) => {
        if (cancelled) return;
        // Every list route answers with the { data: T[] } envelope.
        setItems((res as { data: T[] }).data);
        setState("ready");
      },
      () => {
        if (cancelled) return;
        setItems([]);
        setState("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path]);
  return { items, state };
}

function placeholder(state: LoadState, ready: string): string {
  return state === "loading" ? "Loading…" : ready;
}

function LoadFailed({ what }: { what: string }): React.ReactElement {
  return (
    <p
      role="alert"
      style={{ fontSize: "12px", color: "var(--danger)", margin: "4px 0 0" }}
    >
      Couldn&apos;t load the {what}. Refresh the page to try again.
    </p>
  );
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
  const { items: workflows, state: workflowsState } =
    useOptions<WorkflowOption>(
      type === "create_entity" ? "/workflows?activeOnly=true" : null,
    );
  const { items: teams, state: teamsState } =
    useOptions<TeamOption>("/admin/teams");
  const { users, loading: usersLoading, error: usersError } = useUsers();

  const template = templateOf(config);
  // A chosen team or person decides the picker, so a rule loaded after mount shows the right
  // one; the picked mode only matters while nobody is chosen yet.
  const [pickedMode, setPickedMode] = useState<AssignMode>("owner");
  const mode: AssignMode = template.teamId
    ? "team"
    : template.assignedTo
      ? "user"
      : pickedMode;
  const problem = ticketActionProblem(type, config);
  const entityTypeId =
    typeof config.entityTypeId === "string" ? config.entityTypeId : "";
  const workflowId =
    workflows.find((w) => w.entityTypeId === entityTypeId)?.id ?? "";

  function patchTemplate(next: TicketTemplate): void {
    onChange({ template: { ...template, ...next } });
  }

  function switchMode(next: AssignMode): void {
    setPickedMode(next);
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
            <option value="">
              {placeholder(workflowsState, "Select a workflow…")}
            </option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {workflowsState === "failed" && <LoadFailed what="workflows" />}
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
          <option value="owner">
            Workflow owner, else an admin (automatic)
          </option>
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
            <option value="">
              {placeholder(
                usersLoading ? "loading" : "ready",
                "Select a person…",
              )}
            </option>
            {users.map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.displayName ?? u.email}
              </option>
            ))}
          </select>
        )}
        {mode === "user" && usersError && <LoadFailed what="people" />}
        {mode === "team" && (
          <select
            aria-label="Team"
            className="form-input"
            style={{ marginTop: "6px" }}
            value={template.teamId ?? ""}
            onChange={(e) => patchTemplate({ teamId: e.target.value })}
          >
            <option value="">
              {placeholder(teamsState, "Select a team…")}
            </option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        {mode === "team" && teamsState === "failed" && (
          <LoadFailed what="teams" />
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
