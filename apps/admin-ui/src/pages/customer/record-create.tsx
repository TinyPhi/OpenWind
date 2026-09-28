import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { FieldInput } from "../../components/field-input.js";
import { useEntityTypes } from "../../entity-type-context.js";
import { useFileUpload } from "../../hooks/use-file-upload.js";
import {
  AttachmentUploadZone,
  StagedFileChip,
} from "../../components/file-attachment.js";
import { TOKENS, useHoverStyle } from "@platform/ui";
import {
  SeverityDropdown,
  DEFAULT_SEVERITY,
  type Severity,
} from "../../components/severity-tag.js";

type UserOption = {
  userId: string;
  displayName: string;
  loginName: string;
  email?: string;
};

// docs/specs/team-assign-oncall-fallback.md R1/§I.
type TeamOption = {
  id: string;
  name: string;
};

// Derives a singular display label from the entity type's plural (e.g.
// "NSI Amendment Requests" -> "NSI Amendment Request") rather than falling
// back to entityType.name, which for several entity types is a raw
// snake_case/lowercase identifier (e.g. "nsi_amendment_request", "ticket")
// never meant for display.
function singularize(plural: string): string {
  if (/[a-z]ies$/.test(plural)) return plural.replace(/ies$/, "y");
  if (/s$/i.test(plural)) return plural.replace(/s$/i, "");
  return plural;
}

// Shared by UserPicker and TeamPicker below — both are click-outside-to-close
// dropdowns; extracted so the same outside-click wiring isn't duplicated
// per component (/review finding, 2026-09-21).
function useOutsideClick(
  ref: React.RefObject<HTMLElement>,
  onOutside: () => void,
): void {
  useEffect(() => {
    function onClickOutside(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutside();
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [ref, onOutside]);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function UnassignedRow({
  onSelect,
}: {
  onSelect: () => void;
}): React.ReactElement {
  const rowHover = useHoverStyle({
    base: { background: "" },
    hover: { background: TOKENS.bgSecondary },
  });

  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "9px 12px",
        cursor: "pointer",
        color: "var(--text-tertiary)",
        fontSize: "13px",
        borderBottom: "1px solid var(--border-primary)",
        ...rowHover.style,
      }}
      onMouseEnter={rowHover.onMouseEnter}
      onMouseLeave={rowHover.onMouseLeave}
    >
      Unassigned
    </div>
  );
}

