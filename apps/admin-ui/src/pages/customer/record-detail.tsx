import React, { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { useEntityTypes } from "../../entity-type-context.js";

type EntityField = {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  isSystem: boolean;
  isRequired: boolean;
  config: {
    options?: Array<string | { label: string; value: string; color?: string }>;
    allowedCurrencies?: string[];
  };
};
type EntityInstance = {
  id: string;
  workflowId: string | null;
  currentState: string | null;
  fields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  assignedTo: string | null;
};
type Transition = {
  id: string;
  fromState: string;
  toState: string;
  label: string;
  requiresComment: boolean;
};
type WorkflowState = {
  id: string;
  name: string;
  label: string;
  color: string | null;
  isTerminal: boolean;
};
type WorkflowEvent = {
  id: string;
  fromState: string | null;
  toState: string;
  actorId: string;
  actorDisplayName?: string | null;
  comment: string | null;
  triggeredAt: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};
type OrgUser = {
  userId: string;
  email: string;
  displayName: string | null;
  loginName?: string;
};

/* ── Field display ───────────────────────────────────────────── */
function FieldValue({
  value,
  fieldType,
  field,
}: {
  value: unknown;
  fieldType: string;
  field?: EntityField;
}): React.ReactElement {
  if (value === null || value === undefined)
    return <span className="rcd-muted">—</span>;
  if (fieldType === "boolean") {
    const bv = Boolean(value);
    return (
      <span className={`portal-bool-badge ${bv ? "yes" : "no"}`}>
        {bv ? "Yes" : "No"}
      </span>
    );
  }
  if (fieldType === "date" || fieldType === "datetime") {
    const d = new Date(value as string);
    return (
      <span>{isNaN(d.getTime()) ? String(value) : d.toLocaleString()}</span>
    );
  }
  if (fieldType === "currency" && typeof value === "object") {
    const cv = value as { amount?: unknown; currency?: unknown };
    return (
      <span>
        {String(cv.currency ?? "")}{" "}
        {cv.amount !== null && cv.amount !== undefined
          ? String(cv.amount)
          : "—"}
      </span>
    );
  }
  if ((fieldType === "enum" || fieldType === "multi_enum") && field) {
    const strVal = String(value);
    const opts = field.config.options ?? [];
    const match = opts.find(
      (o) => (typeof o === "string" ? o : o.value) === strVal,
    );
    const label = match
      ? typeof match === "string"
        ? match
        : match.label
      : strVal;
    const color = match && typeof match !== "string" ? match.color : undefined;
    return (
      <span
        className="portal-enum-badge"
        style={
          color
            ? {
                borderLeft: `3px solid ${color}`,
                background: `${color}18`,
                color,
              }
            : undefined
        }
      >
        {label}
      </span>
    );
  }
  return <span>{String(value)}</span>;
}

/* ── Field input (edit mode) ─────────────────────────────────── */
function FieldInput({
  field,
  value,
  onChange,
}: {
  field: EntityField;
  value: unknown;
  onChange: (v: unknown) => void;
}): React.ReactElement {
  const strVal = value === null || value === undefined ? "" : String(value);
  switch (field.fieldType) {
    case "boolean":
      return (
        <label className="portal-checkbox">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{field.label}</span>
        </label>
      );
    case "number":
      return (
        <input
          className="portal-input"
          type="number"
          value={strVal}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
        />
      );
    case "currency": {
      const currVal =
        value !== null && typeof value === "object"
          ? (value as { amount?: unknown; currency?: unknown })
          : { amount: "", currency: "" };
      const amountStr =
        currVal.amount === null || currVal.amount === undefined
          ? ""
          : String(currVal.amount);
      const currencyStr =
        currVal.currency === null || currVal.currency === undefined
          ? ""
          : String(currVal.currency);
      const allowed = field.config.allowedCurrencies ?? [];
      const currencies =
        allowed.length > 0 ? allowed : ["USD", "EUR", "GBP", "INR", "AED"];
      return (
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            className="portal-input"
            type="number"
            placeholder="0.00"
            value={amountStr}
            style={{ flex: 1 }}
            onChange={(e) =>
              onChange({
                amount: e.target.value === "" ? null : Number(e.target.value),
                currency: currencyStr || currencies[0],
              })
            }
          />
          <select
            className="portal-input"
            value={currencyStr || currencies[0]}
            style={{ width: "90px" }}
            onChange={(e) =>
              onChange({
                amount: amountStr === "" ? null : Number(amountStr),
                currency: e.target.value,
              })
            }
          >
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case "date":
      return (
        <input
          className="portal-input"
          type="date"
          value={strVal}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "datetime":
      return (
        <input
          className="portal-input"
          type="datetime-local"
          value={strVal}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "enum":
    case "multi_enum": {
      const opts = (field.config.options ?? []).map((o) =>
        typeof o === "string"
          ? { label: o, value: o }
          : { label: o.label, value: o.value },
      );
      return (
        <select
          className="portal-input"
          value={strVal}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">Select…</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    case "longtext":
      return (
        <textarea
          className="portal-input portal-textarea"
          value={strVal}
          rows={4}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    default:
      return (
        <input
          className="portal-input"
          type="text"
          value={strVal}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
  }
}

/* ── State badge with color ──────────────────────────────────── */
function StateBadge({
  stateName,
  allStates,
}: {
  stateName: string | null;
  allStates: WorkflowState[];
}): React.ReactElement {
  if (!stateName) return <span className="rcd-muted">—</span>;
  const stateObj = allStates.find((s) => s.name === stateName);
  const color = stateObj?.color ?? null;
  return (
    <span
      className="rcd-state-badge"
      style={
        color
          ? {
              background: `${color}20`,
              color,
              borderColor: `${color}55`,
            }
          : undefined
      }
    >
      <span
        className="rcd-state-dot"
        style={color ? { background: color } : undefined}
      />
      {stateObj?.label ?? stateName}
    </span>
  );
}

/* ── History event icon ──────────────────────────────────────── */
function HistoryIcon({
  type,
}: {
  type: "create" | "update" | "transition" | "comment";
}): React.ReactElement {
  if (type === "create") {
    return (
      <div className="rcd-tl-icon rcd-tl-icon-create">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </div>
    );
  }
  if (type === "update") {
    return (
      <div className="rcd-tl-icon rcd-tl-icon-update">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </div>
    );
  }
  if (type === "comment") {
    return (
      <div className="rcd-tl-icon rcd-tl-icon-comment">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      </div>
    );
  }
  return (
    <div className="rcd-tl-icon rcd-tl-icon-transition">
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="5 12 19 12" />
        <polyline points="13 6 19 12 13 18" />
      </svg>
    </div>
  );
}

/* ── Comment composer with @mention ─────────────────────────── */
function CommentComposer({
  users,
  replyTo,
  onCancel,
  onSubmit,
  placeholder,
}: {
  users: OrgUser[];
  replyTo: WorkflowEvent | null;
  onCancel?: () => void;
  onSubmit: (
    text: string,
    mentions: string[],
    replyTo: string | null,
  ) => Promise<void>;
  placeholder?: string;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState(0);
  const [mentionIdx, setMentionIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const mentionResults =
    mentionQuery !== null
      ? users
          .filter((u) => {
            const q = mentionQuery.toLowerCase();
            return (
              (u.displayName ?? "").toLowerCase().includes(q) ||
              u.email.toLowerCase().includes(q)
            );
          })
          .slice(0, 6)
      : [];

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    const val = e.target.value;
    setText(val);
    const cursor = e.target.selectionStart;
    const atMatch = /@([\w.]*)$/.exec(val.slice(0, cursor));
    if (atMatch) {
      setMentionQuery(atMatch[1] ?? "");
      setMentionAnchor(atMatch.index);
      setMentionIdx(0);
    } else {
      setMentionQuery(null);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (mentionQuery !== null && mentionResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => Math.min(i + 1, mentionResults.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const u = mentionResults[mentionIdx];
        if (u) insertMention(u);
        return;
      }
      if (e.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  function insertMention(u: OrgUser): void {
    const name = u.displayName ?? u.email;
    const before = text.slice(0, mentionAnchor);
    const after = text.slice(mentionAnchor).replace(/^@[\w.]*/, "");
    setText(`${before}@${name} ${after}`);
    setMentionQuery(null);
    textareaRef.current?.focus();
  }

  function extractMentions(): string[] {
    const nameToId = new Map(
      users.map((u) => [u.displayName ?? u.email, u.userId]),
    );
    const ids: string[] = [];
    for (const m of text.matchAll(/@([\w. ]+?)(?=\s|$)/g)) {
      const uid = nameToId.get(m[1]?.trim() ?? "");
      if (uid) ids.push(uid);
    }
    return [...new Set(ids)];
  }

  async function handleSubmit(): Promise<void> {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(text.trim(), extractMentions(), replyTo?.id ?? null);
      setText("");
      setMentionQuery(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="cmt-composer">
      {replyTo && (
        <div className="cmt-reply-banner">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 14 4 9 9 4" />
            <path d="M20 20v-7a4 4 0 00-4-4H4" />
          </svg>
          Replying to{" "}
          <strong>
            {replyTo.actorDisplayName ?? replyTo.actorId.slice(0, 8) + "…"}
          </strong>
          {onCancel && (
            <button
              type="button"
              className="cmt-reply-cancel"
              onClick={onCancel}
            >
              ×
            </button>
          )}
        </div>
      )}
      <div className="cmt-input-wrap">
        <textarea
          ref={textareaRef}
          className="cmt-textarea"
          rows={3}
          placeholder={
            placeholder ??
            "Add a comment… Use @ to mention someone (Ctrl+Enter to post)"
          }
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          disabled={submitting}
        />
        {mentionQuery !== null && mentionResults.length > 0 && (
          <div className="cmt-mention-dropdown">
            {mentionResults.map((u, i) => (
              <button
                key={u.userId}
                type="button"
                className={`cmt-mention-item ${i === mentionIdx ? "cmt-mention-item-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(u);
                }}
              >
                <span className="cmt-mention-avatar">
                  {(u.displayName ?? u.email).slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <span className="cmt-mention-name">
                    {u.displayName ?? u.email}
                  </span>
                  <span className="cmt-mention-email">{u.email}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="cmt-composer-footer">
        <span className="cmt-hint">@ to mention · Ctrl+Enter to post</span>
        <button
          type="button"
          className="portal-btn-primary cmt-post-btn"
          disabled={!text.trim() || submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );
}

/* ── Comment thread node ─────────────────────────────────────── */
function CommentNode({
  event,
  allComments,
  users,
  depth,
  onSubmitReply,
}: {
  event: WorkflowEvent;
  allComments: WorkflowEvent[];
  users: OrgUser[];
  depth: number;
  onSubmitReply: (
    text: string,
    mentions: string[],
    replyTo: string | null,
  ) => Promise<void>;
}): React.ReactElement {
  const [showReplyBox, setShowReplyBox] = useState(false);
  const meta = event.metadata as { type?: string; text?: string } | undefined;
  const commentText = meta?.text ?? event.comment ?? "";
  const ts = event.triggeredAt;
  const directReplies = allComments.filter(
    (e) =>
      (e.metadata as { replyTo?: string | null } | undefined)?.replyTo ===
      event.id,
  );

  const renderText = (): React.ReactNode =>
    commentText.split(/(@[\w. ]+)/g).map((part, i) =>
      part.startsWith("@") ? (
        <span key={i} className="cmt-mention-chip">
          {part}
        </span>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      ),
    );

  return (
    <div className={`cmt-node ${depth > 0 ? "cmt-node-reply" : ""}`}>
      <div className="cmt-node-header">
        <span className="cmt-node-avatar">
          {(event.actorDisplayName ?? event.actorId).slice(0, 1).toUpperCase()}
        </span>
        <span className="cmt-node-author">
          {event.actorDisplayName ?? event.actorId.slice(0, 8) + "…"}
        </span>
        <span className="cmt-node-time">
          {ts
            ? new Date(ts).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : ""}
        </span>
      </div>
      <div className="cmt-node-body">{renderText()}</div>
      <div className="cmt-node-actions">
        <button
          type="button"
          className="cmt-reply-btn"
          onClick={() => setShowReplyBox((v) => !v)}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 14 4 9 9 4" />
            <path d="M20 20v-7a4 4 0 00-4-4H4" />
          </svg>
          Reply
        </button>
      </div>
      {showReplyBox && (
        <div className="cmt-inline-reply">
          <CommentComposer
            users={users}
            replyTo={event}
            onCancel={() => setShowReplyBox(false)}
            placeholder="Reply… (@ to mention)"
            onSubmit={async (text, mentions, replyToId) => {
              await onSubmitReply(text, mentions, replyToId);
              setShowReplyBox(false);
            }}
          />
        </div>
      )}
      {directReplies.length > 0 && (
        <div className="cmt-replies">
          {directReplies.map((r) => (
            <CommentNode
              key={r.id}
              event={r}
              allComments={allComments}
              users={users}
              depth={depth + 1}
              onSubmitReply={onSubmitReply}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════ */
export function CustomerRecordDetail(): React.ReactElement {
  const { typeSlug, id } = useParams<{ typeSlug: string; id: string }>();
  const { getTypeBySlug } = useEntityTypes();
  const entityType = typeSlug ? getTypeBySlug(typeSlug) : undefined;
  const entityTypeId = entityType?.id;

  const [fields, setFields] = useState<EntityField[]>([]);
  const [record, setRecord] = useState<EntityInstance | null>(null);
  const [history, setHistory] = useState<WorkflowEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [stateModal, setStateModal] = useState<Transition | null>(null);
  const [comment, setComment] = useState("");
  const [transError, setTransError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, unknown>>({});
  const [editAssignedTo, setEditAssignedTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [allStates, setAllStates] = useState<WorkflowState[]>([]);
  const [currentState, setCurrentState] = useState("");
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [activeTab, setActiveTab] = useState<"history" | "comments">("history");

  const getFieldLabel = (fieldName: string): string => {
    if (fieldName === "state" || fieldName === "currentState") return "State";
    if (fieldName === "assignedTo") return "Assigned To";
    const found = fields.find((f) => f.name === fieldName);
    return found ? found.label : fieldName;
  };

  const getActorName = (actorId: string | null): string => {
    if (!actorId) return "System";
    const u = users.find((user) => user.userId === actorId);
    if (!u) return actorId.slice(0, 8) + "…";
    return u.displayName ?? u.loginName ?? u.email;
  };

  function loadRecord(): Promise<void> {
    if (!entityTypeId || !id) return Promise.resolve();
    return Promise.all([
      fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}/fields`),
      fetchWithAuth(`${API_URL}/entities/${id}`),
      fetchWithAuth(`${API_URL}/entities/${id}/transitions/history`).catch(
        () => ({ data: [] }),
      ),
      fetchWithAuth(`${API_URL}/users`).catch(() => ({ data: [] })),
    ])
      .then(([fieldsRes, recRes, histRes, usersRes]) => {
        setFields(
          (fieldsRes as { data: EntityField[] }).data.filter(
            (f) => !f.isSystem,
          ),
        );
        setRecord((recRes as { data: EntityInstance }).data);
        setHistory((histRes as { data?: WorkflowEvent[] }).data ?? []);
        setUsers(
          (
            usersRes as {
              data?: Array<{
                userId: string;
                email: string;
                displayName: string | null;
              }>;
            }
          ).data ?? [],
        );
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
  }

  async function refreshHistory(): Promise<void> {
    if (!id) return;
    const histRes = await fetchWithAuth(
      `${API_URL}/entities/${id}/transitions/history`,
    ).catch(() => ({ data: [] }));
    setHistory((histRes as { data?: WorkflowEvent[] }).data ?? []);
  }

  async function submitComment(
    text: string,
    mentions: string[],
    replyTo: string | null,
  ): Promise<void> {
    if (!id) return;
    await fetchWithAuth(`${API_URL}/entities/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ text, mentions, replyTo }),
    });
    await refreshHistory();
  }

  useEffect(() => {
    void loadRecord();
  }, [entityTypeId, id]);

  useEffect(() => {
    if (!record?.workflowId && !entityTypeId) {
      setAllStates([]);
      return;
    }

    const wfUrl = record?.workflowId
      ? `${API_URL}/workflows/${record.workflowId}`
      : `${API_URL}/workflows?${new URLSearchParams({ entityTypeId: entityTypeId ?? "" }).toString()}`;

    fetchWithAuth(wfUrl)
      .then((res) => {
        const wf = record?.workflowId
          ? (
              res as {
                data: { states: WorkflowState[]; transitions: Transition[] };
              }
            ).data
          : ((
              res as {
                data?: Array<{
                  states?: WorkflowState[];
                  transitions?: Transition[];
                }>;
              }
            ).data ?? [])[0];
        if (wf) {
          setAllStates(wf.states as WorkflowState[]);
        } else {
          setAllStates([]);
        }
      })
      .catch(() => {
        setAllStates([]);
      });
  }, [record?.workflowId, entityTypeId]);

  async function saveEdit(): Promise<void> {
    if (!id) return;
    setSaving(true);
    setSaveError(null);
    try {
      await fetchWithAuth(`${API_URL}/entities/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          fields: editValues,
          currentState,
          assignedTo: editAssignedTo || null,
        }),
      });
      setEditing(false);
      setLoading(true);
      void loadRecord();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function executeTransition(
    transition: Transition,
    userComment?: string,
  ): Promise<void> {
    if (!id) return;
    setTransitioning(transition.id);
    setTransError(null);
    try {
      await fetchWithAuth(`${API_URL}/entities/${id}/transitions`, {
        method: "POST",
        body: JSON.stringify({
          transitionId: transition.id,
          ...(userComment ? { comment: userComment } : {}),
        }),
      });
      setComment("");
      setStateModal(null);
      setLoading(true);
      void loadRecord();
    } catch (err) {
      setTransError(err instanceof Error ? err.message : "Transition failed");
    } finally {
      setTransitioning(null);
    }
  }

  if (loading)
    return (
      <div className="portal-loading">
        <div className="spinner" />
      </div>
    );

  if (error || !record) {
    return (
      <div className="rcd-page">
        <div className="portal-alert-error">{error ?? "Record not found"}</div>
        <Link
          to={`/records/${typeSlug ?? ""}`}
          className="portal-back-link"
          style={{ marginTop: "12px", display: "inline-block" }}
        >
          ← Back
        </Link>
      </div>
    );
  }

  const currentStateObj = allStates.find((s) => s.name === record.currentState);

  const historyEvents = history;
  const allCommentEvents = history.filter(
    (e) => (e.metadata as { type?: string } | null)?.type === "comment",
  );
  const topLevelComments = allCommentEvents.filter(
    (e) => !(e.metadata as { replyTo?: string | null } | null)?.replyTo,
  );

  const titleField = fields.find(
    (f) => f.name === "subject" || f.name === "title" || f.name === "name",
  );
  const recordTitle = titleField
    ? String(record.fields[titleField.name] ?? "")
    : `${entityType?.name ?? "Record"} #${record.id.slice(0, 8)}`;

  return (
    <div className="rcd-page">
      {/* ── Breadcrumb ───────────────────────────────────────── */}
      <div className="rcd-breadcrumb">
        <Link to={`/records/${typeSlug ?? ""}`} className="rcd-bc-link">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {entityType?.plural ?? "Records"}
        </Link>
        <span className="rcd-bc-sep">/</span>
        <span className="rcd-bc-current">{recordTitle}</span>
      </div>

      {/* ── Page Header ─────────────────────────────────────── */}
      <div className="rcd-header">
        <div className="rcd-header-left">
          <div className="rcd-header-icon">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="7" width="20" height="14" rx="2" />
              <path d="M16 3H8a2 2 0 00-2 2v2h12V5a2 2 0 00-2-2z" />
            </svg>
          </div>
          <div>
            <h1 className="rcd-title">{recordTitle}</h1>
            <div className="rcd-meta-row">
              <StateBadge
                stateName={record.currentState}
                allStates={allStates}
              />
              <span className="rcd-meta-sep" />
              <span className="rcd-meta-text">
                Created{" "}
                {new Date(record.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <span className="rcd-meta-sep" />
              <span className="rcd-meta-text">
                Updated{" "}
                {new Date(record.updatedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <span className="rcd-id-chip">{record.id.slice(0, 8)}</span>
            </div>
          </div>
        </div>
      </div>

      {transError && (
        <div className="portal-alert-error rcd-trans-error">
          ⚠ {transError}
          <button
            onClick={() => setTransError(null)}
            className="rcd-error-close"
          >
            ×
          </button>
        </div>
      )}

      {/* ── Two-column layout ──────────────────────────────── */}
      <div className="rcd-layout">
        {/* ── Left: Fields + History ── */}
        <div className="rcd-main">
          {/* Fields panel */}
          <div className="rcd-panel">
            <div className="rcd-panel-header">
              <div className="rcd-panel-title">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                Details
              </div>
              {!editing && (
                <button
                  className="rcd-panel-edit-icon"
                  aria-label="Edit record"
                  onClick={() => {
                    setEditValues(record.fields);
                    setCurrentState(record.currentState ?? "");
                    setEditAssignedTo(record.assignedTo ?? "");
                    setEditing(true);
                    setSaveError(null);
                  }}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              )}
            </div>

            {fields.length === 0 ? (
              <p className="rcd-empty-hint">
                No fields defined for this record type.
              </p>
            ) : editing ? (
              <div className="rcd-edit-body">
                {saveError && (
                  <div
                    className="portal-alert-error"
                    style={{ marginBottom: "16px" }}
                  >
                    {saveError}
                  </div>
                )}
                <div className="portal-edit-grid">
                  {allStates.length > 0 && (
                    <div className="portal-field-group portal-field-full">
                      <label className="portal-field-label">State</label>
                      <select
                        className="portal-input"
                        value={currentState}
                        onChange={(e) => setCurrentState(e.target.value)}
                      >
                        {allStates.map((st) => (
                          <option key={st.id} value={st.name}>
                            {st.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="portal-field-group portal-field-full">
                    <label className="portal-field-label">Assigned To</label>
                    <select
                      className="portal-input"
                      value={editAssignedTo}
                      onChange={(e) => setEditAssignedTo(e.target.value)}
                    >
                      <option value="">Unassigned</option>
                      {users.map((u) => (
                        <option key={u.userId} value={u.userId}>
                          {u.displayName ?? u.email}
                        </option>
                      ))}
                    </select>
                  </div>
                  {fields.map((f) => (
                    <div
                      key={f.id}
                      className={`portal-field-group ${f.fieldType === "longtext" ? "portal-field-full" : ""}`}
                    >
                      <label className="portal-field-label">
                        {f.label}
                        {f.isRequired && (
                          <span className="portal-required">*</span>
                        )}
                      </label>
                      <FieldInput
                        field={f}
                        value={editValues[f.name]}
                        onChange={(v) =>
                          setEditValues((p) => ({ ...p, [f.name]: v }))
                        }
                      />
                    </div>
                  ))}
                </div>
                <div className="rcd-edit-footer">
                  <button
                    className="portal-btn-secondary"
                    onClick={() => {
                      setEditing(false);
                      setSaveError(null);
                    }}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    className="portal-btn-primary"
                    onClick={() => void saveEdit()}
                    disabled={saving}
                  >
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="rcd-fields">
                <div className="rcd-field-row">
                  <div className="rcd-field-label">Assigned To</div>
                  <div className="rcd-field-value">
                    {record.assignedTo ? (
                      <span>
                        {(() => {
                          const u = users.find(
                            (u) => u.userId === record.assignedTo,
                          );
                          return u
                            ? (u.displayName ?? u.loginName ?? u.email)
                            : record.assignedTo;
                        })()}
                      </span>
                    ) : (
                      <span className="rcd-muted">Unassigned</span>
                    )}
                  </div>
                </div>
                {fields.map((f) => (
                  <div key={f.id} className="rcd-field-row">
                    <div className="rcd-field-label">{f.label}</div>
                    <div className="rcd-field-value">
                      <FieldValue
                        value={record.fields[f.name]}
                        fieldType={f.fieldType}
                        field={f}
                      />
                    </div>
                  </div>
                ))}
                {fields.length === 0 && (
                  <p className="rcd-empty-hint">No custom fields.</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Right sidebar ── */}
        <div className="rcd-sidebar">
          {/* Record info */}
          <div className="rcd-panel">
            <div className="rcd-panel-header">
              <div className="rcd-panel-title">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                Info
              </div>
            </div>
            <div className="rcd-info-list">
              {[
                { label: "Record ID", value: record.id.slice(0, 8) + "…" },
                {
                  label: "Current State",
                  value: currentStateObj?.label ?? record.currentState ?? "—",
                },
                { label: "Type", value: entityType?.name ?? "—" },
                {
                  label: "Created",
                  value: new Date(record.createdAt).toLocaleDateString(),
                },
                {
                  label: "Last Updated",
                  value: new Date(record.updatedAt).toLocaleDateString(),
                },
              ].map((row) => (
                <div key={row.label} className="rcd-info-row">
                  <div className="rcd-info-label">{row.label}</div>
                  <div className="rcd-info-value">{row.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* State pipeline */}
          {allStates.length > 0 && (
            <div className="rcd-panel">
              <div className="rcd-panel-header">
                <div className="rcd-panel-title">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061A1.125 1.125 0 013 16.811V8.69zM12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061a1.125 1.125 0 01-1.683-.977V8.69z" />
                  </svg>
                  Workflow States
                </div>
              </div>
              <div className="rcd-states-list">
                {allStates.map((s) => {
                  const isCurrent = s.name === record.currentState;
                  return (
                    <div
                      key={s.id}
                      className={`rcd-state-row ${isCurrent ? "rcd-state-row-current" : ""}`}
                    >
                      <span
                        className="rcd-state-pip"
                        style={{ background: s.color ?? "var(--accent)" }}
                      />
                      <span className="rcd-state-name">{s.label}</span>
                      {isCurrent && (
                        <span className="rcd-state-current-tag">current</span>
                      )}
                      {s.isTerminal && !isCurrent && (
                        <span className="rcd-state-end-tag">end</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Activity section — full width ──────────────────── */}
      <div className="rcd-activity-section">
        <div className="rcd-tabs">
          <button
            type="button"
            className={`rcd-tab${activeTab === "history" ? " rcd-tab-active" : ""}`}
            onClick={() => {
              setActiveTab("history");
            }}
          >
            History
            {historyEvents.length > 0 && (
              <span className="rcd-tab-count">{historyEvents.length}</span>
            )}
          </button>
          <button
            type="button"
            className={`rcd-tab${activeTab === "comments" ? " rcd-tab-active" : ""}`}
            onClick={() => {
              setActiveTab("comments");
            }}
          >
            Comments
            {allCommentEvents.length > 0 && (
              <span className="rcd-tab-count">{allCommentEvents.length}</span>
            )}
          </button>
        </div>

        {activeTab === "history" && (
          <div className="rcd-activity-body">
            {historyEvents.length === 0 ? (
              <p className="rcd-empty-hint">No history yet.</p>
            ) : (
              <div className="rcd-timeline rcd-timeline-wide">
                {[...historyEvents].reverse().map((event) => {
                  const meta = event.metadata;
                  const isCreate = meta?.type === "create";
                  const isUpdate = meta?.type === "update";
                  const isComment = meta?.type === "comment";
                  const eventType = isCreate
                    ? "create"
                    : isUpdate
                      ? "update"
                      : isComment
                        ? "comment"
                        : "transition";
                  return (
                    <div key={event.id} className="rcd-tl-item">
                      <div className="rcd-tl-left">
                        <HistoryIcon type={eventType} />
                        <div className="rcd-tl-line" />
                      </div>
                      <div className="rcd-tl-body">
                        {isComment ? (
                          <div className="rcd-tl-title">
                            Added a comment
                            <span className="rcd-tl-actor">
                              by{" "}
                              {event.actorDisplayName ??
                                getActorName(event.actorId)}
                            </span>
                          </div>
                        ) : isCreate ? (
                          <div className="rcd-tl-title">
                            Record created
                            <span className="rcd-tl-actor">
                              by{" "}
                              {event.actorDisplayName ??
                                getActorName(event.actorId)}
                            </span>
                          </div>
                        ) : isUpdate ? (
                          <div>
                            <div className="rcd-tl-title">
                              Record updated
                              <span className="rcd-tl-actor">
                                by{" "}
                                {event.actorDisplayName ??
                                  getActorName(event.actorId)}
                              </span>
                            </div>
                            {"changed" in (meta as Record<string, unknown>) &&
                              typeof (meta as Record<string, unknown>)[
                                "changed"
                              ] === "object" &&
                              (meta as Record<string, unknown>)["changed"] !==
                                null &&
                              Object.keys(
                                (meta as Record<string, unknown>)[
                                  "changed"
                                ] as object,
                              ).length > 0 && (
                                <ul className="rcd-tl-changes">
                                  {Object.entries(
                                    (
                                      meta as Record<
                                        string,
                                        Record<string, Record<string, unknown>>
                                      >
                                    )["changed"] ?? {},
                                  ).map(([fieldName, change]) => (
                                    <li key={fieldName}>
                                      <strong>
                                        {getFieldLabel(fieldName)}
                                      </strong>
                                      :{" "}
                                      {fieldName === "assignedTo"
                                        ? ((change["oldName"] as
                                            | string
                                            | null) ??
                                          getActorName(
                                            change["old"] as string | null,
                                          ))
                                        : String(change["old"] ?? "—")}{" "}
                                      →{" "}
                                      {fieldName === "assignedTo"
                                        ? ((change["newName"] as
                                            | string
                                            | null) ??
                                          getActorName(
                                            change["new"] as string | null,
                                          ))
                                        : String(change["new"] ?? "—")}
                                    </li>
                                  ))}
                                </ul>
                              )}
                          </div>
                        ) : (
                          <div className="rcd-tl-transition-row">
                            {event.fromState && (
                              <>
                                <span className="rcd-tl-state">
                                  {event.fromState}
                                </span>
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  className="rcd-tl-arrow"
                                >
                                  <polyline points="5 12 19 12" />
                                  <polyline points="13 6 19 12 13 18" />
                                </svg>
                              </>
                            )}
                            <span className="rcd-tl-state rcd-tl-state-to">
                              {event.toState}
                            </span>
                            <span className="rcd-tl-actor">
                              by{" "}
                              {event.actorDisplayName ??
                                getActorName(event.actorId)}
                            </span>
                          </div>
                        )}
                        {event.comment && !isCreate && !isUpdate && (
                          <div className="rcd-tl-comment">
                            "{event.comment}"
                          </div>
                        )}
                        <div className="rcd-tl-time">
                          {new Date(event.triggeredAt).toLocaleString(
                            undefined,
                            {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            },
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === "comments" && (
          <div className="rcd-activity-body cmt-tab">
            <CommentComposer
              users={users}
              replyTo={null}
              onSubmit={(text, mentions, replyTo) => {
                return submitComment(text, mentions, replyTo);
              }}
            />
            <div className="cmt-thread">
              {topLevelComments.length === 0 ? (
                <p className="rcd-empty-hint">No comments yet.</p>
              ) : (
                [...topLevelComments].reverse().map((c) => (
                  <CommentNode
                    key={c.id}
                    event={c}
                    allComments={allCommentEvents}
                    users={users}
                    depth={0}
                    onSubmitReply={(text, mentions, replyTo) => {
                      return submitComment(text, mentions, replyTo);
                    }}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Transition modal ─────────────────────────────────── */}
      {stateModal && (
        <div
          className="modal-overlay"
          onClick={() => {
            setStateModal(null);
            setComment("");
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                Move to "{stateModal.label || stateModal.toState}"
              </h3>
              <button
                className="modal-close"
                onClick={() => {
                  setStateModal(null);
                  setComment("");
                }}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p className="rcd-modal-desc">
                This will transition the record from{" "}
                <strong>{record.currentState}</strong> to{" "}
                <strong>{stateModal.toState}</strong>.
              </p>
              <div className="form-group">
                <label className="form-label">
                  Comment {stateModal.requiresComment ? "*" : "(optional)"}
                </label>
                <textarea
                  className="form-input portal-textarea"
                  rows={3}
                  placeholder="Add a note about this transition…"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn-secondary"
                onClick={() => {
                  setStateModal(null);
                  setComment("");
                }}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={
                  (stateModal.requiresComment && !comment.trim()) ||
                  transitioning === stateModal.id
                }
                onClick={() =>
                  void executeTransition(stateModal, comment || undefined)
                }
              >
                {transitioning === stateModal.id ? "Moving…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
