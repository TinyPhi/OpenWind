import React, { useState } from "react";
import { useList } from "@refinedev/core";
import { useNavigate } from "react-router-dom";

function toWorkflowSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

type WorkflowState = {
  name: string;
  label: string;
  color: string | null;
  isTerminal: boolean;
};

type Workflow = {
  id: string;
  name: string;
  entityTypeId: string;
  initialState: string;
  isActive: boolean;
  createdAt: string;
  recordCount?: number;
  states?: WorkflowState[];
  transitions?: { id: string }[];
};

const ACCENT_PALETTE = [
  "#6366f1",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#f97316",
];

/* ── Mini inline state-flow visualisation ── */
function MiniFlow({
  states,
  initialState,
  accent,
}: {
  states: WorkflowState[];
  initialState: string;
  accent: string;
}): React.ReactElement {
  const sorted = [...states].sort((a, b) =>
    a.name === initialState ? -1 : b.name === initialState ? 1 : 0,
  );
  const MAX_SHOWN = 6;
  const shown = sorted.slice(0, MAX_SHOWN);
  const extra = sorted.length - MAX_SHOWN;

  return (
    <div className="wfl-row-flow" aria-hidden="true">
      {shown.map((s, i) => {
        const color = s.color ?? accent;
        const isLast = i === shown.length - 1 && extra <= 0;
        return (
          <React.Fragment key={s.name}>
            <div
              className={`wfl-flow-node${s.isTerminal ? " wfl-flow-node-terminal" : ""}`}
              style={{
                borderColor: color,
                background: `${color}28`,
              }}
              title={s.label}
            />
            {!isLast && <div className="wfl-flow-connector" />}
          </React.Fragment>
        );
      })}
      {extra > 0 && <span className="wfl-flow-more">+{extra}</span>}
    </div>
  );
}

export function Workflows(): React.ReactElement {
  const { data, isLoading } = useList<Workflow>({ resource: "workflows" });
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const allWorkflows = data?.data ?? [];
  const workflows = search.trim()
    ? allWorkflows.filter((w) =>
        w.name.toLowerCase().includes(search.toLowerCase()),
      )
    : allWorkflows;

  const activeCount = allWorkflows.filter((w) => w.isActive !== false).length;

  if (isLoading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading workflows…</span>
      </div>
    );
  }

  return (
    <div>
      {/* ── Page header ── */}
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">Workflows</h2>
          <p className="page-subtitle">
            State machine definitions — each governs states, transitions, SLA
            timers, and role-based access guards.
          </p>
        </div>
        <div className="wfl-header-actions">
          <span className="stat-pill">{activeCount} active</span>
          <span className="stat-pill stat-pill-muted">
            {allWorkflows.length} total
          </span>
          <button
            className="btn-primary"
            onClick={() => navigate("/workflows/new")}
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
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Workflow
          </button>
        </div>
      </div>

      {/* ── Search bar ── */}
      {allWorkflows.length > 0 && (
        <div className="wfl-search-bar">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="wfl-search-icon"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="wfl-search-input"
            placeholder="Search workflows…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="wfl-search-clear"
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
      )}

      {/* ── Empty states ── */}
      {allWorkflows.length === 0 && (
        <div className="wfl-empty">
          <div className="wfl-empty-icon">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061A1.125 1.125 0 013 16.811V8.69z" />
              <path d="M12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061a1.125 1.125 0 01-1.683-.977V8.69z" />
            </svg>
          </div>
          <h4>No workflows yet</h4>
          <p>
            Copy a template from the Templates page or create a blank workflow.
          </p>
          <button
            className="btn-primary"
            style={{ marginTop: "16px" }}
            onClick={() => navigate("/workflows/new")}
          >
            Create your first workflow
          </button>
        </div>
      )}

      {allWorkflows.length > 0 && workflows.length === 0 && (
        <div className="wfl-empty">
          <div className="wfl-empty-icon">🔍</div>
          <h4>No results for "{search}"</h4>
          <p>Try a different keyword.</p>
        </div>
      )}

      {/* ── List ── */}
      {workflows.length > 0 && (
        <div className="wfl-list">
          {workflows.map((wf, i) => {
            const accent =
              ACCENT_PALETTE[i % ACCENT_PALETTE.length] ?? "#6366f1";
            const states = wf.states ?? [];
            const transitions = wf.transitions ?? [];
            const isActive = wf.isActive !== false;
            const recordCount = wf.recordCount ?? 0;

            return (
              <div
                key={wf.id}
                className="wfl-row"
                style={{ "--row-accent": accent } as React.CSSProperties}
                onClick={() =>
                  navigate(`/workflows/${toWorkflowSlug(wf.name)}`)
                }
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    navigate(`/workflows/${toWorkflowSlug(wf.name)}`);
                }}
              >
                {/* 3px left accent */}
                <div className="wfl-row-bar" />

                {/* Circle icon */}
                <div
                  className="wfl-row-icon"
                  style={{
                    background: `${accent}1a`,
                    borderColor: `${accent}30`,
                    color: accent,
                  }}
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061A1.125 1.125 0 013 16.811V8.69z" />
                    <path d="M12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061a1.125 1.125 0 01-1.683-.977V8.69z" />
                  </svg>
                </div>

                {/* Name + sub */}
                <div className="wfl-row-info">
                  <div className="wfl-row-name">{wf.name}</div>
                  <div className="wfl-row-sub">
                    <span
                      className={`wfl-status-badge ${isActive ? "wfl-status-active" : "wfl-status-inactive"}`}
                    >
                      <span className="wfl-status-dot" />
                      {isActive ? "Active" : "Inactive"}
                    </span>
                    {recordCount > 0 && (
                      <span
                        style={{ fontSize: "11px", color: "var(--text-muted)" }}
                      >
                        {recordCount} record{recordCount !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>

                {/* Mini flow */}
                {states.length > 0 && (
                  <MiniFlow
                    states={states}
                    initialState={wf.initialState}
                    accent={accent}
                  />
                )}

                {/* Right: counts + date + chevron */}
                <div className="wfl-row-right">
                  <div className="wfl-row-stats">
                    <span className="wfl-row-counts">
                      {states.length} states · {transitions.length} transitions
                    </span>
                    <span className="wfl-row-date">
                      {new Date(wf.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  </div>
                  <div className="wfl-row-chevron">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