function UserOptionRow({
  user,
  isSelected,
  onSelect,
}: {
  user: UserOption;
  isSelected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const rowHover = useHoverStyle({
    base: { background: isSelected ? TOKENS.bgSecondary : "" },
    hover: { background: TOKENS.bgSecondary },
  });

  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "9px 12px",
        cursor: "pointer",
        ...rowHover.style,
      }}
      onMouseEnter={rowHover.onMouseEnter}
      onMouseLeave={rowHover.onMouseLeave}
    >
      <span
        style={{
          width: "30px",
          height: "30px",
          borderRadius: "50%",
          background: "var(--accent-primary)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "11px",
          fontWeight: 600,
          flexShrink: 0,
          opacity: isSelected ? 1 : 0.85,
        }}
      >
        {initials(user.displayName)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 500,
            fontSize: "13px",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {user.displayName}
        </div>
        <div
          style={{
            fontSize: "11px",
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {user.loginName}
        </div>
      </div>
      {isSelected && (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          style={{ flexShrink: 0 }}
        >
          <path
            d="M2 7l3.5 3.5L12 3"
            stroke="var(--accent-primary)"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

function UserPicker({
  users,
  value,
  onChange,
}: {
  users: UserOption[];
  value: string;
  onChange: (userId: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = users.find((u) => u.userId === value) ?? null;

  const filtered = query.trim()
    ? users.filter((u) => {
        const q = query.toLowerCase();
        return (
          u.displayName.toLowerCase().includes(q) ||
          u.loginName.toLowerCase().includes(q) ||
          (u.email ?? "").toLowerCase().includes(q)
        );
      })
    : users;

  useOutsideClick(
    ref,
    useCallback(() => {
      setOpen(false);
      setQuery("");
    }, []),
  );

  function handleOpen(): void {
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleSelect(userId: string): void {
    onChange(userId);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={handleOpen}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "9px 12px",
          background: "var(--bg-primary)",
          border: "1.5px solid var(--border-primary)",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
          textAlign: "left",
          color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
          fontSize: "14px",
          transition: "border-color 0.15s",
        }}
        onFocus={(e) =>
          ((e.currentTarget as HTMLButtonElement).style.borderColor =
            "var(--accent-primary)")
        }
        onBlur={(e) =>
          ((e.currentTarget as HTMLButtonElement).style.borderColor =
            "var(--border-primary)")
        }
      >
        {selected ? (
          <>
            <span
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "50%",
                background: "var(--accent-primary)",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "11px",
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {initials(selected.displayName)}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 500,
                  fontSize: "14px",
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selected.displayName}
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--text-tertiary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selected.loginName}
              </div>
            </div>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onChange("");
              }}
              style={{
                marginLeft: "auto",
                color: "var(--text-tertiary)",
                fontSize: "16px",
                lineHeight: 1,
                cursor: "pointer",
                padding: "2px 4px",
                borderRadius: "3px",
              }}
              title="Clear"
            >
              ×
            </span>
          </>
        ) : (
          <span style={{ color: "var(--text-tertiary)" }}>
            Search and assign a user…
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: "var(--bg-primary)",
            border: "1.5px solid var(--border-primary)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            zIndex: 50,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "8px",
              borderBottom: "1px solid var(--border-primary)",
            }}
          >
            <input
              ref={inputRef}
              type="text"
              placeholder="Search by name or username…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: "100%",
                padding: "7px 10px",
                border: "1.5px solid var(--border-primary)",
                borderRadius: "var(--radius-sm)",
                fontSize: "13px",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
          <div style={{ maxHeight: "220px", overflowY: "auto" }}>
            <UnassignedRow onSelect={() => handleSelect("")} />
            {filtered.length === 0 ? (
              <div
                style={{
                  padding: "12px",
                  textAlign: "center",
                  color: "var(--text-tertiary)",
                  fontSize: "13px",
                }}
              >
                No users found
              </div>
            ) : (
              filtered.map((u) => (
                <UserOptionRow
                  key={u.userId}
                  user={u}
                  isSelected={u.userId === value}
                  onSelect={() => handleSelect(u.userId)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// docs/specs/team-assign-oncall-fallback.md R1 — simple non-searchable
// dropdown (unlike UserPicker): teams are a short, admin-curated list, not
// a large searchable org roster.
function TeamPicker({
  teams,
  value,
  onChange,
}: {
  teams: TeamOption[];
  value: string;
  onChange: (teamId: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = teams.find((t) => t.id === value) ?? null;

  useOutsideClick(
    ref,
    useCallback(() => setOpen(false), []),
  );

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          padding: "9px 12px",
          background: "var(--bg-primary)",
          border: "1.5px solid var(--border-primary)",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
          textAlign: "left",
          color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
          fontSize: "14px",
        }}
      >
        {selected ? selected.name : "Select a team…"}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: "var(--bg-primary)",
            border: "1.5px solid var(--border-primary)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            zIndex: 50,
            overflow: "hidden",
            maxHeight: "220px",
            overflowY: "auto",
          }}
        >
          {teams.length === 0 ? (
            <div
              style={{
                padding: "12px",
                textAlign: "center",
                color: "var(--text-tertiary)",
                fontSize: "13px",
              }}
            >
              No teams configured
            </div>
          ) : (
            teams.map((t) => (
              <div
                key={t.id}
                onClick={() => {
                  onChange(t.id);
                  setOpen(false);
                }}
                style={{
                  padding: "9px 12px",
                  cursor: "pointer",
                  fontSize: "13px",
                  color: "var(--text-primary)",
                }}
              >
                {t.name}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

type EntityField = {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  isRequired: boolean;
  isSystem: boolean;
  config: {
    options?: Array<string | { label: string; value: string; color?: string }>;
    allowedCurrencies?: string[];
  };
};
type WorkflowDef = {
  id: string;
  name: string;
  initialState: string;
  states?: Array<{ id: string; name: string; label: string }>;
};

export function CustomerRecordCreate(): React.ReactElement {
  const { typeSlug } = useParams<{ typeSlug: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = (location.state ?? {}) as {
    workflowId?: string;
    entityTypeId?: string;
    returnTo?: string;
    // Hosted ticket-create handoff (docs/specs/hosted-ticket-create-handoff.md,
    // T4) -- set by callback.tsx when arriving via a 3rd-party handoff link.
    // Keyed by field `name`, same union already used for workflowId preselect.
    prefillFields?: Record<string, string>;
    // docs/specs/third-party-api-origin-tagging.md R2 -- present only when
    // this page was reached via the handoff flow (callback.tsx). Sent as-is
    // to POST /entities, which validates it server-side before allowing
    // creation (never trusted client-side).
    appClientId?: string;
  };
  const { getTypeBySlug, getTypeById } = useEntityTypes();
  // Prefer the explicit entityTypeId from router state (set by WorkflowRecords) —
  // it is authoritative and avoids slug ambiguity when multiple entity types share
  // the same slug. Fall back to slug matching for direct URL access.
  const entityType =
    (routeState.entityTypeId
      ? getTypeById(routeState.entityTypeId)
      : undefined) ?? (typeSlug ? getTypeBySlug(typeSlug) : undefined);
  const entityTypeId = entityType?.id ?? routeState.entityTypeId;

  const [fields, setFields] = useState<EntityField[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({});
  const [workflowId, setWorkflowId] = useState("");
  const [currentState, setCurrentState] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  // docs/specs/team-assign-oncall-fallback.md R1 — exactly one of user/team;
  // teamId is only ever sent when mode is "team" (assignedTo cleared, and
  // vice versa) so the payload always matches the server's exactly-one-of
  // contract regardless of which mode the ticket creator last touched.
  const [assignMode, setAssignMode] = useState<"user" | "team">("user");
  const [teamId, setTeamId] = useState("");
  // docs/specs/ticket-severity-and-tags.md R1 — pre-filled Medium, always
  // required at submit; the create form never lets this go null.
  const [severity, setSeverity] = useState<Severity>(DEFAULT_SEVERITY);
  const [dueDate, setDueDate] = useState("");
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Mandate = the generic system fields (assigned to, due date, remark,
  // severity) plus whichever custom fields this workflow marks required
  // (conventionally just "title") -- Other = everything else, optional,
  // quick-reference only. Mirrors the tracking-only pivot's field model.
  const [activeTab, setActiveTab] = useState<"mandate" | "other">("mandate");
  const { stagedFiles, addFiles, removeFile, pendingCount, cleanFileIds } =
    useFileUpload({ moduleSlug: typeSlug ?? "unknown" });
  const mandateFields = fields.filter((f) => f.isRequired);
  // team_id is excluded here (docs/specs/team-assign-oncall-fallback.md R2)
  // -- it is exclusively set through the User/Team toggle below, never
  // independently editable as a normal Other-tab custom field.
  const otherFields = fields.filter(
    (f) => !f.isRequired && f.name !== "team_id",
  );

  const currentWorkflowName = workflows.find((w) => w.id === workflowId)?.name;

  useEffect(() => {
    if (workflowId) {
      const wf = workflows.find((w) => w.id === workflowId);
      if (wf) {
        const isValid = wf.states?.some((s) => s.name === currentState);
        if (!isValid) {
          // Only use initialState if it still exists; otherwise pick first state
          const fallback =
            wf.states?.find((s) => s.name === wf.initialState)?.name ??
            wf.states?.[0]?.name ??
            "";
          setCurrentState(fallback);
        }
      }
    } else {
      setCurrentState("");
    }
  }, [workflowId, workflows]);

  useEffect(() => {
    if (!entityTypeId) return;
    // cancelled prevents a stale response (from React Strict Mode's double-invoke
    // or a rapid entityTypeId change) from overwriting state set by the current fetch.
    let cancelled = false;
    Promise.all([
      fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}/fields`),
      fetchWithAuth(
        `${API_URL}/workflows?${new URLSearchParams({ entityTypeId }).toString()}`,
      ),
      fetchWithAuth(`${API_URL}/users`),
      fetchWithAuth(`${API_URL}/admin/teams`),
    ])
      .then(([fieldsRes, wfRes, usersRes, teamsRes]) => {
        if (cancelled) return;
        const fs = (fieldsRes as { data: EntityField[] }).data;
        setFields(fs);
        if (routeState.prefillFields) {
          const prefill = routeState.prefillFields;
          const matched: Record<string, unknown> = {};
          for (const field of fs) {
            if (prefill[field.name] !== undefined) {
              matched[field.name] = prefill[field.name];
            }
          }
          if (Object.keys(matched).length > 0) {
            setFieldValues((prev) => ({ ...prev, ...matched }));
          }
        }
        const wfs = (wfRes as { data?: WorkflowDef[] }).data ?? [];
        setWorkflows(wfs);
        const preselect = routeState.workflowId;
        if (preselect && wfs.some((w) => w.id === preselect)) {
          setWorkflowId(preselect);
        } else if (wfs.length === 1 && wfs[0]) {
          setWorkflowId(wfs[0].id);
        }
        const usrs = (usersRes as { data?: UserOption[] }).data ?? [];
        setUsers(usrs);
        const tms = (teamsRes as { data?: TeamOption[] }).data ?? [];
        setTeams(tms);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityTypeId]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!entityTypeId || !typeSlug) return;
    // Mandatory platform-wide invariant, mirrored client-side as defense in
    // depth -- POST /entities rejects a request missing either field
    // regardless, but blocking here avoids a round-trip. Deliberately not a
    // native `required` attribute on the Due Date input (and can't be one on
    // Assigned To -- UserPicker isn't a native form control): native
    // constraint validation blocks form submission before this handler ever
    // runs, which would skip this consistent error message for one field
    // but not the other.
    // docs/specs/team-assign-oncall-fallback.md R1 — exactly one of
    // assignedTo/teamId, driven by assignMode so the two can never both be
    // set (or both be empty) regardless of what the ticket creator touched
    // before switching modes.
    const assignValue = assignMode === "user" ? assignedTo : teamId;
    if (!assignValue || !dueDate || !remark.trim()) {
      setError(
        assignMode === "user"
          ? "Assigned To, Due Date, and Remark are required."
          : "Team, Due Date, and Remark are required.",
      );
      setActiveTab("mandate");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        entityTypeId,
        fields: fieldValues,
        severity,
        dueDate: new Date(dueDate).toISOString(),
        remark: remark.trim(),
      };
      if (assignMode === "user") {
        payload["assignedTo"] = assignedTo;
      } else {
        payload["teamId"] = teamId;
      }
      if (workflowId) payload["workflowId"] = workflowId;
      if (currentState) payload["currentState"] = currentState;
      if (routeState.appClientId)
        payload["appClientId"] = routeState.appClientId;
      const res = await fetchWithAuth(`${API_URL}/entities`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const created = (res as { data: { id: string } }).data;
      for (const fileId of cleanFileIds) {
        try {
          await fetchWithAuth(`${API_URL}/entities/${created.id}/attachments`, {
            method: "POST",
            body: JSON.stringify({ fileId }),
          });
        } catch {
          // Record was created; a single attachment failing to bind
          // shouldn't block navigation — it can be re-attached from the
          // detail page.
        }
      }
      if (routeState.returnTo) {
        navigate(routeState.returnTo);
      } else {
        navigate(`/records/${typeSlug}/${created.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
      setSaving(false);
    }
  }

  if (loading)
    return (
      <div className="portal-loading">
        <div className="spinner" />
      </div>
    );

  return (
    <div className="portal-page">
      <button
        type="button"
        className="portal-back-link"
        onClick={() => navigate(-1)}
      >
        ← {entityType?.plural ?? "Records"}
      </button>
      <h1 className="portal-page-title">
        {currentWorkflowName
          ? `Create New Ticket in '${currentWorkflowName}'`
          : `New ${entityType?.plural ? singularize(entityType.plural) : (entityType?.name ?? "Ticket")}`}
      </h1>
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="portal-form"
        style={{ marginTop: "24px" }}
      >
        {error && <div className="portal-alert-error">{error}</div>}
        {workflows.length > 0 && (
          <div className="portal-field-group">
            <label className="portal-field-label">Workflow</label>
            <select
              className="portal-input"
              value={workflowId}
              onChange={(e) => setWorkflowId(e.target.value)}
            >
              <option value="">No workflow</option>
              {workflows.map((wf) => (
                <option key={wf.id} value={wf.id}>
                  {wf.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: "4px",
            borderBottom: "1px solid var(--border-color)",
            marginBottom: "16px",
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab("mandate")}
            style={{
              padding: "8px 14px",
              border: "none",
              background: "none",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "13px",
              borderBottom:
                activeTab === "mandate"
                  ? "2px solid var(--accent-primary)"
                  : "2px solid transparent",
              color:
                activeTab === "mandate"
                  ? "var(--text-primary)"
                  : "var(--text-muted)",
            }}
          >
            Mandate
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("other")}
            style={{
              padding: "8px 14px",
              border: "none",
              background: "none",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "13px",
              borderBottom:
                activeTab === "other"
                  ? "2px solid var(--accent-primary)"
                  : "2px solid transparent",
              color:
                activeTab === "other"
                  ? "var(--text-primary)"
                  : "var(--text-muted)",
            }}
          >
            Other
          </button>
        </div>
        {activeTab === "mandate" && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: "16px 20px",
              alignItems: "start",
            }}
          >
            {mandateFields.map((field) => (
              <div
                key={field.id}
                className="portal-field-group"
                style={{ margin: 0 }}
              >
                <label className="portal-field-label">
                  {field.label}
                  <span className="portal-required">*</span>
                </label>
                <FieldInput
                  field={field}
                  value={fieldValues[field.name]}
                  classPrefix="portal"
                  required
                  moduleSlug={typeSlug ?? "unknown"}
                  entityId={undefined}
                  onChange={(v) =>
                    setFieldValues((p) => ({ ...p, [field.name]: v }))
                  }
                />
              </div>
            ))}
            <div
              className="portal-field-group"
              style={{ margin: 0, gridColumn: "1 / -1" }}
            >
              <label className="portal-field-label">
                Assign To<span className="portal-required">*</span>
              </label>
              <div
                style={{
                  display: "flex",
                  gap: "6px",
                  marginBottom: "8px",
                }}
              >
                <button
                  type="button"
                  onClick={() => setAssignMode("user")}
                  style={{
                    padding: "5px 12px",
                    fontSize: "12.5px",
                    fontWeight: 600,
                    borderRadius: "var(--radius-sm)",
                    border: "1.5px solid var(--border-primary)",
                    cursor: "pointer",
                    background:
                      assignMode === "user"
                        ? "var(--accent-primary)"
                        : "var(--bg-primary)",
                    color:
                      assignMode === "user" ? "#fff" : "var(--text-primary)",
                  }}
                >
                  User
                </button>
                <button
                  type="button"
                  onClick={() => setAssignMode("team")}
                  style={{
                    padding: "5px 12px",
                    fontSize: "12.5px",
                    fontWeight: 600,
                    borderRadius: "var(--radius-sm)",
                    border: "1.5px solid var(--border-primary)",
                    cursor: "pointer",
                    background:
                      assignMode === "team"
                        ? "var(--accent-primary)"
                        : "var(--bg-primary)",
                    color:
                      assignMode === "team" ? "#fff" : "var(--text-primary)",
                  }}
                >
                  Team
                </button>
              </div>
              {assignMode === "user" ? (
                <UserPicker
                  users={users}
                  value={assignedTo}
                  onChange={setAssignedTo}
                />
              ) : (
                <TeamPicker teams={teams} value={teamId} onChange={setTeamId} />
              )}
            </div>
            <div className="portal-field-group" style={{ margin: 0 }}>
              <label className="portal-field-label">
                Due Date<span className="portal-required">*</span>
              </label>
              <input
                type="datetime-local"
                className="portal-input"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
            <div className="portal-field-group" style={{ margin: 0 }}>
              <label className="portal-field-label">
                Severity<span className="portal-required">*</span>
              </label>
              <SeverityDropdown value={severity} onChange={setSeverity} />
            </div>
            <div
              className="portal-field-group"
              style={{ margin: 0, gridColumn: "1 / -1" }}
            >
              <label className="portal-field-label">
                Remark<span className="portal-required">*</span>
              </label>
              <textarea
                className="portal-input"
                rows={3}
                maxLength={4000}
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
              />
            </div>
          </div>
        )}
        {activeTab === "other" &&
          otherFields.map((field) => (
            <div key={field.id} className="portal-field-group">
              <label className="portal-field-label">{field.label}</label>
              <FieldInput
                field={field}
                value={fieldValues[field.name]}
                classPrefix="portal"
                required={false}
                moduleSlug={typeSlug ?? "unknown"}
                entityId={undefined}
                onChange={(v) =>
                  setFieldValues((p) => ({ ...p, [field.name]: v }))
                }
              />
            </div>
          ))}
        {activeTab === "other" && otherFields.length === 0 && (
          <p className="portal-text-muted">
            No other fields defined for this entity type.
          </p>
        )}
        <div className="portal-field-group">
          <label className="portal-field-label">Attachments</label>
          {stagedFiles.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "6px",
                marginBottom: "8px",
              }}
            >
              {stagedFiles.map((f) => (
                <StagedFileChip key={f.fileId} file={f} onRemove={removeFile} />
              ))}
            </div>
          )}
          <AttachmentUploadZone onFiles={(files) => addFiles(files)} />
        </div>
        <div className="portal-form-actions">
          <button
            type="button"
            className="portal-btn-secondary"
            onClick={() => navigate(-1)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="portal-btn-primary"
            disabled={saving || pendingCount > 0}
            title={pendingCount > 0 ? "Waiting for file scan…" : undefined}
          >
            {saving ? "Creating…" : "Create Ticket"}
          </button>
        </div>
      </form>
    </div>
  );
}
