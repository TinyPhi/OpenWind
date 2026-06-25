import React, { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../auth.js";
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
  };
};
type EntityInstance = {
  id: string;
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
    return <span className="rd-muted">—</span>;
  if (fieldType === "boolean") {
    const bv = Boolean(value);
    return (
      <span className={`rd-bool ${bv ? "rd-bool--yes" : "rd-bool--no"}`}>
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
        className="rd-enum"
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
        <label className="rd-checkbox">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{field.label}</span>
        </label>
      );
    case "number":
    case "currency":
      return (
        <input
          className="rd-input"
          type="number"
          value={strVal}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
        />
      );
    case "date":
      return (
        <input
          className="rd-input"
          type="date"
          value={strVal}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "datetime":
      return (
        <input
          className="rd-input"
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
          className="rd-input"
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
          className="rd-input rd-textarea"
          value={strVal}
          rows={4}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    default:
      return (
        <input
          className="rd-input"
          type="text"
          value={strVal}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
  }
}

function StateChip({ state }: { state: string | null }): React.ReactElement {
  if (!state) return <span className="rd-muted">No state</span>;
  const lower = state.toLowerCase();
  let mod = "";
  if (
    lower.includes("open") ||
    lower.includes("new") ||
    lower.includes("active")
  )
    mod = "rd-state--open";
  else if (
    lower.includes("done") ||
    lower.includes("closed") ||
    lower.includes("resolved") ||
    lower.includes("complete")
  )
    mod = "rd-state--done";
  else if (
    lower.includes("progress") ||
    lower.includes("review") ||
    lower.includes("pending")
  )
    mod = "rd-state--progress";
  return <span className={`rd-state-chip ${mod}`}>{state}</span>;
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
    <div className="rd-cmt-composer">
      {replyTo && (
        <div className="rd-cmt-reply-banner">
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
              className="rd-cmt-reply-cancel"
              onClick={onCancel}
            >
              ×
            </button>
          )}
        </div>
      )}
      <div className="rd-cmt-input-wrap">
        <textarea
          ref={textareaRef}
          className="rd-cmt-textarea"
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
          <div className="rd-cmt-mention-dropdown">
            {mentionResults.map((u, i) => (
              <button
                key={u.userId}
                type="button"
                className={`rd-cmt-mention-item ${i === mentionIdx ? "rd-cmt-mention-item-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(u);
                }}
              >
                <span className="rd-cmt-mention-avatar">
                  {(u.displayName ?? u.email).slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <span className="rd-cmt-mention-name">
                    {u.displayName ?? u.email}
                  </span>
                  <span className="rd-cmt-mention-email">{u.email}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="rd-cmt-composer-footer">
        <span className="rd-cmt-hint">@ to mention · Ctrl+Enter to post</span>
        <button
          type="button"
          className="portal-btn-primary rd-cmt-post-btn"
          disabled={!text.trim() || submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );
}

/* ── Single comment node (threaded) ─────────────────────────── */
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
        <span key={i} className="rd-cmt-mention-chip">
          {part}
        </span>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      ),
    );

  return (
    <div className={`rd-cmt-node ${depth > 0 ? "rd-cmt-node-reply" : ""}`}>
      <div className="rd-cmt-node-header">
        <span className="rd-cmt-node-avatar">
          {(event.actorDisplayName ?? event.actorId).slice(0, 1).toUpperCase()}
        </span>
        <span className="rd-cmt-node-author">
          {event.actorDisplayName ?? event.actorId.slice(0, 8) + "…"}
        </span>
        <span className="rd-cmt-node-time">
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
      <div className="rd-cmt-node-body">{renderText()}</div>
      <div className="rd-cmt-node-actions">
        <button
          type="button"
          className="rd-cmt-reply-btn"
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
        <div className="rd-cmt-inline-reply">
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
        <div className="rd-cmt-replies">
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
export function RecordDetail(): React.ReactElement {
  const { typeSlug, id } = useParams<{ typeSlug: string; id: string }>();
  const { getTypeBySlug } = useEntityTypes();

  const entityType = typeSlug ? getTypeBySlug(typeSlug) : undefined;
  const entityTypeId = entityType?.id;

  const [fields, setFields] = useState<EntityField[]>([]);
  const [record, setRecord] = useState<EntityInstance | null>(null);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [history, setHistory] = useState<WorkflowEvent[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"history" | "comments">("history");

  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [stateModal, setStateModal] = useState<Transition | null>(null);
  const [comment, setComment] = useState("");
  const [transError, setTransError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function loadRecord(): Promise<void> {
    if (!entityTypeId || !id) return Promise.resolve();
    return Promise.all([
      fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}/fields`),
      fetchWithAuth(`${API_URL}/entities/${id}`),
      fetchWithAuth(`${API_URL}/entities/${id}/transitions`),
      fetchWithAuth(`${API_URL}/entities/${id}/transitions/history`).catch(
        () => ({ data: [] }),
      ),
      fetchWithAuth(`${API_URL}/users`).catch(() => ({ data: [] })),
    ])
      .then(([fieldsRes, recRes, transRes, histRes, usersRes]) => {
        setFields(
          (fieldsRes as { data: EntityField[] }).data.filter(
            (f) => !f.isSystem,
          ),
        );
        setRecord((recRes as { data: EntityInstance }).data);
        setTransitions((transRes as { data?: Transition[] }).data ?? []);
        setHistory((histRes as { data?: WorkflowEvent[] }).data ?? []);
        setUsers((usersRes as { data?: OrgUser[] }).data ?? []);
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

  useEffect(() => {
    void loadRecord();
  }, [entityTypeId, id]);

  async function saveEdit(): Promise<void> {
    if (!id) return;
    setSaving(true);
    setSaveError(null);
    try {
      await fetchWithAuth(`${API_URL}/entities/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ fields: editValues }),
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

  if (loading)
    return (
      <div className="portal-loading">
        <div className="spinner" />
      </div>
    );

  if (error || !record) {
    return (
      <div className="portal-page">
        <div className="portal-alert-error">{error ?? "Record not found"}</div>
        <Link
          to={`/${typeSlug ?? ""}`}
          className="rd-back"
          style={{ marginTop: "12px", display: "inline-flex" }}
        >
          ← Back
        </Link>
      </div>
    );
  }

  const createdDate = new Date(record.createdAt).toLocaleString();
  const updatedDate = new Date(record.updatedAt).toLocaleString();

  const historyEvents = history.filter(
    (e) => (e.metadata as { type?: string } | undefined)?.type !== "comment",
  );
  const allCommentEvents = history.filter(
    (e) => (e.metadata as { type?: string } | undefined)?.type === "comment",
  );
  const topLevelComments = allCommentEvents.filter(
    (e) => !(e.metadata as { replyTo?: string | null } | undefined)?.replyTo,
  );

  return (
    <div className="portal-page rd-page">
      {/* ── Breadcrumb ── */}
      <Link to={`/${typeSlug ?? ""}`} className="rd-back">
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
          <polyline points="15 18 9 12 15 6" />
        </svg>
        {entityType?.plural ?? "Records"}
      </Link>

      {/* ── Page header ── */}
      <div className="rd-header">
        <div className="rd-header-accent" />
        <div className="rd-header-main">
          <div className="rd-header-top">
            <h1 className="rd-title">{entityType?.name ?? "Record"}</h1>
            <StateChip state={record.currentState} />
          </div>
          <p className="rd-meta">
            Created {createdDate}
            {record.updatedAt !== record.createdAt && (
              <> · Updated {updatedDate}</>
            )}
          </p>
        </div>
      </div>

      {/* ── Two-column body ── */}
      <div className="rd-body">
        {/* ── Main column ── */}
        <div className="rd-main-col">
          {/* Details card */}
          <div className="rd-card">
            <div className="rd-card-head">
              <span className="rd-card-title">Details</span>
              {!editing && (
                <button
                  className="rd-btn-edit"
                  onClick={() => {
                    setEditValues(record.fields);
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
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                  Edit
                </button>
              )}
            </div>

            {fields.length === 0 ? (
              <p className="rd-muted" style={{ padding: "18px" }}>
                No fields defined.
              </p>
            ) : editing ? (
              <div className="rd-edit-body">
                {saveError && (
                  <div
                    className="portal-alert-error"
                    style={{ marginBottom: "16px" }}
                  >
                    {saveError}
                  </div>
                )}
                <div className="rd-edit-grid">
                  {fields.map((f) => (
                    <div
                      key={f.id}
                      className={`rd-field-group ${f.fieldType === "longtext" ? "rd-field-full" : ""}`}
                    >
                      <label className="rd-field-label">
                        {f.label}
                        {f.isRequired && <span className="rd-required">*</span>}
                      </label>
                      <FieldInput
                        field={f}
                        value={editValues[f.name]}
                        onChange={(v) =>
                          setEditValues((prev) => ({ ...prev, [f.name]: v }))
                        }
                      />
                    </div>
                  ))}
                </div>
                <div className="rd-edit-actions">
                  <button
                    className="rd-btn-cancel"
                    onClick={() => {
                      setEditing(false);
                      setSaveError(null);
                    }}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    className="rd-btn-save"
                    onClick={() => void saveEdit()}
                    disabled={saving}
                  >
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="rd-fields-grid">
                {fields.map((f) => (
                  <div key={f.id} className="rd-field-cell">
                    <div className="rd-field-key">{f.label}</div>
                    <div className="rd-field-val">
                      <FieldValue
                        value={record.fields[f.name]}
                        fieldType={f.fieldType}
                        field={f}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── History / Comments tabs ── */}
          <div className="rd-card rd-tab-card">
            <div className="rd-tabs">
              <button
                type="button"
                className={`rd-tab ${activeTab === "history" ? "rd-tab-active" : ""}`}
                onClick={() => setActiveTab("history")}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                History
                {historyEvents.length > 0 && (
                  <span className="rd-tab-count">{historyEvents.length}</span>
                )}
              </button>
              <button
                type="button"
                className={`rd-tab ${activeTab === "comments" ? "rd-tab-active" : ""}`}
                onClick={() => setActiveTab("comments")}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
                Comments
                {allCommentEvents.length > 0 && (
                  <span className="rd-tab-count">
                    {allCommentEvents.length}
                  </span>
                )}
              </button>
            </div>

            {/* History tab */}
            {activeTab === "history" && (
              <div className="rd-tab-body">
                {historyEvents.length === 0 ? (
                  <p className="rd-muted" style={{ padding: "18px" }}>
                    No activity yet.
                  </p>
                ) : (
                  <div className="rd-timeline">
                    {[...historyEvents].reverse().map((event, idx) => {
                      const meta = event.metadata;
                      const isCreate = meta?.type === "create";
                      const isUpdate = meta?.type === "update";
                      return (
                        <div
                          key={event.id}
                          className={`rd-tl-item ${idx === historyEvents.length - 1 ? "rd-tl-last" : ""}`}
                        >
                          <div className="rd-tl-spine">
                            <div className="rd-tl-dot" />
                            {idx < historyEvents.length - 1 && (
                              <div className="rd-tl-line" />
                            )}
                          </div>
                          <div className="rd-tl-body">
                            {isCreate ? (
                              <div className="rd-tl-states">
                                <span className="rd-tl-badge rd-tl-badge--to">
                                  Created
                                </span>
                                {event.actorDisplayName && (
                                  <span className="rd-tl-by">
                                    by {event.actorDisplayName}
                                  </span>
                                )}
                              </div>
                            ) : isUpdate ? (
                              <div>
                                <div className="rd-tl-states">
                                  <span className="rd-tl-badge">Updated</span>
                                  {event.actorDisplayName && (
                                    <span className="rd-tl-by">
                                      by {event.actorDisplayName}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="rd-tl-states">
                                {event.fromState && (
                                  <>
                                    <span className="rd-tl-badge">
                                      {event.fromState}
                                    </span>
                                    <span className="rd-tl-arrow">→</span>
                                  </>
                                )}
                                <span className="rd-tl-badge rd-tl-badge--to">
                                  {event.toState}
                                </span>
                                {event.actorDisplayName && (
                                  <span className="rd-tl-by">
                                    by {event.actorDisplayName}
                                  </span>
                                )}
                              </div>
                            )}
                            {event.comment && (
                              <p className="rd-tl-comment">"{event.comment}"</p>
                            )}
                            <p className="rd-tl-time">
                              {new Date(event.triggeredAt).toLocaleString()}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Comments tab */}
            {activeTab === "comments" && (
              <div className="rd-tab-body rd-cmt-tab">
                <CommentComposer
                  users={users}
                  replyTo={null}
                  onSubmit={submitComment}
                />
                {topLevelComments.length === 0 ? (
                  <p className="rd-muted rd-cmt-empty">
                    No comments yet. Be the first to comment.
                  </p>
                ) : (
                  <div className="rd-cmt-thread">
                    {[...topLevelComments].reverse().map((e) => (
                      <CommentNode
                        key={e.id}
                        event={e}
                        allComments={allCommentEvents}
                        users={users}
                        depth={0}
                        onSubmitReply={submitComment}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Sidebar column ── */}
        <div className="rd-side-col">
          {/* Transitions */}
          {transitions.length > 0 && (
            <div className="rd-card rd-side-card">
              <div className="rd-card-head">
                <span className="rd-card-title">Actions</span>
              </div>
              <div className="rd-status-body">
                {transError && (
                  <div
                    className="portal-alert-error"
                    style={{ marginBottom: "10px", fontSize: "12px" }}
                  >
                    {transError}
                  </div>
                )}
                <div className="rd-trans-list">
                  {transitions.map((t) => (
                    <button
                      key={t.id}
                      className="rd-trans-btn"
                      disabled={transitioning !== null}
                      onClick={() => setStateModal(t)}
                    >
                      {transitioning === t.id ? (
                        <span
                          className="spinner"
                          style={{
                            width: "12px",
                            height: "12px",
                            borderWidth: "2px",
                          }}
                        />
                      ) : (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      )}
                      {t.label || t.toState}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Record metadata */}
          <div className="rd-card rd-side-card">
            <div className="rd-card-head">
              <span className="rd-card-title">Info</span>
            </div>
            <div className="rd-meta-grid">
              <div className="rd-meta-row">
                <span className="rd-meta-key">Record ID</span>
                <span className="rd-meta-val rd-id">{id?.slice(0, 8)}…</span>
              </div>
              <div className="rd-meta-row">
                <span className="rd-meta-key">State</span>
                <span className="rd-meta-val">
                  {record.currentState ?? "—"}
                </span>
              </div>
              <div className="rd-meta-row">
                <span className="rd-meta-key">Created</span>
                <span className="rd-meta-val">
                  {new Date(record.createdAt).toLocaleDateString()}
                </span>
              </div>
              <div className="rd-meta-row">
                <span className="rd-meta-key">Last updated</span>
                <span className="rd-meta-val">
                  {new Date(record.updatedAt).toLocaleDateString()}
                </span>
              </div>
              {record.assignedTo && (
                <div className="rd-meta-row">
                  <span className="rd-meta-key">Assigned to</span>
                  <span className="rd-meta-val">{record.assignedTo}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Transition confirmation modal ── */}
      {stateModal && (
        <div
          className="portal-modal-overlay"
          onClick={() => {
            setStateModal(null);
            setComment("");
          }}
        >
          <div className="rd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="rd-modal-head">
              <h3 className="rd-modal-title">
                Move to "{stateModal.label || stateModal.toState}"
              </h3>
              <button
                className="rd-modal-close"
                onClick={() => {
                  setStateModal(null);
                  setComment("");
                }}
              >
                ×
              </button>
            </div>
            <div className="rd-modal-body">
              <div className="rd-modal-states">
                <span className="rd-tl-badge">{record.currentState}</span>
                <span className="rd-tl-arrow">→</span>
                <span className="rd-tl-badge rd-tl-badge--to">
                  {stateModal.toState}
                </span>
              </div>
              <label
                className="rd-field-label"
                style={{ marginTop: "16px", display: "block" }}
              >
                Comment{" "}
                {stateModal.requiresComment ? (
                  <span className="rd-required">*</span>
                ) : (
                  <span className="rd-muted">(optional)</span>
                )}
              </label>
              <textarea
                className="rd-input rd-textarea"
                rows={3}
                placeholder="Add a note about this change…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                autoFocus
              />
            </div>
            <div className="rd-modal-foot">
              <button
                className="rd-btn-cancel"
                onClick={() => {
                  setStateModal(null);
                  setComment("");
                }}
              >
                Cancel
              </button>
              <button
                className="rd-btn-save"
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
