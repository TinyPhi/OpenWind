import React, { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { useEntityTypes } from "../../entity-type-context.js";
import { userManager } from "../../authProvider.js";
import { useFileUpload } from "../../hooks/use-file-upload.js";
import {
  type AttachmentFile,
  FileChip,
  FileCardRow,
  StagedFileChip,
  AttachmentUploadZone,
  FilePreviewModal,
} from "../../components/file-attachment.js";

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
  entityTypeId: string;
  workflowId: string | null;
  currentState: string | null;
  fields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  assignedTo: string | null;
  createdBy: string | null;
  parentId?: string | null;
  childCount?: number;
  canAddChildren?: boolean;
  deletedAt?: string | null;
};
type ChildInstance = {
  id: string;
  currentState: string | null;
  fields: Record<string, unknown>;
  assignedTo: string | null;
  deletedAt: string | null;
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

/* ── Comment composer with @mention + file attachments ──────── */
function CommentComposer({
  users,
  replyTo,
  onCancel,
  onSubmit,
  placeholder,
  entityId,
  moduleSlug,
}: {
  users: OrgUser[];
  replyTo: WorkflowEvent | null;
  onCancel?: () => void;
  onSubmit: (
    text: string,
    mentions: string[],
    replyTo: string | null,
    fileIds: string[],
  ) => Promise<void>;
  placeholder?: string;
  entityId: string;
  moduleSlug: string;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState(0);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionedIds, setMentionedIds] = useState<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const {
    stagedFiles,
    addFiles,
    removeFile,
    clearFiles,
    pendingCount,
    cleanFileIds,
  } = useFileUpload({ entityId, moduleSlug });

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
    setMentionedIds((prev) => new Set([...prev, u.userId]));
    setMentionQuery(null);
    textareaRef.current?.focus();
  }

  async function handleSubmit(): Promise<void> {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(
        text.trim(),
        [...mentionedIds],
        replyTo?.id ?? null,
        cleanFileIds,
      );
      setText("");
      setMentionQuery(null);
      setMentionedIds(new Set());
      clearFiles();
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
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((f) =>
              f.type.startsWith("image/"),
            );
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
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
      {stagedFiles.length > 0 && (
        <div className="cmt-staged-files">
          {stagedFiles.map((f) => (
            <StagedFileChip key={f.fileId} file={f} onRemove={removeFile} />
          ))}
        </div>
      )}
      <div className="cmt-composer-footer">
        <span className="cmt-hint">@ mention · Ctrl+Enter to post</span>
        <div className="cmt-footer-actions">
          <label className="cmt-attach-btn" title="Attach files">
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
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
            <span>Attach</span>
            <input
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) {
                  void addFiles(files);
                  e.target.value = "";
                }
              }}
            />
          </label>
          <div className="cmt-footer-sep" />
          <button
            type="button"
            className="portal-btn-primary cmt-post-btn"
            disabled={!text.trim() || submitting || pendingCount > 0}
            title={pendingCount > 0 ? "Waiting for file scan…" : undefined}
            onClick={() => void handleSubmit()}
          >
            {submitting ? (
              "Posting…"
            ) : (
              <>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
                Post
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Searchable assign dropdown ──────────────────────────────── */
function AssignDropdown({
  value,
  users,
  disabled,
  onChange,
}: {
  value: string;
  users: OrgUser[];
  disabled?: boolean;
  onChange: (userId: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedUser = users.find((u) => u.userId === value);
  const filtered = search
    ? users.filter((u) => {
        const q = search.toLowerCase();
        return (
          (u.displayName ?? "").toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q)
        );
      })
    : users;

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function onClickOutside(e: MouseEvent): void {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function select(userId: string): void {
    onChange(userId);
    setOpen(false);
    setSearch("");
  }

  return (
    <div ref={containerRef} className="asgn-drop">
      <button
        type="button"
        className={`asgn-trigger ${open ? "asgn-trigger-open" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {selectedUser ? (
          <>
            <span className="asgn-avatar">
              {(selectedUser.displayName ?? selectedUser.email)
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <span className="asgn-name">
              {selectedUser.displayName ?? selectedUser.email}
            </span>
          </>
        ) : (
          <>
            <span className="asgn-avatar asgn-avatar-empty">?</span>
            <span className="asgn-name asgn-unassigned">Unassigned</span>
          </>
        )}
        <svg
          className="asgn-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="asgn-menu">
          <div className="asgn-search-wrap">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={searchRef}
              className="asgn-search"
              placeholder="Search people…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="asgn-options">
            <button
              type="button"
              className={`asgn-option ${!value ? "asgn-option-selected" : ""}`}
              onClick={() => select("")}
            >
              <span className="asgn-avatar asgn-avatar-empty">?</span>
              <span className="asgn-option-info">
                <span className="asgn-option-name">Unassigned</span>
              </span>
              {!value && (
                <svg
                  className="asgn-check"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
            {filtered.length === 0 && (
              <div className="asgn-empty">No results</div>
            )}
            {filtered.map((u) => (
              <button
                key={u.userId}
                type="button"
                className={`asgn-option ${value === u.userId ? "asgn-option-selected" : ""}`}
                onClick={() => select(u.userId)}
              >
                <span className="asgn-avatar">
                  {(u.displayName ?? u.email).slice(0, 1).toUpperCase()}
                </span>
                <span className="asgn-option-info">
                  <span className="asgn-option-name">
                    {u.displayName ?? u.email}
                  </span>
                  <span className="asgn-option-email">{u.email}</span>
                </span>
                {value === u.userId && (
                  <svg
                    className="asgn-check"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Searchable state transition dropdown ────────────────────── */
function StateDropdown({
  currentState: current,
  allStates,
  transitions,
  disabled,
  onTransition,
}: {
  currentState: string | null;
  allStates: WorkflowState[];
  transitions: Transition[];
  disabled?: boolean;
  onTransition: (transition: Transition) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const stateObj = allStates.find((s) => s.name === current);
  const color = stateObj?.color ?? null;
  const available = transitions.filter((t) => t.fromState === current);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent): void {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  if (!current) return <span className="rcd-muted">—</span>;

  return (
    <div ref={containerRef} className="asgn-drop">
      <button
        type="button"
        className={`asgn-trigger asgn-trigger-state ${open ? "asgn-trigger-open" : ""}`}
        disabled={disabled === true || available.length === 0}
        onClick={() => setOpen((v) => !v)}
        title={
          available.length === 0 ? "No transitions available" : "Change state"
        }
      >
        <span
          className="rcd-state-dot"
          style={color ? { background: color } : undefined}
        />
        <span className="asgn-name">{stateObj?.label ?? current}</span>
        {available.length > 0 && (
          <svg
            className="asgn-chevron"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {open && available.length > 0 && (
        <div className="asgn-menu">
          <div className="asgn-menu-label">Move to…</div>
          <div className="asgn-options">
            {available.map((t) => {
              const toState = allStates.find((s) => s.name === t.toState);
              const toColor = toState?.color ?? null;
              return (
                <button
                  key={t.id}
                  type="button"
                  className="asgn-option"
                  onClick={() => {
                    setOpen(false);
                    onTransition(t);
                  }}
                >
                  <span
                    className="rcd-state-dot"
                    style={toColor ? { background: toColor } : undefined}
                  />
                  <span className="asgn-option-info">
                    <span className="asgn-option-name">
                      {t.label !== "" ? t.label : (toState?.label ?? t.toState)}
                    </span>
                    {t.requiresComment && (
                      <span className="asgn-option-email">
                        Comment required
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("amount" in obj && "currency" in obj)
      return `${String(obj.currency)} ${String(obj.amount)}`;
    return JSON.stringify(value);
  }
  return String(value);
}

/* ══════════════════════════════════════════════════════════════ */
export function CustomerRecordDetail(): React.ReactElement {
  const { typeSlug, id } = useParams<{ typeSlug: string; id: string }>();
  const navigate = useNavigate();
  const { getTypeBySlug } = useEntityTypes();
  const entityType = typeSlug ? getTypeBySlug(typeSlug) : undefined;
  const entityTypeId = entityType?.id;

  const [fields, setFields] = useState<EntityField[]>([]);
  const [record, setRecord] = useState<EntityInstance | null>(null);
  // getTypeBySlug does a naive first-match lookup — if two entity types
  // share a slug, it can resolve to the wrong one. Once the record itself
  // has loaded, its own entityTypeId is authoritative and overrides the
  // slug-derived guess (which only serves as the value for the very first
  // fetch, before we know which record we're looking at).
  const effectiveEntityTypeId = record?.entityTypeId ?? entityTypeId;
  const [comments, setComments] = useState<WorkflowEvent[]>([]);
  const [historyEvents, setHistoryEvents] = useState<WorkflowEvent[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noAccess, setNoAccess] = useState(false);
  const [accessRequestState, setAccessRequestState] = useState<
    "idle" | "submitting" | "sent" | "error"
  >("idle");
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
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [_maxChildDepth, setMaxChildDepth] = useState<number>(1);
  const [workflowCreatedBy, setWorkflowCreatedBy] = useState<string | null>(
    null,
  );
  const [workflowAssignedTo, setWorkflowAssignedTo] = useState<string[]>([]);
  const [currentState, setCurrentState] = useState("");
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "comments" | "history" | "access-requests"
  >("comments");
  const [quickAssigning, setQuickAssigning] = useState(false);
  const [replyTo, setReplyTo] = useState<WorkflowEvent | null>(null);
  const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(
    new Set(),
  );
  const initializedCollapse = useRef(false);
  const commentsScrollRef = useRef<HTMLDivElement>(null);
  const historyScrollRef = useRef<HTMLDivElement>(null);

  // File attachments
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [previewFile, setPreviewFile] = useState<AttachmentFile | null>(null);
  const [attachUploading, setAttachUploading] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  // Child tickets state
  const [children, setChildren] = useState<ChildInstance[]>([]);
  const [childrenLoading, setChildrenLoading] = useState(false);
  const [parentRecord, setParentRecord] = useState<{
    id: string;
    title: string;
    typeSlug: string;
  } | null>(null);
  const [showCreateChild, setShowCreateChild] = useState(false);
  const [newChildTitle, setNewChildTitle] = useState("");
  const [newChildAssignedTo, setNewChildAssignedTo] = useState("");
  const [newChildDueDate, setNewChildDueDate] = useState("");
  const [newChildDescription, setNewChildDescription] = useState("");
  const [creatingChild, setCreatingChild] = useState(false);
  const [createChildError, setCreateChildError] = useState<string | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<{
    childCount: number;
  } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // Access list — persisted from API as {userId, level, tag}[]
  type AccessLevel = "read_only" | "read_comment" | "read_write";
  type AccessTag = "creator" | "assigned" | "mention" | "manual";
  type AccessEntry = { userId: string; level: AccessLevel; tag: AccessTag };
  const [accessList, setAccessList] = useState<AccessEntry[]>([]);

  // Access change modal (revoke / change level)
  const [accessChangeModal, setAccessChangeModal] = useState<{
    userId: string;
    displayName: string;
    currentLevel: AccessLevel;
    isAssigned: boolean;
    isCreator: boolean;
  } | null>(null);
  const [accessChangeSelection, setAccessChangeSelection] = useState<
    AccessLevel | "remove"
  >("read_comment");
  const [accessChangeSaving, setAccessChangeSaving] = useState(false);

  // Pending mention-grant: comment waiting for access level confirmation
  const [pendingMentionGrant, setPendingMentionGrant] = useState<{
    text: string;
    mentions: string[]; // all mention userIds
    replyTo: string | null;
    newUsers: OrgUser[]; // users without existing access
    selectedLevel: AccessLevel; // level to grant new users
    fileIds?: string[];
  } | null>(null);
  const [currentUserRoles, setCurrentUserRoles] = useState<string[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [oidcLoaded, setOidcLoaded] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  // Access requests
  type AccessRequest = {
    id: string;
    requesterId: string;
    requestedLevel: AccessLevel;
    status: "pending" | "approved" | "rejected";
    resolvedBy: string | null;
    resolvedAt: string | null;
    createdAt: string;
  };
  const [accessReqList, setAccessReqList] = useState<AccessRequest[]>([]);
  const [accessReqLoaded, setAccessReqLoaded] = useState(false);
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [confirmReqLevel, setConfirmReqLevel] = useState<AccessLevel | null>(
    null,
  );
  const [myAccessReqStatus, setMyAccessReqStatus] = useState<
    "none" | "pending" | "approved" | "rejected"
  >("none");
  // resolve popup
  const [resolveModal, setResolveModal] = useState<{
    reqId: string;
    requesterId: string;
    currentRequestedLevel: AccessLevel;
  } | null>(null);
  const [resolveLevel, setResolveLevel] = useState<AccessLevel>("read_comment");
  const [resolveSaving, setResolveSaving] = useState(false);
  useEffect(() => {
    userManager
      .getUser()
      .then((u) => {
        if (!u) return;
        const roleClaim = u.profile["urn:zitadel:iam:org:project:roles"] as
          | Record<string, unknown>
          | undefined;
        setCurrentUserRoles(roleClaim ? Object.keys(roleClaim) : []);
        // Inject the current user into the users list so their name always resolves,
        // even when the /users API treats them as a ghost entry (no email/displayName in DB).
        const sub = u.profile.sub as string | undefined;
        const name =
          (u.profile.name as string | undefined) ??
          (u.profile.preferred_username as string | undefined) ??
          (u.profile.email as string | undefined) ??
          null;
        const email = (u.profile.email as string | undefined) ?? "";
        if (sub) {
          setCurrentUserId(sub);
          setUsers((prev) => {
            if (prev.some((p) => p.userId === sub)) return prev;
            return [
              ...prev,
              {
                userId: sub,
                email,
                displayName: name,
                loginName: email || sub,
              },
            ];
          });
        }
        setOidcLoaded(true);
      })
      .catch(() => {
        setOidcLoaded(true);
      });
  }, []);
  // A workflow admin (this ticket's workflow creator, or in its assigned_to
  // list) gets the same full access as a global admin/agent — ticket edit,
  // access updates, sub-ticket creation, everything gated by isAdminOrAgent
  // below. Matches the backend (assertRecordWorkflowAccess et al.).
  const isWorkflowAdminOfParent =
    currentUserId !== null &&
    (currentUserId === workflowCreatedBy ||
      workflowAssignedTo.includes(currentUserId));
  const isAdminOrAgent =
    currentUserRoles.includes("admin") ||
    currentUserRoles.includes("agent") ||
    isWorkflowAdminOfParent;

  // Current user's access entry (null for admins/agents — they bypass access list)
  const myAccessEntry =
    !isAdminOrAgent && currentUserId
      ? (accessList.find((e) => e.userId === currentUserId) ?? null)
      : null;
  // Can post comments: admin/agent always; user needs read_comment or read_write level
  const canComment =
    isAdminOrAgent ||
    myAccessEntry?.level === "read_comment" ||
    myAccessEntry?.level === "read_write";

  // Creator or assignee — may see and resolve access requests
  const isOwner =
    currentUserId !== null &&
    (record?.createdBy === currentUserId ||
      record?.assignedTo === currentUserId);

  // Derived: true when viewing a child ticket (has a parent)
  const isChildTicket = !!record?.parentId;

  // Child tickets use a fixed 3-state machine regardless of parent workflow
  const CHILD_TICKET_STATES: WorkflowState[] = [
    {
      id: "child-open",
      name: "open",
      label: "Open",
      color: "#6366f1",
      isTerminal: false,
    },
    {
      id: "child-in-progress",
      name: "in-progress",
      label: "In Progress",
      color: "#f59e0b",
      isTerminal: false,
    },
    {
      id: "child-closed",
      name: "closed",
      label: "Closed",
      color: "#10b981",
      isTerminal: true,
    },
  ];
  const effectiveStates = isChildTicket ? CHILD_TICKET_STATES : allStates;

  // Synthetic transitions for child tickets (direct state changes via PATCH, no workflow engine)
  const CHILD_TICKET_TRANSITIONS: Transition[] = [
    {
      id: "ct-open-inprogress",
      fromState: "open",
      toState: "in-progress",
      label: "Start",
      requiresComment: false,
    },
    {
      id: "ct-open-closed",
      fromState: "open",
      toState: "closed",
      label: "Close",
      requiresComment: false,
    },
    {
      id: "ct-inprogress-open",
      fromState: "in-progress",
      toState: "open",
      label: "Reopen",
      requiresComment: false,
    },
    {
      id: "ct-inprogress-closed",
      fromState: "in-progress",
      toState: "closed",
      label: "Close",
      requiresComment: false,
    },
    {
      id: "ct-closed-open",
      fromState: "closed",
      toState: "open",
      label: "Reopen",
      requiresComment: false,
    },
    {
      id: "ct-closed-inprogress",
      fromState: "closed",
      toState: "in-progress",
      label: "Restart",
      requiresComment: false,
    },
  ];
  const effectiveTransitions = isChildTicket
    ? CHILD_TICKET_TRANSITIONS
    : transitions;

  // Access control — derived from accessList (loaded upfront, no history needed)
  const creatorId = accessList.find((e) => e.tag === "creator")?.userId ?? null;
  const canChangeState =
    isAdminOrAgent ||
    (currentUserId !== null &&
      (currentUserId === creatorId || currentUserId === record?.assignedTo));
  const canChangeAssignedTo =
    isAdminOrAgent || (currentUserId !== null && currentUserId === creatorId);

  // isAdminOrAgent already includes workflow-admin status (see its definition).
  const canCreateChild = isAdminOrAgent;

  async function handleAccessChange(): Promise<void> {
    if (!id || !accessChangeModal) return;
    setAccessChangeSaving(true);
    try {
      const { userId: targetId } = accessChangeModal;
      if (accessChangeSelection === "remove") {
        await fetchWithAuth(`${API_URL}/entities/${id}/access/${targetId}`, {
          method: "DELETE",
        });
        setAccessList((prev) => prev.filter((e) => e.userId !== targetId));
        if (record?.assignedTo === targetId) {
          setRecord((prev) => (prev ? { ...prev, assignedTo: null } : prev));
        }
      } else {
        await fetchWithAuth(`${API_URL}/entities/${id}/access/${targetId}`, {
          method: "PATCH",
          body: JSON.stringify({ level: accessChangeSelection }),
        });
        setAccessList((prev) =>
          prev.map((e) =>
            e.userId === targetId
              ? { ...e, level: accessChangeSelection as AccessLevel }
              : e,
          ),
        );
        if (
          record?.assignedTo === targetId &&
          accessChangeSelection !== "read_write"
        ) {
          setRecord((prev) => (prev ? { ...prev, assignedTo: null } : prev));
        }
      }
      setAccessChangeModal(null);
    } finally {
      setAccessChangeSaving(false);
    }
  }

  function toggleThread(id: string): void {
    setCollapsedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
    // If displayName is the raw userId (UUID), fall through to email/loginName
    const display =
      u.displayName && u.displayName !== actorId ? u.displayName : null;
    return display ?? u.loginName ?? (u.email || actorId.slice(0, 8) + "…");
  };

  // Prefer backend-resolved display name; fall back to local users list when
  // backend could only resolve a truncated ID (ends with "…", no real name).
  const resolveActorName = (
    actorDisplayName: string | null | undefined,
    actorId: string | null,
  ): string => {
    const fromList = actorId ? getActorName(actorId) : null;
    // If backend gave us a real name (not just a truncated ID), prefer it.
    if (actorDisplayName && !actorDisplayName.endsWith("…"))
      return actorDisplayName;
    // If local users list has a real name, prefer that over the truncated ID.
    if (fromList && !fromList.endsWith("…")) return fromList;
    return actorDisplayName ?? fromList ?? "Unknown";
  };

  function loadRecord(): Promise<void> {
    if (!id) return Promise.resolve();
    setError(null);
    setNoAccess(false);
    // Fetch the record first — its own entityTypeId is authoritative, unlike
    // the slug-derived guess (which can resolve to the wrong entity type if
    // two share a slug). Fetching fields off the record's real entityTypeId,
    // sequentially rather than as a reactive dependency, avoids a setRecord(null)
    // → effectiveEntityTypeId flips back to the guess → re-fires effect loop.
    let recordFetchFailed = false;
    return fetchWithAuth(`${API_URL}/entities/${id}`)
      .catch((err: unknown) => {
        recordFetchFailed = true;
        throw err;
      })
      .then((recRes) => {
        const rec = (recRes as { data: EntityInstance }).data;
        return Promise.all([
          fetchWithAuth(`${API_URL}/entity-types/${rec.entityTypeId}/fields`),
          Promise.resolve(recRes),
          fetchWithAuth(`${API_URL}/users`).catch(() => ({ data: [] })),
          fetchWithAuth(`${API_URL}/entities/${id}/access`).catch(() => ({
            data: [],
          })),
        ]);
      })
      .then(([fieldsRes, recRes, usersRes, accessRes]) => {
        setFields(
          (fieldsRes as { data: EntityField[] }).data.filter(
            (f) => !f.isSystem,
          ),
        );
        setRecord((recRes as { data: EntityInstance }).data);
        const apiUsers =
          (
            usersRes as {
              data?: Array<{
                userId: string;
                email: string;
                displayName: string | null;
                loginName?: string;
              }>;
            }
          ).data ?? [];
        // Merge API users with any already-injected entries (e.g. current OIDC user)
        setUsers((prev) => {
          const apiIds = new Set(apiUsers.map((u) => u.userId));
          return [...apiUsers, ...prev.filter((u) => !apiIds.has(u.userId))];
        });
        setAccessList((accessRes as { data?: AccessEntry[] }).data ?? []);
      })
      .catch((err: unknown) => {
        const status = (err as { status?: number } | undefined)?.status;
        if (recordFetchFailed && status === 404) {
          setNoAccess(true);
        } else {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      })
      .finally(() => setLoading(false));
  }

  async function refreshAll(): Promise<void> {
    if (manualRefreshing) return;
    setManualRefreshing(true);
    try {
      await Promise.all([
        loadRecord(),
        refreshComments(),
        refreshAttachments(),
        loadChildren(),
        historyLoaded ? refreshHistory() : Promise.resolve(),
      ]);
    } finally {
      setManualRefreshing(false);
    }
  }

  async function requestRecordAccess(): Promise<void> {
    if (!id) return;
    setAccessRequestState("submitting");
    try {
      await fetchWithAuth(`${API_URL}/entities/${id}/access-requests`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setAccessRequestState("sent");
    } catch {
      setAccessRequestState("error");
    }
  }

  async function loadComments(): Promise<void> {
    if (!id) return;
    const res = await fetchWithAuth(
      `${API_URL}/entities/${id}/transitions/history?eventType=comment`,
    ).catch(() => ({ data: [] }));
    setComments((res as { data?: WorkflowEvent[] }).data ?? []);
  }

  async function loadHistory(): Promise<void> {
    if (!id || historyLoaded) return;
    setHistoryLoading(true);
    try {
      const res = await fetchWithAuth(
        `${API_URL}/entities/${id}/transitions/history?eventType=history`,
      ).catch(() => ({ data: [] }));
      setHistoryEvents((res as { data?: WorkflowEvent[] }).data ?? []);
      setHistoryLoaded(true);
    } finally {
      setHistoryLoading(false);
    }
  }

  // Collapse all parent threads on first load (and after a full reload)
  useEffect(() => {
    if (comments.length === 0) return;
    const parentIds = new Set(
      comments
        .map(
          (c) =>
            (c.metadata as { replyTo?: string | null } | undefined)?.replyTo ??
            null,
        )
        .filter((id): id is string => id !== null),
    );
    if (parentIds.size === 0) return;
    if (!initializedCollapse.current) {
      initializedCollapse.current = true;
      setCollapsedThreads(parentIds);
    }
  }, [comments]);

  // Auto-scroll comments to bottom when first loaded
  useEffect(() => {
    if (comments.length === 0) return;
    const el = commentsScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [comments]);

  // Auto-scroll history to bottom when first loaded
  useEffect(() => {
    if (!historyLoaded || historyEvents.length === 0) return;
    const el = historyScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [historyLoaded, historyEvents]);

  async function refreshComments(): Promise<void> {
    await loadComments();
  }

  async function refreshHistory(): Promise<void> {
    if (!id) return;
    setHistoryLoaded(false);
    setHistoryLoading(true);
    try {
      const res = await fetchWithAuth(
        `${API_URL}/entities/${id}/transitions/history?eventType=history`,
      ).catch(() => ({ data: [] }));
      setHistoryEvents((res as { data?: WorkflowEvent[] }).data ?? []);
      setHistoryLoaded(true);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function refreshAttachments(): Promise<void> {
    if (!id) return;
    setAttachmentsLoading(true);
    try {
      const res = (await fetchWithAuth(
        `${API_URL}/entities/${id}/attachments`,
      )) as { data: AttachmentFile[] };
      setAttachments(res.data);
    } catch {
      /* best-effort */
    } finally {
      setAttachmentsLoading(false);
    }
  }

  async function loadChildren(): Promise<void> {
    if (!id) return;
    setChildrenLoading(true);
    try {
      const res = await fetchWithAuth(
        `${API_URL}/entities/${id}/children`,
      ).catch(() => ({ data: [] }));
      setChildren((res as { data: ChildInstance[] }).data);
    } finally {
      setChildrenLoading(false);
    }
  }

  async function loadParentRecord(parentId: string): Promise<void> {
    try {
      const res = await fetchWithAuth(`${API_URL}/entities/${parentId}`).catch(
        () => null,
      );
      if (!res) return;
      const inst = (res as { data: EntityInstance }).data;
      const titleField = ["subject", "title", "name"].find(
        (k) => inst.fields[k],
      );
      const title = titleField
        ? String(inst.fields[titleField])
        : `#${parentId.slice(0, 8)}`;
      setParentRecord({ id: parentId, title, typeSlug: typeSlug ?? "" });
    } catch {
      /* best-effort */
    }
  }

  async function loadAccessRequests(): Promise<void> {
    if (!id) return;
    try {
      const res = await fetchWithAuth(
        `${API_URL}/entities/${id}/access-requests`,
      );
      const rows = (res as { data: AccessRequest[] }).data;
      setAccessReqList(rows);
    } catch {
      setAccessReqList([]);
    } finally {
      setAccessReqLoaded(true);
    }
  }

  async function submitAccessRequest(
    level: AccessLevel = "read_comment",
  ): Promise<void> {
    if (!id || requestingAccess) return;
    setRequestingAccess(true);
    try {
      await fetchWithAuth(`${API_URL}/entities/${id}/access-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestedLevel: level }),
      });
      setMyAccessReqStatus("pending");
    } catch {
      /* best-effort */
    } finally {
      setRequestingAccess(false);
    }
  }

  async function resolveAccessRequest(
    reqId: string,
    action: "approve" | "reject",
    level: AccessLevel,
  ): Promise<void> {
    if (!id) return;
    setResolveSaving(true);
    try {
      await fetchWithAuth(
        `${API_URL}/entities/${id}/access-requests/${reqId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, level }),
        },
      );
      setAccessReqList((prev) =>
        prev.map((r) =>
          r.id === reqId
            ? { ...r, status: action === "approve" ? "approved" : "rejected" }
            : r,
        ),
      );
      if (action === "approve") {
        const requesterId = accessReqList.find(
          (r) => r.id === reqId,
        )?.requesterId;
        if (requesterId) {
          setAccessList((prev) => {
            const existing = prev.find((e) => e.userId === requesterId);
            if (existing) {
              return prev.map((e) =>
                e.userId === requesterId ? { ...e, level } : e,
              );
            }
            return [...prev, { userId: requesterId, level, tag: "manual" }];
          });
        }
      }
      setResolveModal(null);
    } catch {
      /* best-effort */
    } finally {
      setResolveSaving(false);
    }
  }

  async function createChild(): Promise<void> {
    if (!id || !effectiveEntityTypeId || !newChildTitle.trim()) return;
    setCreatingChild(true);
    setCreateChildError(null);
    try {
      const childFields: Record<string, string> = {
        title: newChildTitle.trim(),
      };
      if (newChildDueDate) childFields.dueDate = newChildDueDate;
      if (newChildDescription.trim())
        childFields.description = newChildDescription.trim();
      await fetchWithAuth(`${API_URL}/entities/${id}/children`, {
        method: "POST",
        body: JSON.stringify({
          entityTypeId: effectiveEntityTypeId,
          fields: childFields,
          ...(newChildAssignedTo ? { assignedTo: newChildAssignedTo } : {}),
        }),
      });
      setNewChildTitle("");
      setNewChildAssignedTo("");
      setNewChildDueDate("");
      setNewChildDescription("");
      setShowCreateChild(false);
      void loadChildren();
    } catch (err) {
      setCreateChildError(
        err instanceof Error ? err.message : "Failed to create sub-task",
      );
    } finally {
      setCreatingChild(false);
    }
  }

  async function detachParent(): Promise<void> {
    if (!id) return;
    try {
      await fetchWithAuth(`${API_URL}/entities/${id}/parent`, {
        method: "PATCH",
        body: JSON.stringify({ parentId: null }),
      });
      setParentRecord(null);
      void loadRecord();
    } catch {
      /* ignore */
    }
  }

  async function archiveRecord(confirmed = false): Promise<void> {
    if (!id) return;
    setArchiving(true);
    try {
      const url = confirmed
        ? `${API_URL}/entities/${id}/archive?confirm=true`
        : `${API_URL}/entities/${id}/archive`;
      const res = await fetchWithAuth(url, { method: "POST" });
      const body = res as {
        data: {
          requiresConfirm?: boolean;
          childCount?: number;
          archived?: boolean;
        };
      };
      if (body.data.requiresConfirm) {
        setArchiveConfirm({ childCount: body.data.childCount ?? 0 });
      } else {
        setArchiveConfirm(null);
        void loadRecord();
      }
    } catch (err) {
      setTransError(err instanceof Error ? err.message : "Archive failed");
    } finally {
      setArchiving(false);
    }
  }

  async function restoreRecord(): Promise<void> {
    if (!id) return;
    setRestoring(true);
    try {
      await fetchWithAuth(`${API_URL}/entities/${id}/restore`, {
        method: "POST",
      });
      void loadRecord();
    } catch (err) {
      setTransError(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoring(false);
    }
  }

  async function doSubmitComment(
    text: string,
    mentionEntries: Array<{ userId: string; level: AccessLevel }>,
    replyTo: string | null,
    fileIds: string[],
  ): Promise<void> {
    if (!id) return;
    await fetchWithAuth(`${API_URL}/entities/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({
        text,
        mentions: mentionEntries,
        replyTo,
        fileIds,
      }),
    });
    // Optimistically add newly-granted users to local access list
    for (const m of mentionEntries) {
      if (!accessList.some((e) => e.userId === m.userId)) {
        setAccessList((prev) => [
          ...prev,
          { userId: m.userId, level: m.level, tag: "mention" },
        ]);
      }
    }
    await refreshComments();
    if (fileIds.length > 0) await refreshAttachments();
  }

  async function submitComment(
    text: string,
    mentionIds: string[],
    replyTo: string | null,
    fileIds: string[] = [],
  ): Promise<void> {
    if (!id) return;
    const existingIds = new Set(accessList.map((e) => e.userId));
    const newToAccess = mentionIds.filter((uid) => !existingIds.has(uid));
    if (newToAccess.length > 0) {
      const newUsers = users.filter((u) => newToAccess.includes(u.userId));
      setPendingMentionGrant({
        text,
        mentions: mentionIds,
        replyTo,
        newUsers,
        selectedLevel: "read_comment",
        fileIds,
      });
      return;
    }
    // All mentioned users already have access — post directly
    const mentionEntries = mentionIds.map((uid) => {
      const existing = accessList.find((e) => e.userId === uid);
      return {
        userId: uid,
        level: (existing?.level ?? "read_comment") as AccessLevel,
      };
    });
    await doSubmitComment(text, mentionEntries, replyTo, fileIds);
  }

  useEffect(() => {
    // Clear all derived state immediately so the UI shows the spinner rather
    // than the previous record's data while the new one loads.
    setLoading(true);
    setRecord(null);
    setComments([]);
    setChildren([]);
    setChildrenLoading(false);
    setHistoryEvents([]);
    setHistoryLoaded(false);
    setAttachments([]);
    setParentRecord(null);
    setAccessDenied(false);
    setError(null);
    initializedCollapse.current = false;
    void loadRecord().then(() => {
      void loadComments();
      void refreshAttachments();
    });
  }, [id]);

  // Access-denied check: once both the record and OIDC identity are loaded,
  // verify the general user is in the ticket's access list.
  useEffect(() => {
    if (!oidcLoaded || loading || isAdminOrAgent) return;
    if (currentUserId === null) return;
    if (accessList.length === 0) return;
    if (!accessList.some((e) => e.userId === currentUserId)) {
      setAccessDenied(true);
    }
  }, [oidcLoaded, loading, currentUserId, isAdminOrAgent, accessList]);

  // Load access requests when owner (creator/assignee)
  useEffect(() => {
    if (isOwner && id) void loadAccessRequests();
  }, [isOwner, id]);

  // Sync requester's own request status
  useEffect(() => {
    if (!currentUserId || accessDenied) return;
    const mine = accessReqList.find((r) => r.requesterId === currentUserId);
    setMyAccessReqStatus(mine ? mine.status : "none");
  }, [accessReqList, currentUserId, accessDenied]);

  useEffect(() => {
    if (!record) return;
    void loadChildren();
    if (record.parentId) {
      void loadParentRecord(record.parentId);
    } else {
      setParentRecord(null);
    }
  }, [record?.id, record?.parentId]);

  useEffect(() => {
    if (!record?.workflowId && !effectiveEntityTypeId) {
      setAllStates([]);
      return;
    }

    const wfUrl = record?.workflowId
      ? `${API_URL}/workflows/${record.workflowId}`
      : `${API_URL}/workflows?${new URLSearchParams({ entityTypeId: effectiveEntityTypeId ?? "" }).toString()}`;

    fetchWithAuth(wfUrl)
      .then((res) => {
        const wf = record?.workflowId
          ? (
              res as {
                data: {
                  states: WorkflowState[];
                  transitions: Transition[];
                  maxChildDepth?: number;
                  createdBy?: string | null;
                  assignedTo?: string[] | null;
                };
              }
            ).data
          : ((
              res as {
                data?: Array<{
                  states?: WorkflowState[];
                  transitions?: Transition[];
                  maxChildDepth?: number;
                  createdBy?: string | null;
                  assignedTo?: string[] | null;
                }>;
              }
            ).data ?? [])[0];
        if (wf) {
          setAllStates(wf.states as WorkflowState[]);
          setTransitions(wf.transitions as Transition[]);
          setMaxChildDepth(
            (wf as { maxChildDepth?: number }).maxChildDepth ?? 1,
          );
          setWorkflowCreatedBy(wf.createdBy ?? null);
          setWorkflowAssignedTo(wf.assignedTo ?? []);
        } else {
          setAllStates([]);
          setTransitions([]);
          setWorkflowCreatedBy(null);
          setWorkflowAssignedTo([]);
        }
      })
      .catch(() => {
        setAllStates([]);
      });
  }, [record?.workflowId, effectiveEntityTypeId]);

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

  async function quickAssign(userId: string): Promise<void> {
    if (!id) return;
    setQuickAssigning(true);
    try {
      await fetchWithAuth(`${API_URL}/entities/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ assignedTo: userId || null }),
      });
      void loadRecord();
    } finally {
      setQuickAssigning(false);
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
      if (isChildTicket && transition.id.startsWith("ct-")) {
        // Child ticket: no workflow transitions — update state directly via PATCH
        await fetchWithAuth(`${API_URL}/entities/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ currentState: transition.toState }),
        });
      } else {
        await fetchWithAuth(`${API_URL}/entities/${id}/transitions`, {
          method: "POST",
          body: JSON.stringify({
            transitionId: transition.id,
            ...(userComment ? { comment: userComment } : {}),
          }),
        });
      }
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

  if (noAccess) {
    return (
      <div className="rcd-page">
        <div className="rd-no-access">
          <h2 className="rd-no-access-title">
            You don't have access to this record
          </h2>
          <p className="rd-muted">
            Ask an admin or agent to grant you access, or request it below.
          </p>
          {accessRequestState === "sent" ? (
            <div className="portal-alert-success" style={{ marginTop: "12px" }}>
              Access request sent — you'll be notified once it's reviewed.
            </div>
          ) : (
            <button
              type="button"
              className="portal-btn-primary"
              style={{ marginTop: "12px" }}
              disabled={accessRequestState === "submitting"}
              onClick={() => void requestRecordAccess()}
            >
              {accessRequestState === "submitting"
                ? "Requesting…"
                : "Request Access"}
            </button>
          )}
          {accessRequestState === "error" && (
            <div className="portal-alert-error" style={{ marginTop: "12px" }}>
              Failed to send request. Try again.
            </div>
          )}
        </div>
        {/* navigate(-1) exits the app / goes nowhere useful for a direct-URL
            or bookmarked entry point with no back-stack (G-1, PR #152
            review) — link to the record list instead, matching the
            portal's equivalent no-access screen. */}
        <Link
          to={`/records/${typeSlug ?? ""}`}
          className="portal-back-link"
          style={{ marginTop: "16px", display: "inline-block" }}
        >
          ← Back
        </Link>
      </div>
    );
  }

  if (error || !record) {
    return (
      <div className="rcd-page">
        <div className="portal-alert-error">{error ?? "Record not found"}</div>
        <button
          type="button"
          className="portal-back-link"
          style={{
            marginTop: "12px",
            display: "inline-block",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
          onClick={() => navigate(-1)}
        >
          ← Back
        </button>
      </div>
    );
  }

  const commentEvents = comments.filter((e) => e.metadata?.type === "comment");
  const timelineEvents = historyEvents.filter(
    (e) => e.metadata?.type !== "comment",
  );
  const sortedAll = [...historyEvents].sort(
    (a, b) =>
      new Date(a.triggeredAt).getTime() - new Date(b.triggeredAt).getTime(),
  );

  // Build a proper comment tree: each node knows its direct children
  const sortedComments = [...commentEvents].sort(
    (a, b) =>
      new Date(a.triggeredAt).getTime() - new Date(b.triggeredAt).getTime(),
  );
  const commentById = new Map(sortedComments.map((c) => [c.id, c]));

  // childrenOf[parentId] = direct children in chronological order
  const childrenOf = new Map<string, WorkflowEvent[]>();
  const topLevelComments: WorkflowEvent[] = [];
  for (const c of sortedComments) {
    const parentId =
      (c.metadata as { replyTo?: string | null } | undefined)?.replyTo ?? null;
    if (parentId && commentById.has(parentId)) {
      const arr = childrenOf.get(parentId) ?? [];
      arr.push(c);
      childrenOf.set(parentId, arr);
    } else {
      topLevelComments.push(c);
    }
  }

  const titleField = fields.find(
    (f) => f.name === "subject" || f.name === "title" || f.name === "name",
  );
  const recordTitle = titleField
    ? String(record.fields[titleField.name] ?? "")
    : `${entityType?.name ?? "Record"} #${record.id.slice(0, 8)}`;

  const createdByEvent = historyEvents.find(
    (e) => e.metadata?.type === "create",
  );

  // Merge access list entries with local user metadata
  const accessUsers: Array<OrgUser & { level: AccessLevel; tag: AccessTag }> =
    accessList
      .map((entry) => {
        const u = users.find((u) => u.userId === entry.userId);
        if (!u) return null;
        return { ...u, level: entry.level, tag: entry.tag };
      })
      .filter(
        (u): u is OrgUser & { level: AccessLevel; tag: AccessTag } =>
          u !== null,
      );

  function renderCommentBubble(event: WorkflowEvent): React.ReactElement {
    const meta = event.metadata;
    const commentText =
      (meta as { text?: string } | undefined)?.text ?? event.comment ?? "";
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
      <>
        <span className="rcd-feed-avatar">
          {(event.actorDisplayName ?? event.actorId).slice(0, 1).toUpperCase()}
        </span>
        <div className="rcd-feed-comment-body">
          <div className="rcd-feed-comment-meta">
            <span className="rcd-feed-comment-author">
              {event.actorDisplayName ?? event.actorId.slice(0, 8) + "…"}
            </span>
            <span className="rcd-feed-comment-time">
              {new Date(event.triggeredAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            {canComment && (
              <button
                type="button"
                className="rcd-reply-btn"
                onClick={() => {
                  setReplyTo(event);
                  setActiveTab("comments");
                }}
                title="Reply"
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
            )}
          </div>
          <div className="rcd-feed-comment-text">{renderText()}</div>
          {(() => {
            const commentFileIds: string[] = Array.isArray(
              (meta as { fileIds?: unknown }).fileIds,
            )
              ? (meta as { fileIds: string[] }).fileIds
              : [];
            if (commentFileIds.length === 0) return null;
            return (
              <div className="cmt-file-chips">
                {commentFileIds.map((fid) => {
                  const file = attachments.find((a) => a.id === fid);
                  if (!file) return null;
                  return (
                    <FileChip
                      key={fid}
                      file={file}
                      onPreview={setPreviewFile}
                      canDelete={false}
                    />
                  );
                })}
              </div>
            );
          })()}
        </div>
      </>
    );
  }

  function renderCommentNode(
    event: WorkflowEvent,
    depth: number,
  ): React.ReactElement {
    const children = childrenOf.get(event.id) ?? [];
    const hasChildren = children.length > 0;
    const collapsed = collapsedThreads.has(event.id);

    return (
      <div className={depth === 0 ? "rcd-comment-root" : "rcd-comment-child"}>
        <div className="rcd-comment-row">
          {renderCommentBubble(event)}
          {hasChildren && (
            <button
              type="button"
              className={`rcd-thread-toggle ${collapsed ? "rcd-thread-toggle-collapsed" : ""}`}
              onClick={() => toggleThread(event.id)}
              title={
                collapsed
                  ? `Show ${children.length} repl${children.length === 1 ? "y" : "ies"}`
                  : "Collapse replies"
              }
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
                <polyline points="6 9 12 15 18 9" />
              </svg>
              <span>{collapsed ? children.length : ""}</span>
            </button>
          )}
        </div>
        {hasChildren && !collapsed && (
          <div className="rcd-comment-children">
            {children.map((child) => (
              <React.Fragment key={child.id}>
                {renderCommentNode(child, depth + 1)}
              </React.Fragment>
            ))}
          </div>
        )}
        {hasChildren && collapsed && (
          <div
            className="rcd-comment-collapsed-hint"
            onClick={() => toggleThread(event.id)}
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
              <polyline points="6 9 12 15 18 9" />
            </svg>
            {children.length} repl{children.length === 1 ? "y" : "ies"} hidden
          </div>
        )}
      </div>
    );
  }

  function renderFeedEvent(event: WorkflowEvent): React.ReactElement {
    const meta = event.metadata;
    const isCreate = meta?.type === "create";
    const isUpdate = meta?.type === "update";
    const isComment = meta?.type === "comment";
    const isAccessGrant = meta?.type === "access_grant";
    const isAccessUpdate = meta?.type === "access_update";
    const isAccessRevoke = meta?.type === "access_revoke";
    const isFileAttached = meta?.type === "file_attached";
    const isFileDeleted = meta?.type === "file_deleted";

    if (isComment) {
      return (
        <div key={event.id} className="rcd-feed-comment">
          {renderCommentBubble(event)}
        </div>
      );
    }

    if (isAccessGrant || isAccessUpdate || isAccessRevoke) {
      const actor = resolveActorName(event.actorDisplayName, event.actorId);
      const targetId = (meta as Record<string, unknown>)["targetUserId"] as
        | string
        | undefined;
      const target = targetId ? getActorName(targetId) : "someone";
      const levelMap: Record<string, string> = {
        read_only: "Read Only",
        read_comment: "Comment",
        read_write: "Full Access",
      };
      const level =
        levelMap[String((meta as Record<string, unknown>)["level"] ?? "")] ??
        String((meta as Record<string, unknown>)["level"] ?? "");
      return (
        <div key={event.id} className="rcd-feed-event">
          <div className="rcd-feed-event-icon-wrap">
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
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <div className="rcd-feed-event-line" />
          </div>
          <div className="rcd-feed-event-body">
            <span className="rcd-feed-event-text">
              <strong>{actor}</strong>{" "}
              {isAccessGrant && (
                <>
                  granted <strong>{target}</strong> access
                  {level ? ` (${level})` : ""}
                </>
              )}
              {isAccessUpdate && (
                <>
                  changed <strong>{target}</strong>'s access
                  {level ? ` to ${level}` : ""}
                </>
              )}
              {isAccessRevoke && (
                <>
                  removed <strong>{target}</strong>'s access
                </>
              )}
            </span>
            <div className="rcd-feed-event-time">
              {new Date(event.triggeredAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          </div>
        </div>
      );
    }

    if (isFileAttached || isFileDeleted) {
      const actor = resolveActorName(event.actorDisplayName, event.actorId);
      const fileName = String(
        (meta as Record<string, unknown>)["originalName"] ?? "a file",
      );
      return (
        <div key={event.id} className="rcd-feed-event">
          <div className="rcd-feed-event-icon-wrap">
            <div
              className={`rcd-tl-icon ${isFileDeleted ? "rcd-tl-icon-update" : "rcd-tl-icon-create"}`}
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
                {isFileDeleted ? (
                  <>
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="9" y1="13" x2="15" y2="13" />
                  </>
                ) : (
                  <>
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="12" y1="18" x2="12" y2="12" />
                    <line x1="9" y1="15" x2="15" y2="15" />
                  </>
                )}
              </svg>
            </div>
            <div className="rcd-feed-event-line" />
          </div>
          <div className="rcd-feed-event-body">
            <span className="rcd-feed-event-text">
              <strong>{actor}</strong> {isFileAttached ? "attached" : "deleted"}{" "}
              <strong>{fileName}</strong>
            </span>
            <div className="rcd-feed-event-time">
              {new Date(event.triggeredAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          </div>
        </div>
      );
    }

    const eventType = isCreate ? "create" : isUpdate ? "update" : "transition";
    return (
      <div key={event.id} className="rcd-feed-event">
        <div className="rcd-feed-event-icon-wrap">
          <HistoryIcon type={eventType} />
          <div className="rcd-feed-event-line" />
        </div>
        <div className="rcd-feed-event-body">
          {isCreate ? (
            <span className="rcd-feed-event-text">
              <strong>
                {resolveActorName(event.actorDisplayName, event.actorId)}
              </strong>{" "}
              created this record
            </span>
          ) : isUpdate ? (
            <div>
              <span className="rcd-feed-event-text">
                <strong>
                  {resolveActorName(event.actorDisplayName, event.actorId)}
                </strong>{" "}
                updated the record
              </span>
              {"changed" in (meta as Record<string, unknown>) &&
                typeof (meta as Record<string, unknown>)["changed"] ===
                  "object" &&
                (meta as Record<string, unknown>)["changed"] !== null &&
                Object.keys(
                  (meta as Record<string, unknown>)["changed"] as object,
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
                        <strong>{getFieldLabel(fieldName)}</strong>:{" "}
                        {fieldName === "assignedTo"
                          ? ((change["oldName"] as string | null) ??
                            getActorName(change["old"] as string | null))
                          : formatFieldValue(change["old"])}
                        {" → "}
                        {fieldName === "assignedTo"
                          ? ((change["newName"] as string | null) ??
                            getActorName(change["new"] as string | null))
                          : formatFieldValue(change["new"])}
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          ) : (
            <div className="rcd-feed-event-text">
              <strong>
                {resolveActorName(event.actorDisplayName, event.actorId)}
              </strong>{" "}
              moved{" "}
              {event.fromState && (
                <>
                  <span className="rcd-tl-state">{event.fromState}</span>
                  {" → "}
                </>
              )}
              <span className="rcd-tl-state rcd-tl-state-to">
                {event.toState}
              </span>
              {event.comment && (
                <div className="rcd-tl-comment" style={{ marginTop: "6px" }}>
                  "{event.comment}"
                </div>
              )}
            </div>
          )}
          <div className="rcd-feed-event-time">
            {new Date(event.triggeredAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rcd-page">
      {/* ── Access-denied overlay ────────────────────────── */}
      {accessDenied && (
        <div className="rcd-access-overlay">
          {confirmReqLevel !== null ? (
            <div className="rcd-access-modal">
              <h3 className="rcd-access-title">Request access?</h3>
              <p className="rcd-access-body">
                {confirmReqLevel === "read_comment"
                  ? "This will send a request to the ticket owner for comment access. They will be able to approve or decline."
                  : "This will send a request to the ticket owner for view access. They will be able to approve or decline."}
              </p>
              <div className="rcd-access-modal-actions">
                <button
                  type="button"
                  className="portal-btn-secondary"
                  onClick={() => setConfirmReqLevel(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="portal-btn-primary"
                  disabled={requestingAccess}
                  onClick={() => {
                    const lvl = confirmReqLevel;
                    setConfirmReqLevel(null);
                    void submitAccessRequest(lvl);
                  }}
                >
                  {requestingAccess ? "Sending…" : "Send Request"}
                </button>
              </div>
            </div>
          ) : (
            <div className="rcd-access-modal">
              <div className="rcd-access-icon">🔒</div>
              <h3 className="rcd-access-title">Access Restricted</h3>
              <p className="rcd-access-body">
                You don't have access to this ticket. You can request access
                from the ticket owner.
              </p>
              {myAccessReqStatus === "pending" ? (
                <div className="rcd-access-req-sent">
                  Access request sent — waiting for owner approval.
                </div>
              ) : myAccessReqStatus === "rejected" ? (
                <div className="rcd-access-req-rejected">
                  Your access request was declined. You may request again.
                </div>
              ) : null}
              <div className="rcd-access-modal-actions">
                <button
                  type="button"
                  className="portal-btn-secondary"
                  onClick={() => navigate(-1)}
                >
                  Go Back
                </button>
                {myAccessReqStatus !== "pending" && (
                  <button
                    type="button"
                    className="portal-btn-primary"
                    disabled={requestingAccess}
                    onClick={() => setConfirmReqLevel("read_only")}
                  >
                    {myAccessReqStatus === "rejected"
                      ? "Request Again"
                      : "Request Access"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Breadcrumb nav ───────────────────────────────── */}
      <div className="rcd-nav">
        <button
          type="button"
          className="rcd-bc-link"
          onClick={() => navigate(-1)}
        >
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
        </button>
        <span className="rcd-bc-sep">/</span>
        <span className="rcd-bc-current">{recordTitle}</span>
        <button
          type="button"
          className="rcd-refresh-btn"
          disabled={manualRefreshing}
          title="Refresh"
          onClick={() => void refreshAll()}
        >
          <svg
            className={manualRefreshing ? "rcd-refresh-spin" : undefined}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
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

      {/* ── Cards area ───────────────────────────────────── */}
      <div className="rcd-cards">
        {/* ══ CARD 1: Details ══════════════════════════════ */}
        <div className="rcd-card rcd-detail-card">
          {/* Card header: title + state + actions */}
          <div className="rcd-card-header">
            <div className="rcd-card-header-left">
              <h1 className="rcd-title">{recordTitle}</h1>
              <div className="rcd-card-header-meta">
                <StateBadge
                  stateName={record.currentState}
                  allStates={effectiveStates}
                />
                <span className="rcd-id-chip">{record.id.slice(0, 8)}</span>
              </div>
            </div>
            <div className="rcd-card-header-right">
              {!editing && isAdminOrAgent && record.deletedAt && (
                <button
                  type="button"
                  className="rcd-btn-secondary rcd-btn-restore"
                  disabled={restoring}
                  onClick={() => void restoreRecord()}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  {restoring ? "Restoring…" : "Restore"}
                </button>
              )}
              {!editing && isAdminOrAgent && !record.deletedAt && (
                <button
                  type="button"
                  className="rcd-btn-secondary rcd-btn-archive"
                  disabled={archiving}
                  onClick={() => void archiveRecord(false)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="21 8 21 21 3 21 3 8" />
                    <rect x="1" y="3" width="22" height="5" />
                    <line x1="10" y1="12" x2="14" y2="12" />
                  </svg>
                  {archiving ? "Archiving…" : "Archive"}
                </button>
              )}
              {!editing && isAdminOrAgent && !record.deletedAt && (
                <button
                  type="button"
                  className="rcd-btn-secondary"
                  onClick={() => {
                    setEditValues(record.fields);
                    setCurrentState(record.currentState ?? "");
                    setEditAssignedTo(record.assignedTo ?? "");
                    setSaveError(null);
                    setEditing(true);
                    setDetailsExpanded(true);
                  }}
                >
                  <svg
                    width="12"
                    height="12"
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
                  Edit
                </button>
              )}
              <button
                type="button"
                className={`rcd-expand-btn ${detailsExpanded ? "rcd-expand-btn-open" : ""}`}
                onClick={() => {
                  setDetailsExpanded((v) => !v);
                  if (editing) setEditing(false);
                }}
                aria-expanded={detailsExpanded}
                title={detailsExpanded ? "Collapse details" : "Expand details"}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>
          </div>

          {/* Always-visible info strip */}
          <div className="rcd-info-strip">
            {/* State */}
            <div className="rcd-info-item">
              <span className="rcd-info-lbl">State</span>
              <div className="rcd-info-val">
                <StateDropdown
                  currentState={record.currentState}
                  allStates={effectiveStates}
                  transitions={effectiveTransitions}
                  disabled={!!transitioning || !canChangeState}
                  onTransition={(t) => {
                    if (t.requiresComment) {
                      setStateModal(t);
                    } else {
                      void executeTransition(t);
                    }
                  }}
                />
              </div>
            </div>

            <div className="rcd-info-divider" />

            {/* Assigned to */}
            <div className="rcd-info-item">
              <span className="rcd-info-lbl">Assigned to</span>
              <div className="rcd-info-val">
                <AssignDropdown
                  value={record.assignedTo ?? ""}
                  users={users}
                  disabled={quickAssigning || !canChangeAssignedTo}
                  onChange={(userId) => void quickAssign(userId)}
                />
              </div>
            </div>

            <div className="rcd-info-divider" />

            {/* Created */}
            <div className="rcd-info-item">
              <span className="rcd-info-lbl">Created</span>
              <span className="rcd-info-val">
                {new Date(record.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
                {createdByEvent && (
                  <span className="rcd-info-by">
                    {" "}
                    by{" "}
                    {resolveActorName(
                      createdByEvent.actorDisplayName,
                      createdByEvent.actorId,
                    )}
                  </span>
                )}
              </span>
            </div>

            <div className="rcd-info-divider" />

            {/* Last updated */}
            <div className="rcd-info-item">
              <span className="rcd-info-lbl">Last updated</span>
              <span className="rcd-info-val">
                {new Date(record.updatedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            </div>

            <div className="rcd-info-divider" />

            {/* Type */}
            <div className="rcd-info-item">
              <span className="rcd-info-lbl">Type</span>
              <span className="rcd-info-val">{entityType?.name ?? "—"}</span>
            </div>
          </div>

          {/* Parent ticket chip — only for admin/agent; general users may not have access to parent */}
          {parentRecord && isAdminOrAgent && (
            <div className="rcd-parent-row">
              <span className="rcd-parent-label">Parent</span>
              <Link
                to={`/records/${parentRecord.typeSlug}/${parentRecord.id}`}
                className="rcd-parent-chip"
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
                  aria-hidden="true"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                {parentRecord.title}
              </Link>
              <button
                type="button"
                className="rcd-detach-btn"
                title="Detach from parent"
                onClick={() => void detachParent()}
              >
                ×
              </button>
            </div>
          )}

          {/* Expandable: all fields / edit form */}
          <div
            className={`rcd-expand-body ${detailsExpanded ? "rcd-expand-body-open" : ""}`}
          >
            <div className="rcd-expand-inner">
              {editing ? (
                <>
                  {saveError && (
                    <div
                      className="portal-alert-error"
                      style={{ marginBottom: "12px" }}
                    >
                      {saveError}
                    </div>
                  )}
                  <div className="portal-edit-grid">
                    {effectiveStates.length > 0 && (
                      <div className="portal-field-group portal-field-full">
                        <label className="portal-field-label">State</label>
                        <select
                          className="portal-input"
                          value={currentState}
                          onChange={(e) => setCurrentState(e.target.value)}
                        >
                          {effectiveStates.map((st) => (
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
                    {(isChildTicket
                      ? fields.filter((f) =>
                          /^(due_?date|due|description|desc)$/i.test(f.name),
                        )
                      : fields
                    ).map((f) => (
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
                </>
              ) : (
                <>
                  <div className="rcd-fields-grid">
                    {(isChildTicket
                      ? fields.filter((f) =>
                          /^(due_?date|due|description|desc)$/i.test(f.name),
                        )
                      : fields
                    ).map((f) => (
                      <div key={f.id} className="rcd-field-item">
                        <div className="rcd-field-lbl">{f.label}</div>
                        <div className="rcd-field-val">
                          <FieldValue
                            value={record.fields[f.name]}
                            fieldType={f.fieldType}
                            field={f}
                          />
                        </div>
                      </div>
                    ))}
                    {(isChildTicket
                      ? fields.filter((f) =>
                          /^(due_?date|due|description|desc)$/i.test(f.name),
                        )
                      : fields
                    ).length === 0 && (
                      <p
                        className="rcd-empty-hint"
                        style={{ padding: "0", gridColumn: "1/-1" }}
                      >
                        {isChildTicket
                          ? "No details set."
                          : "No custom fields defined."}
                      </p>
                    )}
                  </div>
                  {/* ── Attachments ─────────────────────────── */}
                  <div className="rcd-expand-attachments">
                    <div className="rcd-expand-attachments-hdr">
                      <span className="rcd-expand-attachments-title">
                        Attachments
                        {attachments.filter((a) => a.scanStatus !== "deleted")
                          .length > 0 && (
                          <span className="rcd-sidebar-count">
                            {
                              attachments.filter(
                                (a) => a.scanStatus !== "deleted",
                              ).length
                            }
                          </span>
                        )}
                      </span>
                    </div>
                    {attachmentsLoading ? (
                      <p className="rcd-sidebar-hint">Loading…</p>
                    ) : attachments.filter((a) => a.scanStatus !== "deleted")
                        .length > 0 ? (
                      <FileCardRow
                        files={attachments.filter(
                          (a) => a.scanStatus !== "deleted",
                        )}
                        onPreview={setPreviewFile}
                        canDelete={(file) =>
                          !!(
                            currentUserRoles.includes("admin") ||
                            currentUserRoles.includes("agent") ||
                            file.uploadedBy === currentUserId
                          )
                        }
                        onDelete={(fileId) => {
                          void (async () => {
                            try {
                              await fetchWithAuth(
                                `${API_URL}/entities/${id}/attachments/${fileId}`,
                                { method: "DELETE" },
                              );
                              await Promise.all([
                                refreshAttachments(),
                                refreshHistory(),
                              ]);
                            } catch (err) {
                              setTransError(
                                err instanceof Error
                                  ? err.message
                                  : "Delete failed",
                              );
                            }
                          })();
                        }}
                      />
                    ) : null}
                    {(() => {
                      const accessMap = (
                        record.fields as Record<string, unknown>
                      ).__accessUsers as
                        | Record<string, { level: string }>
                        | undefined;
                      const hasWriteAccess =
                        currentUserRoles.includes("admin") ||
                        currentUserRoles.includes("agent") ||
                        accessMap?.[currentUserId ?? ""]?.level ===
                          "read_write" ||
                        record.createdBy === currentUserId ||
                        record.assignedTo === currentUserId;
                      return hasWriteAccess;
                    })() && (
                      <AttachmentUploadZone
                        disabled={attachUploading}
                        onFiles={async (files) => {
                          setAttachUploading(true);
                          for (const file of files) {
                            try {
                              const ext =
                                file.name.split(".").pop()?.toLowerCase() ?? "";
                              const EXT_MIME: Record<string, string> = {
                                docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                                doc: "application/msword",
                                xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                xls: "application/vnd.ms-excel",
                                pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                                ppt: "application/vnd.ms-powerpoint",
                                pdf: "application/pdf",
                                txt: "text/plain",
                                csv: "text/csv",
                                json: "application/json",
                                png: "image/png",
                                jpg: "image/jpeg",
                                jpeg: "image/jpeg",
                                gif: "image/gif",
                                webp: "image/webp",
                                zip: "application/zip",
                              };
                              const mimeType =
                                file.type !== ""
                                  ? file.type
                                  : (EXT_MIME[ext] ??
                                    "application/octet-stream");
                              const DOC_MIMES_ATTACH = new Set([
                                "application/pdf",
                                "application/msword",
                                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                                "application/vnd.ms-excel",
                                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                "application/vnd.ms-powerpoint",
                                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                                "application/zip",
                                "application/x-zip-compressed",
                              ]);
                              if (
                                DOC_MIMES_ATTACH.has(mimeType) &&
                                file.size < 1024
                              ) {
                                alert(
                                  `"${file.name}" appears to be a cloud placeholder (${file.size} B) that hasn't been downloaded yet.\n\nIn File Explorer, right-click → "Always keep on this device", wait for it to download, then try again.`,
                                );
                                continue;
                              }
                              const initRes = (await fetchWithAuth(
                                `${API_URL}/files`,
                                {
                                  method: "POST",
                                  body: JSON.stringify({
                                    originalName: file.name,
                                    mimeType,
                                    sizeBytes: file.size,
                                    moduleSlug: typeSlug ?? "unknown",
                                    entityId: id,
                                  }),
                                },
                              )) as {
                                data: { fileId: string; uploadUrl: string };
                              };
                              const putRes = await fetch(
                                initRes.data.uploadUrl,
                                {
                                  method: "PUT",
                                  headers: { "Content-Type": mimeType },
                                  body: file,
                                },
                              );
                              if (!putRes.ok) {
                                const body = await putRes
                                  .text()
                                  .catch(() => "");
                                throw new Error(
                                  `Storage upload failed (${putRes.status})${body ? `: ${body.slice(0, 200)}` : ""}`,
                                );
                              }
                              await fetchWithAuth(
                                `${API_URL}/files/${initRes.data.fileId}/complete`,
                                { method: "POST" },
                              );
                              await fetchWithAuth(
                                `${API_URL}/entities/${id}/attachments`,
                                {
                                  method: "POST",
                                  body: JSON.stringify({
                                    fileId: initRes.data.fileId,
                                  }),
                                },
                              );
                            } catch (err) {
                              setTransError(
                                `Upload failed: ${err instanceof Error ? err.message : "Unknown error"}`,
                              );
                            }
                          }
                          setAttachUploading(false);
                          await refreshAttachments();
                        }}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ══ Two-column area: activity (70%) + sidebar (30%) ═ */}
      </div>
      {/* close rcd-cards */}
      <div className="rcd-two-col">
        {/* Activity panel */}
        <div className="rcd-card rcd-activity-card">
          {/* Tab bar */}
          <div className="rcd-tabs">
            <button
              type="button"
              className={`rcd-tab ${activeTab === "comments" ? "rcd-tab-active" : ""}`}
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
                aria-hidden="true"
              >
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
              Comments
              {commentEvents.length > 0 && (
                <span className="rcd-tab-count">{commentEvents.length}</span>
              )}
            </button>
            <button
              type="button"
              className={`rcd-tab ${activeTab === "history" ? "rcd-tab-active" : ""}`}
              onClick={() => {
                setActiveTab("history");
                void loadHistory();
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
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              History
              {historyLoaded && timelineEvents.length > 0 && (
                <span className="rcd-tab-count">{timelineEvents.length}</span>
              )}
            </button>
            {(isOwner || isAdminOrAgent) && (
              <button
                type="button"
                className={`rcd-tab ${activeTab === "access-requests" ? "rcd-tab-active" : ""}`}
                onClick={() => {
                  setActiveTab("access-requests");
                  void loadAccessRequests();
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
                  <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <line x1="19" y1="8" x2="19" y2="14" />
                  <line x1="22" y1="11" x2="16" y2="11" />
                </svg>
                Access Requests
                {accessReqList.filter((r) => r.status === "pending").length >
                  0 && (
                  <span className="rcd-tab-count rcd-tab-count-warn">
                    {accessReqList.filter((r) => r.status === "pending").length}
                  </span>
                )}
              </button>
            )}
          </div>

          {/* Tab content */}
          <div className="rcd-tab-panel">
            {activeTab === "comments" ? (
              <>
                <div className="rcd-tab-scroll" ref={commentsScrollRef}>
                  {topLevelComments.length === 0 ? (
                    <p className="rcd-empty-hint rcd-empty-hint-feed">
                      No comments yet. Be the first to comment.
                    </p>
                  ) : (
                    <div className="rcd-feed-list">
                      {topLevelComments.map((root) => (
                        <React.Fragment key={root.id}>
                          {renderCommentNode(root, 0)}
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>
                <div className="rcd-composer-dock">
                  {canComment ? (
                    <CommentComposer
                      users={users}
                      replyTo={replyTo}
                      entityId={id ?? ""}
                      moduleSlug={typeSlug ?? ""}
                      onCancel={() => setReplyTo(null)}
                      onSubmit={(text, mentions, replyToId, fileIds) =>
                        submitComment(text, mentions, replyToId, fileIds).then(
                          () => setReplyTo(null),
                        )
                      }
                    />
                  ) : myAccessEntry?.level === "read_only" ? (
                    <div className="rcd-readonly-notice">
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
                        <rect
                          x="3"
                          y="11"
                          width="18"
                          height="11"
                          rx="2"
                          ry="2"
                        />
                        <path d="M7 11V7a5 5 0 0110 0v4" />
                      </svg>
                      <span style={{ flex: 1 }}>
                        You have read-only access and cannot post comments.
                        {myAccessReqStatus === "pending"
                          ? " Comment access request sent — pending approval."
                          : myAccessReqStatus === "rejected"
                            ? " Your comment access request was declined."
                            : ""}
                      </span>
                      {myAccessReqStatus !== "pending" && (
                        <button
                          type="button"
                          className="rcd-readonly-req-btn"
                          disabled={requestingAccess}
                          onClick={() => setConfirmReqLevel("read_comment")}
                        >
                          {myAccessReqStatus === "rejected"
                            ? "Request Again"
                            : "Request Comment Access"}
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              </>
            ) : activeTab === "history" ? (
              <div className="rcd-tab-scroll" ref={historyScrollRef}>
                {historyLoading ? (
                  <div className="portal-loading" style={{ padding: "32px 0" }}>
                    <div className="spinner" />
                  </div>
                ) : !historyLoaded ? (
                  <p className="rcd-empty-hint rcd-empty-hint-feed">
                    Loading history…
                  </p>
                ) : timelineEvents.length === 0 ? (
                  <p className="rcd-empty-hint rcd-empty-hint-feed">
                    No history yet.
                  </p>
                ) : (
                  <div className="rcd-feed-list">
                    {sortedAll
                      .filter((e) => e.metadata?.type !== "comment")
                      .map((event) => (
                        <React.Fragment key={event.id}>
                          {renderFeedEvent(event)}
                        </React.Fragment>
                      ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="rcd-tab-scroll">
                {!accessReqLoaded ? (
                  <div className="portal-loading" style={{ padding: "32px 0" }}>
                    <div className="spinner" />
                  </div>
                ) : accessReqList.length === 0 ? (
                  <p className="rcd-empty-hint rcd-empty-hint-feed">
                    No access requests yet.
                  </p>
                ) : (
                  <div className="rcd-areq-list">
                    {accessReqList.map((req) => {
                      const requesterName =
                        users.find((u) => u.userId === req.requesterId)
                          ?.displayName ?? req.requesterId.slice(0, 12);
                      return (
                        <div
                          key={req.id}
                          className={`rcd-areq-row rcd-areq-row--${req.status}`}
                        >
                          <div className="rcd-areq-meta">
                            <span className="rcd-areq-name">
                              {requesterName}
                            </span>
                            <span className="rcd-areq-level">
                              {req.requestedLevel === "read_only"
                                ? "View only"
                                : req.requestedLevel === "read_comment"
                                  ? "View + comment"
                                  : "Full access"}
                            </span>
                            <span
                              className={`rcd-areq-status rcd-areq-status--${req.status}`}
                            >
                              {req.status === "pending"
                                ? "Pending"
                                : req.status === "approved"
                                  ? "Approved"
                                  : "Rejected"}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="rcd-areq-action-btn"
                            onClick={() => {
                              setResolveLevel(req.requestedLevel);
                              setResolveModal({
                                reqId: req.id,
                                requesterId: req.requesterId,
                                currentRequestedLevel: req.requestedLevel,
                              });
                            }}
                          >
                            {req.status === "pending" ? "Review" : "Change"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {/* close rcd-activity-card */}

        {/* ── Right sidebar ──────────────────────────────── */}
        <div className="rcd-sidebar">
          {/* Child tickets — shown only when workflow depth config allows another level */}
          {record.canAddChildren && (
            <div className="rcd-sidebar-section">
              <div className="rcd-sidebar-hdr">
                <span className="rcd-sidebar-hdr-title">
                  Sub-tasks
                  {children.length > 0 && (
                    <span className="rcd-sidebar-count">{children.length}</span>
                  )}
                </span>
                {canCreateChild && !record.deletedAt && (
                  <button
                    type="button"
                    className="rcd-sidebar-add"
                    onClick={() => {
                      setShowCreateChild(true);
                      setNewChildTitle("");
                      setCreateChildError(null);
                    }}
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
                      aria-hidden="true"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add
                  </button>
                )}
              </div>

              <div className="rcd-sidebar-body">
                {childrenLoading ? (
                  <p className="rcd-sidebar-hint" style={{ padding: "8px 0" }}>
                    Loading…
                  </p>
                ) : children.length === 0 ? (
                  <p className="rcd-sidebar-hint" style={{ padding: "8px 0" }}>
                    No sub-tasks yet.
                  </p>
                ) : (
                  <>
                    {(() => {
                      const closed = children.filter(
                        (c) =>
                          c.deletedAt !== null || c.currentState === "closed",
                      ).length;
                      const pct = Math.round((closed / children.length) * 100);
                      return (
                        <div
                          className="rcd-subtasks-progress-wrap"
                          title={`${closed} of ${children.length} closed`}
                        >
                          <div className="rcd-subtasks-progress-bar">
                            <div
                              className="rcd-subtasks-progress-fill"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="rcd-subtasks-progress-label">
                            {closed}/{children.length}
                          </span>
                        </div>
                      );
                    })()}
                    <div className="rcd-sidebar-children">
                      {children.map((child) => {
                        const childTitleField = [
                          "subject",
                          "title",
                          "name",
                        ].find((k) => child.fields[k]);
                        const childTitle = childTitleField
                          ? String(child.fields[childTitleField])
                          : `#${child.id.slice(0, 8)}`;
                        const isClosed =
                          child.deletedAt !== null ||
                          child.currentState === "closed";
                        const assignee = users.find(
                          (u) => u.userId === child.assignedTo,
                        );
                        const childState = CHILD_TICKET_STATES.find(
                          (s) => s.name === child.currentState,
                        );
                        const dueDateField = [
                          "due_date",
                          "dueDate",
                          "due",
                        ].find((k) => child.fields[k]);
                        const dueDate =
                          dueDateField &&
                          !isNaN(
                            new Date(
                              child.fields[dueDateField] as string,
                            ).getTime(),
                          )
                            ? new Date(child.fields[dueDateField] as string)
                            : null;

                        // Urgency: days until due (negative = overdue)
                        const now = new Date();
                        now.setHours(0, 0, 0, 0);
                        const dueDaysDiff = dueDate
                          ? Math.ceil(
                              (dueDate.getTime() - now.getTime()) / 86400000,
                            )
                          : null;
                        const isPastDue =
                          dueDaysDiff !== null && dueDaysDiff < 0;
                        const isDueToday = dueDaysDiff === 0;
                        const isDueSoon =
                          dueDaysDiff !== null && dueDaysDiff === 1;

                        // Border colour: red ≤0d, amber 1d, green otherwise (no colour for closed)
                        let urgencyBorder = "var(--border-color)";
                        let urgencyBg = "transparent";
                        if (!isClosed && dueDaysDiff !== null) {
                          if (isPastDue || isDueToday) {
                            urgencyBorder = "#ef4444";
                            urgencyBg = "rgba(239,68,68,0.04)";
                          } else if (isDueSoon) {
                            urgencyBorder = "#f59e0b";
                            urgencyBg = "rgba(245,158,11,0.04)";
                          } else {
                            urgencyBorder = "rgba(34,197,94,0.5)";
                            urgencyBg = "rgba(34,197,94,0.03)";
                          }
                        }

                        const dueDateStr = dueDate
                          ? dueDate.toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })
                          : null;
                        const dueDateLabel = (() => {
                          if (!dueDateStr || isClosed) return dueDateStr;
                          if (isPastDue) return `Overdue · ${dueDateStr}`;
                          if (isDueToday) return `Due today`;
                          if (isDueSoon) return `Due tomorrow`;
                          return dueDateStr;
                        })();

                        return (
                          <Link
                            key={child.id}
                            to={`/records/${typeSlug ?? ""}/${child.id}`}
                            className={`rcd-child-card ${isClosed ? "rcd-child-card-closed" : ""}`}
                            style={{
                              borderColor: urgencyBorder,
                              background: urgencyBg,
                            }}
                          >
                            {/* Title + ID */}
                            <div className="rcd-child-card-title-row">
                              <span className="rcd-child-card-title">
                                {childTitle}
                              </span>
                              <span className="rcd-child-id">
                                #{child.id.slice(0, 6)}
                              </span>
                            </div>

                            {/* State + due date */}
                            <div className="rcd-child-card-meta">
                              {childState && (
                                <span
                                  className="rcd-child-state"
                                  style={
                                    childState.color
                                      ? {
                                          color: childState.color,
                                          background: `${childState.color}18`,
                                          borderColor: `${childState.color}40`,
                                        }
                                      : undefined
                                  }
                                >
                                  <span
                                    className="rcd-state-dot"
                                    style={
                                      childState.color
                                        ? { background: childState.color }
                                        : undefined
                                    }
                                  />
                                  {childState.label}
                                </span>
                              )}
                              {dueDateLabel && (
                                <span
                                  className={`rcd-child-due${isPastDue || isDueToday ? " rcd-child-due-overdue" : isDueSoon ? " rcd-child-due-warn" : ""}`}
                                >
                                  {dueDateLabel}
                                </span>
                              )}
                            </div>

                            {/* Assignee */}
                            <div className="rcd-child-card-assignee">
                              {assignee ? (
                                <>
                                  <span className="rcd-child-card-avatar">
                                    {(assignee.displayName ?? assignee.email)
                                      .slice(0, 1)
                                      .toUpperCase()}
                                  </span>
                                  <span className="rcd-child-card-assignee-name">
                                    {assignee.displayName ?? assignee.email}
                                  </span>
                                </>
                              ) : (
                                <span className="rcd-child-card-assignee-name rcd-child-unassigned">
                                  Unassigned
                                </span>
                              )}
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
              {/* close rcd-sidebar-body */}
            </div>
          )}
          {/* end depth-limit guard */}

          {/* People with access — always visible */}
          <div className="rcd-sidebar-section">
            <div className="rcd-sidebar-hdr">
              <span className="rcd-sidebar-hdr-title">
                Access
                {accessUsers.length > 0 && (
                  <span className="rcd-sidebar-count">
                    {accessUsers.length}
                  </span>
                )}
              </span>
            </div>
            <div className="rcd-sidebar-body">
              {accessUsers.length === 0 ? (
                <p className="rcd-sidebar-hint" style={{ padding: "8px 0" }}>
                  No one has access yet.
                </p>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                  }}
                >
                  {accessUsers.map((u) => {
                    const name = u.displayName ?? u.email;
                    const initials = name
                      .split(" ")
                      .slice(0, 2)
                      .map((p) => p[0] ?? "")
                      .join("")
                      .toUpperCase();
                    const isCreator = u.tag === "creator";
                    const isAssigned = u.tag === "assigned";

                    // Badge text + colors
                    let badgeLabel = "Access";
                    let badgeBg = "#f3f4f6";
                    let badgeColor = "var(--text-muted, #6b7280)";
                    let badgeBorder = "#e5e7eb";
                    if (isCreator) {
                      badgeLabel = "Creator";
                      badgeBg = "#ede9fe";
                      badgeColor = "#7c3aed";
                      badgeBorder = "#c4b5fd";
                    } else if (isAssigned) {
                      badgeLabel = "Assigned";
                      badgeBg = "var(--accent-color, #6366f1)18";
                      badgeColor = "var(--accent-color, #6366f1)";
                      badgeBorder = "var(--accent-color, #6366f1)40";
                    } else if (u.level === "read_comment") {
                      badgeLabel = "Comment";
                      badgeBg = "#eff6ff";
                      badgeColor = "#2563eb";
                      badgeBorder = "#bfdbfe";
                    } else if (u.level === "read_only") {
                      badgeLabel = "Read Only";
                      badgeBg = "#f9fafb";
                      badgeColor = "#6b7280";
                      badgeBorder = "#d1d5db";
                    }

                    return (
                      <div
                        key={u.userId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          padding: "8px 10px",
                          background: "var(--bg-secondary, #f9fafb)",
                          border: "1px solid var(--border-color, #e5e7eb)",
                          borderRadius: "8px",
                        }}
                      >
                        <span
                          style={{
                            flexShrink: 0,
                            width: "32px",
                            height: "32px",
                            borderRadius: "50%",
                            background: isCreator
                              ? "#7c3aed"
                              : "var(--accent-color, #6366f1)",
                            color: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "12px",
                            fontWeight: 700,
                          }}
                        >
                          {initials}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: "13px",
                              fontWeight: 600,
                              color: "var(--text-primary, #111827)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {name}
                          </div>
                          {u.displayName && (
                            <div
                              style={{
                                fontSize: "11px",
                                color: "var(--text-muted, #6b7280)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {u.email}
                            </div>
                          )}
                        </div>
                        <span
                          style={{
                            flexShrink: 0,
                            fontSize: "10px",
                            fontWeight: 600,
                            padding: "2px 6px",
                            borderRadius: "4px",
                            background: badgeBg,
                            color: badgeColor,
                            border: `1px solid ${badgeBorder}`,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          {badgeLabel}
                        </span>
                        {/* Edit access button — hidden for creator */}
                        {isAdminOrAgent && !record.deletedAt && !isCreator && (
                          <button
                            type="button"
                            title="Change access"
                            onClick={() => {
                              setAccessChangeModal({
                                userId: u.userId,
                                displayName: name,
                                currentLevel: u.level,
                                isAssigned,
                                isCreator,
                              });
                              setAccessChangeSelection(u.level);
                            }}
                            style={{
                              flexShrink: 0,
                              background: "none",
                              border: "1px solid transparent",
                              borderRadius: "5px",
                              cursor: "pointer",
                              padding: "3px 5px",
                              color: "var(--text-muted, #9ca3af)",
                              fontSize: "14px",
                              lineHeight: 1,
                            }}
                            onMouseEnter={(e) => {
                              (
                                e.currentTarget as HTMLButtonElement
                              ).style.color = "#ef4444";
                              (
                                e.currentTarget as HTMLButtonElement
                              ).style.borderColor = "#fca5a5";
                            }}
                            onMouseLeave={(e) => {
                              (
                                e.currentTarget as HTMLButtonElement
                              ).style.color = "var(--text-muted, #9ca3af)";
                              (
                                e.currentTarget as HTMLButtonElement
                              ).style.borderColor = "transparent";
                            }}
                          >
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
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {/* close rcd-sidebar-body */}
          </div>
        </div>
        {/* close rcd-sidebar */}
      </div>
      {/* close rcd-two-col */}

      {/* ── Access change modal (change level / remove) ──── */}
      {accessChangeModal && (
        <div
          className="modal-overlay"
          onClick={() => setAccessChangeModal(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                Change access — {accessChangeModal.displayName}
              </h3>
              <button
                className="modal-close"
                onClick={() => setAccessChangeModal(null)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  marginBottom: "12px",
                }}
              >
                {(["read_only", "read_comment"] as const).map((level) => {
                  const label = level === "read_only" ? "Read Only" : "Comment";
                  const desc =
                    level === "read_only"
                      ? "Can view this ticket"
                      : "Can view and post comments";
                  const selected = accessChangeSelection === level;
                  return (
                    <label
                      key={level}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "10px",
                        padding: "10px 12px",
                        border: `1.5px solid ${selected ? "#6366f1" : "rgba(255,255,255,0.12)"}`,
                        borderRadius: "8px",
                        cursor: "pointer",
                        background: selected
                          ? "rgba(99,102,241,0.15)"
                          : "rgba(255,255,255,0.04)",
                      }}
                    >
                      <input
                        type="radio"
                        name="accessLevel"
                        value={level}
                        checked={selected}
                        onChange={() => setAccessChangeSelection(level)}
                        style={{ marginTop: "2px", accentColor: "#6366f1" }}
                      />
                      <span>
                        <span
                          style={{
                            fontSize: "13px",
                            fontWeight: 600,
                            display: "block",
                            color: "var(--text-primary, #f1f5f9)",
                          }}
                        >
                          {label}
                        </span>
                        <span
                          style={{
                            fontSize: "12px",
                            color: "var(--text-muted, #94a3b8)",
                          }}
                        >
                          {desc}
                        </span>
                      </span>
                    </label>
                  );
                })}
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "10px",
                    padding: "10px 12px",
                    border: `1.5px solid ${accessChangeSelection === "remove" ? "#ef4444" : "rgba(255,255,255,0.12)"}`,
                    borderRadius: "8px",
                    cursor: "pointer",
                    background:
                      accessChangeSelection === "remove"
                        ? "rgba(239,68,68,0.12)"
                        : "rgba(255,255,255,0.04)",
                  }}
                >
                  <input
                    type="radio"
                    name="accessLevel"
                    value="remove"
                    checked={accessChangeSelection === "remove"}
                    onChange={() => setAccessChangeSelection("remove")}
                    style={{ marginTop: "2px", accentColor: "#ef4444" }}
                  />
                  <span>
                    <span
                      style={{
                        fontSize: "13px",
                        fontWeight: 600,
                        display: "block",
                        color:
                          accessChangeSelection === "remove"
                            ? "#ef4444"
                            : "var(--text-primary, #f1f5f9)",
                      }}
                    >
                      Remove access
                    </span>
                    <span
                      style={{
                        fontSize: "12px",
                        color: "var(--text-muted, #94a3b8)",
                      }}
                    >
                      {accessChangeModal.isAssigned
                        ? "Will also unassign this user from the ticket"
                        : "Remove all access to this ticket"}
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn-secondary"
                onClick={() => setAccessChangeModal(null)}
                disabled={accessChangeSaving}
              >
                Cancel
              </button>
              <button
                style={{
                  background:
                    accessChangeSelection === "remove"
                      ? "#ef4444"
                      : "var(--accent-color, #6366f1)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "6px",
                  padding: "7px 16px",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: accessChangeSaving ? "not-allowed" : "pointer",
                  opacity: accessChangeSaving ? 0.7 : 1,
                }}
                disabled={accessChangeSaving}
                onClick={() => void handleAccessChange()}
              >
                {accessChangeSaving
                  ? "Saving…"
                  : accessChangeSelection === "remove"
                    ? "Remove access"
                    : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Mention-grant confirmation modal ─────────────── */}
      {pendingMentionGrant && (
        <div
          className="modal-overlay"
          onClick={() => setPendingMentionGrant(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Grant ticket access</h3>
              <button
                className="modal-close"
                onClick={() => setPendingMentionGrant(null)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              {/* Yellow warning banner */}
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "10px",
                  padding: "10px 12px",
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  borderRadius: "8px",
                  marginBottom: "14px",
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#d97706"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0, marginTop: "1px" }}
                  aria-hidden="true"
                >
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <div style={{ fontSize: "13px", color: "#92400e" }}>
                  <strong>
                    {pendingMentionGrant.newUsers
                      .map((u) => u.displayName ?? u.email)
                      .join(", ")}
                  </strong>{" "}
                  {pendingMentionGrant.newUsers.length === 1
                    ? "doesn't"
                    : "don't"}{" "}
                  have access to this ticket yet. Choose what they can do before
                  posting.
                </div>
              </div>
              {/* Level picker */}
              <div
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              >
                {(
                  [
                    ["read_only", "Read Only", "Can view this ticket"],
                    ["read_comment", "Comment", "Can view and post comments"],
                  ] as const
                ).map(([level, label, desc]) => {
                  const selected = pendingMentionGrant.selectedLevel === level;
                  return (
                    <label
                      key={level}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "10px",
                        padding: "10px 12px",
                        border: `1.5px solid ${selected ? "#6366f1" : "rgba(255,255,255,0.12)"}`,
                        borderRadius: "8px",
                        cursor: "pointer",
                        background: selected
                          ? "rgba(99,102,241,0.15)"
                          : "rgba(255,255,255,0.04)",
                      }}
                    >
                      <input
                        type="radio"
                        name="mentionLevel"
                        value={level}
                        checked={selected}
                        onChange={() =>
                          setPendingMentionGrant((p) =>
                            p ? { ...p, selectedLevel: level } : p,
                          )
                        }
                        style={{ marginTop: "2px", accentColor: "#6366f1" }}
                      />
                      <span>
                        <span
                          style={{
                            fontSize: "13px",
                            fontWeight: 600,
                            display: "block",
                            color: "var(--text-primary, #f1f5f9)",
                          }}
                        >
                          {label}
                          {level === "read_comment" && (
                            <span
                              style={{
                                fontWeight: 400,
                                color: "var(--text-muted, #94a3b8)",
                                marginLeft: "6px",
                                fontSize: "12px",
                              }}
                            >
                              recommended
                            </span>
                          )}
                        </span>
                        <span
                          style={{
                            fontSize: "12px",
                            color: "var(--text-muted, #94a3b8)",
                          }}
                        >
                          {desc}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn-secondary"
                onClick={() => setPendingMentionGrant(null)}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  const { text, mentions, replyTo, selectedLevel } =
                    pendingMentionGrant;
                  setPendingMentionGrant(null);
                  const existingIds = new Set(accessList.map((e) => e.userId));
                  const mentionEntries = mentions.map((uid) => ({
                    userId: uid,
                    level: existingIds.has(uid)
                      ? ((accessList.find((e) => e.userId === uid)?.level ??
                          "read_comment") as AccessLevel)
                      : selectedLevel,
                  }));
                  void doSubmitComment(
                    text,
                    mentionEntries,
                    replyTo,
                    pendingMentionGrant.fileIds ?? [],
                  );
                }}
              >
                Grant &amp; post
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Archive confirmation modal ───────────────────── */}
      {archiveConfirm && (
        <div className="modal-overlay" onClick={() => setArchiveConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Archive this record?</h3>
              <button
                className="modal-close"
                onClick={() => setArchiveConfirm(null)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p className="rcd-modal-desc">
                This record has{" "}
                <strong>
                  {archiveConfirm.childCount} sub-task
                  {archiveConfirm.childCount !== 1 ? "s" : ""}
                </strong>
                . Archiving will also archive all of them. This can be undone
                with Restore.
              </p>
            </div>
            <div className="modal-footer">
              <button
                className="btn-secondary"
                onClick={() => setArchiveConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="btn-primary rcd-btn-archive-confirm"
                disabled={archiving}
                onClick={() => void archiveRecord(true)}
              >
                {archiving
                  ? "Archiving…"
                  : `Archive all ${archiveConfirm.childCount + 1}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create sub-task modal ────────────────────────── */}
      {showCreateChild && (
        <div
          className="modal-overlay"
          onClick={() => {
            setShowCreateChild(false);
            setNewChildTitle("");
            setNewChildAssignedTo("");
            setNewChildDueDate("");
            setNewChildDescription("");
            setCreateChildError(null);
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">New sub-task</h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowCreateChild(false);
                  setNewChildTitle("");
                  setNewChildAssignedTo("");
                  setNewChildDueDate("");
                  setNewChildDescription("");
                  setCreateChildError(null);
                }}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              {createChildError && (
                <div
                  className="portal-alert-error"
                  style={{ marginBottom: "12px" }}
                >
                  {createChildError}
                </div>
              )}
              <div className="form-group">
                <label className="form-label">Title *</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="Sub-task title…"
                  value={newChildTitle}
                  onChange={(e) => setNewChildTitle(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label className="form-label">Assign to</label>
                <select
                  className="form-input"
                  value={newChildAssignedTo}
                  onChange={(e) => setNewChildAssignedTo(e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {users.map((u) => (
                    <option key={u.userId} value={u.userId}>
                      {u.displayName ?? u.email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Due date</label>
                <input
                  className="form-input"
                  type="date"
                  value={newChildDueDate}
                  onChange={(e) => setNewChildDueDate(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <textarea
                  className="form-input"
                  rows={3}
                  placeholder="What needs to be done…"
                  value={newChildDescription}
                  onChange={(e) => setNewChildDescription(e.target.value)}
                  style={{ resize: "vertical" }}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn-secondary"
                onClick={() => {
                  setShowCreateChild(false);
                  setNewChildTitle("");
                  setNewChildAssignedTo("");
                  setNewChildDueDate("");
                  setNewChildDescription("");
                  setCreateChildError(null);
                }}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!newChildTitle.trim() || creatingChild}
                onClick={() => void createChild()}
              >
                {creatingChild ? "Creating…" : "Create sub-task"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Transition modal ─────────────────────────────── */}
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

      {/* Confirm access-request modal is rendered inside rcd-access-overlay above
          when accessDenied is true, to avoid z-index conflicts. */}
      {!accessDenied && confirmReqLevel !== null && (
        <div className="modal-overlay" onClick={() => setConfirmReqLevel(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Request access?</span>
              <button
                type="button"
                className="modal-close"
                onClick={() => setConfirmReqLevel(null)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p
                style={{
                  margin: "0 0 18px",
                  color: "var(--text-secondary)",
                  fontSize: "14px",
                }}
              >
                {confirmReqLevel === "read_comment"
                  ? "This will send a request to the ticket owner for comment access. They will be able to approve or decline."
                  : "This will send a request to the ticket owner for view access. They will be able to approve or decline."}
              </p>
              <div className="rcd-access-modal-actions">
                <button
                  type="button"
                  className="portal-btn-secondary"
                  onClick={() => setConfirmReqLevel(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="portal-btn-primary"
                  disabled={requestingAccess}
                  onClick={() => {
                    const lvl = confirmReqLevel;
                    setConfirmReqLevel(null);
                    void submitAccessRequest(lvl);
                  }}
                >
                  {requestingAccess ? "Sending…" : "Send Request"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Resolve access-request modal ─────────────────────── */}
      {resolveModal && (
        <div className="modal-overlay" onClick={() => setResolveModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Review access request</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setResolveModal(null)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p
                style={{
                  fontSize: "13px",
                  color: "var(--text-secondary)",
                  marginBottom: "14px",
                }}
              >
                {users.find((u) => u.userId === resolveModal.requesterId)
                  ?.displayName ?? resolveModal.requesterId}{" "}
                requested{" "}
                <strong>
                  {resolveModal.currentRequestedLevel === "read_only"
                    ? "view-only"
                    : resolveModal.currentRequestedLevel === "read_comment"
                      ? "view + comment"
                      : "full"}{" "}
                  access
                </strong>
                . Select the level to grant:
              </p>
              <div className="modal-access-opts">
                {(
                  [
                    {
                      value: "read_only",
                      label: "View only",
                      desc: "Can read the ticket but not comment",
                    },
                    {
                      value: "read_comment",
                      label: "View + comment",
                      desc: "Can read and post comments",
                    },
                    {
                      value: "read_write",
                      label: "Full access",
                      desc: "Can edit fields and transition state",
                    },
                  ] as { value: AccessLevel; label: string; desc: string }[]
                ).map((opt) => (
                  <label
                    key={opt.value}
                    className={`modal-access-opt ${resolveLevel === opt.value ? "modal-access-opt--active" : ""}`}
                  >
                    <input
                      type="radio"
                      name="resolve-level"
                      value={opt.value}
                      checked={resolveLevel === opt.value}
                      onChange={() => setResolveLevel(opt.value)}
                    />
                    <span className="modal-access-opt-label">{opt.label}</span>
                    <span className="modal-access-opt-desc">{opt.desc}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="portal-btn-secondary"
                disabled={resolveSaving}
                onClick={() =>
                  void resolveAccessRequest(
                    resolveModal.reqId,
                    "reject",
                    resolveLevel,
                  )
                }
              >
                Reject
              </button>
              <button
                type="button"
                className="portal-btn-primary"
                disabled={resolveSaving}
                onClick={() =>
                  void resolveAccessRequest(
                    resolveModal.reqId,
                    "approve",
                    resolveLevel,
                  )
                }
              >
                {resolveSaving ? "Saving…" : "Approve"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── File preview modal ───────────────────────────────── */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}
