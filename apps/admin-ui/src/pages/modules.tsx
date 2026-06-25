import React, { useState, useMemo } from "react";
import { useList } from "@refinedev/core";
import { fetchWithAuth, API_URL } from "../lib/api.js";

type Module = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: string;
  isSystem: boolean;
  minPlan: string;
  installed: boolean;
};

// ── static metadata ───────────────────────────────────────────────────────────

const MODULE_EMOJI: Record<string, string> = {
  helpdesk: "🎫",
  crm: "👥",
  hrms: "👷",
  projects: "📋",
  invoicing: "🧾",
  procurement: "🛒",
  reimbursements: "💸",
};

const MODULE_DEFAULT_NAMES: Record<string, string> = {
  helpdesk: "Support Ticket Lifecycle",
  crm: "Sales Pipeline",
  hrms: "Leave Approval",
  reimbursements: "Expense Approval",
  projects: "Task Lifecycle",
  invoicing: "Invoice Lifecycle",
  procurement: "Purchase Approval",
};

const MODULE_FEATURES: Record<string, string[]> = {
  helpdesk: [
    "Tickets",
    "Priority & SLA tracking",
    "Support categories",
    "Agent assignment",
  ],
  crm: [
    "Deals / Leads",
    "Sales pipeline stages",
    "Contact linkage",
    "Win / Loss tracking",
  ],
  hrms: [
    "Leave requests",
    "Manager approval flow",
    "HR review stage",
    "Employee records",
  ],
  reimbursements: [
    "Expense claims",
    "Finance approval",
    "Payment confirmation",
    "Receipt attachments",
  ],
  projects: [
    "Tasks & sprints",
    "Backlog management",
    "Review & sign-off",
    "Kanban states",
  ],
  invoicing: [
    "Invoice lifecycle",
    "Draft → Sent → Paid",
    "Client portal view",
    "Payment status",
  ],
  procurement: [
    "Purchase orders",
    "Multi-level approval",
    "Vendor tracking",
    "Delivery confirmation",
  ],
};

function SectionLabel({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        fontSize: "11px",
        fontWeight: 700,
        color: "var(--text-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        marginBottom: "10px",
      }}
    >
      {children}
    </div>
  );
}

const MODULE_COLOR: Record<string, string> = {
  helpdesk: "hsl(211,100%,45%)",
  crm: "hsl(265,84%,60%)",
  hrms: "hsl(150,75%,40%)",
  reimbursements: "hsl(35,90%,50%)",
  projects: "hsl(185,80%,40%)",
  invoicing: "hsl(340,80%,58%)",
  procurement: "hsl(45,90%,48%)",
};

const MODULE_STATES: Record<
  string,
  Array<{ name: string; terminal?: boolean }>
> = {
  helpdesk: [
    { name: "New" },
    { name: "Open" },
    { name: "In Progress" },
    { name: "Pending Customer" },
    { name: "Resolved", terminal: true },
    { name: "Closed", terminal: true },
  ],
  crm: [
    { name: "Prospect" },
    { name: "Qualified" },
    { name: "Proposal Sent" },
    { name: "Negotiation" },
    { name: "Won", terminal: true },
    { name: "Lost", terminal: true },
  ],
  hrms: [
    { name: "Draft" },
    { name: "Submitted" },
    { name: "Manager Review" },
    { name: "HR Review" },
    { name: "Approved", terminal: true },
    { name: "Rejected", terminal: true },
  ],
  reimbursements: [
    { name: "Draft" },
    { name: "Submitted" },
    { name: "Finance Review" },
    { name: "Approved" },
    { name: "Paid", terminal: true },
    { name: "Rejected", terminal: true },
  ],
  projects: [
    { name: "Backlog" },
    { name: "To Do" },
    { name: "In Progress" },
    { name: "Review" },
    { name: "Done", terminal: true },
    { name: "Cancelled", terminal: true },
  ],
  invoicing: [
    { name: "Draft" },
    { name: "Sent" },
    { name: "Partially Paid" },
    { name: "Paid", terminal: true },
    { name: "Void", terminal: true },
  ],
  procurement: [
    { name: "Draft" },
    { name: "Pending Approval" },
    { name: "Approved" },
    { name: "Ordered" },
    { name: "Delivered", terminal: true },
    { name: "Cancelled", terminal: true },
  ],
};

const MODULE_FIELDS: Record<string, Array<{ label: string; type: string }>> = {
  helpdesk: [
    { label: "Subject", type: "text" },
    { label: "Description", type: "longtext" },
    { label: "Priority", type: "enum" },
    { label: "Category", type: "enum" },
    { label: "Due Date", type: "date" },
  ],
  crm: [
    { label: "Deal Name", type: "text" },
    { label: "Company", type: "text" },
    { label: "Deal Value", type: "currency" },
    { label: "Expected Close", type: "date" },
    { label: "Source", type: "enum" },
  ],
  hrms: [
    { label: "Leave Type", type: "enum" },
    { label: "Start Date", type: "date" },
    { label: "End Date", type: "date" },
    { label: "Reason", type: "longtext" },
    { label: "Days Count", type: "number" },
  ],
  reimbursements: [
    { label: "Expense Title", type: "text" },
    { label: "Amount", type: "currency" },
    { label: "Category", type: "enum" },
    { label: "Expense Date", type: "date" },
    { label: "Description", type: "longtext" },
  ],
  projects: [
    { label: "Task Title", type: "text" },
    { label: "Description", type: "longtext" },
    { label: "Priority", type: "enum" },
    { label: "Due Date", type: "date" },
    { label: "Story Points", type: "number" },
  ],
  invoicing: [
    { label: "Invoice Number", type: "text" },
    { label: "Client Name", type: "text" },
    { label: "Amount", type: "currency" },
    { label: "Issue Date", type: "date" },
    { label: "Due Date", type: "date" },
  ],
  procurement: [
    { label: "Item Description", type: "text" },
    { label: "Vendor", type: "text" },
    { label: "Amount", type: "currency" },
    { label: "Required By", type: "date" },
    { label: "Justification", type: "longtext" },
  ],
};

const MODULE_TRANSITIONS: Record<
  string,
  Array<{ from: string; to: string; label: string }>
> = {
  helpdesk: [
    { from: "New", to: "Open", label: "Assign" },
    { from: "Open", to: "In Progress", label: "Start" },
    { from: "In Progress", to: "Pending Customer", label: "Await reply" },
    { from: "Pending Customer", to: "In Progress", label: "Customer replied" },
    { from: "In Progress", to: "Resolved", label: "Resolve" },
    { from: "Resolved", to: "Closed", label: "Close" },
    { from: "Resolved", to: "Open", label: "Reopen" },
  ],
  crm: [
    { from: "Prospect", to: "Qualified", label: "Qualify" },
    { from: "Qualified", to: "Proposal Sent", label: "Send proposal" },
    { from: "Proposal Sent", to: "Negotiation", label: "Negotiate" },
    { from: "Negotiation", to: "Won", label: "Close won" },
    { from: "Negotiation", to: "Lost", label: "Close lost" },
    { from: "Qualified", to: "Lost", label: "Disqualify" },
  ],
  hrms: [
    { from: "Draft", to: "Submitted", label: "Submit" },
    { from: "Submitted", to: "Manager Review", label: "Review" },
    { from: "Manager Review", to: "HR Review", label: "Approve" },
    { from: "Manager Review", to: "Rejected", label: "Reject" },
    { from: "HR Review", to: "Approved", label: "Approve" },
    { from: "HR Review", to: "Rejected", label: "Reject" },
  ],
  reimbursements: [
    { from: "Draft", to: "Submitted", label: "Submit" },
    { from: "Submitted", to: "Finance Review", label: "Review" },
    { from: "Finance Review", to: "Approved", label: "Approve" },
    { from: "Finance Review", to: "Rejected", label: "Reject" },
    { from: "Approved", to: "Paid", label: "Mark paid" },
  ],
  projects: [
    { from: "Backlog", to: "To Do", label: "Plan" },
    { from: "To Do", to: "In Progress", label: "Start" },
    { from: "In Progress", to: "Review", label: "Submit for review" },
    { from: "Review", to: "Done", label: "Approve" },
    { from: "Review", to: "In Progress", label: "Request changes" },
    { from: "To Do", to: "Cancelled", label: "Cancel" },
  ],
  invoicing: [
    { from: "Draft", to: "Sent", label: "Send" },
    { from: "Sent", to: "Partially Paid", label: "Partial payment" },
    { from: "Partially Paid", to: "Paid", label: "Full payment" },
    { from: "Sent", to: "Paid", label: "Mark paid" },
    { from: "Sent", to: "Void", label: "Void" },
  ],
  procurement: [
    { from: "Draft", to: "Pending Approval", label: "Submit" },
    { from: "Pending Approval", to: "Approved", label: "Approve" },
    { from: "Pending Approval", to: "Cancelled", label: "Reject" },
    { from: "Approved", to: "Ordered", label: "Place order" },
    { from: "Ordered", to: "Delivered", label: "Confirm delivery" },
    { from: "Ordered", to: "Cancelled", label: "Cancel" },
  ],
};

const FIELD_TYPE_LABEL: Record<string, string> = {
  text: "Text",
  longtext: "Long Text",
  number: "Number",
  currency: "Currency",
  date: "Date",
  datetime: "Date & Time",
  boolean: "Yes / No",
  enum: "Dropdown",
  multi_enum: "Multi-select",
};

const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  standard: "Standard",
  pro: "Pro",
  enterprise: "Enterprise",
};

// ── main component ────────────────────────────────────────────────────────────

export function Modules(): React.ReactElement {
  const { data, isLoading, refetch } = useList<Module>({ resource: "modules" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [seeding, setSeeding] = useState(false);

  // Preview modal state
  const [previewTarget, setPreviewTarget] = useState<Module | null>(null);

  // Fork modal state
  const [forkTarget, setForkTarget] = useState<Module | null>(null);
  const [forkName, setForkName] = useState("");
  const [forking, setForking] = useState(false);
  const [existingWorkflowNames, setExistingWorkflowNames] = useState<string[]>(
    [],
  );

  const modules = data?.data ?? [];

  const filtered = useMemo(() => {
    if (!search.trim()) return modules;
    const q = search.trim().toLowerCase();
    return modules.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.slug.toLowerCase().includes(q) ||
        (m.description ?? "").toLowerCase().includes(q),
    );
  }, [modules, search]);

  async function handleSeed(): Promise<void> {
    setSeeding(true);
    setActionError(null);
    try {
      await fetchWithAuth(`${API_URL}/modules/seed`, { method: "POST" });
      await refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Seed failed");
    } finally {
      setSeeding(false);
    }
  }

  function openForkModal(mod: Module): void {
    setForkTarget(mod);
    setForkName(MODULE_DEFAULT_NAMES[mod.slug] ?? mod.name);
    setActionError(null);
    void fetchWithAuth(`${API_URL}/workflows`).then((res) => {
      const wfs = (res as { data?: { name: string }[] }).data ?? [];
      setExistingWorkflowNames(wfs.map((w) => w.name.toLowerCase()));
    });
  }

  function closeForkModal(): void {
    setForkTarget(null);
    setForkName("");
    setExistingWorkflowNames([]);
    setActionError(null);
  }

  async function handleFork(): Promise<void> {
    if (!forkTarget) return;
    const name = forkName.trim();
    if (!name) return;
    if (existingWorkflowNames.includes(name.toLowerCase())) {
      setActionError(
        `A workflow named "${name}" already exists. Choose a different name.`,
      );
      return;
    }
    setForking(true);
    setActionError(null);
    try {
      await fetchWithAuth(`${API_URL}/modules/${forkTarget.slug}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowName: name }),
      });
      closeForkModal();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Fork failed");
    } finally {
      setForking(false);
    }
  }

  if (isLoading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading templates…</span>
      </div>
    );
  }

  const nameConflict =
    !!forkName.trim() &&
    existingWorkflowNames.includes(forkName.trim().toLowerCase());

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border-color)",
          borderRadius: "var(--radius-md)",
          padding: "20px 24px",
          marginBottom: "20px",
        }}
      >
        <div
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            marginBottom: "4px",
          }}
        >
          Platform / Templates
        </div>
        <h2
          style={{
            fontSize: "20px",
            fontWeight: 700,
            fontFamily: "var(--font-heading)",
            margin: "0 0 4px",
          }}
        >
          Module Templates
        </h2>
        <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: 0 }}>
          Pre-built blueprints for common business workflows. Fork any template
          to create a named copy — entity types, fields, and state machine
          included. Fork the same template multiple times with different names.
        </p>
      </div>

      {actionError && (
        <div className="alert alert-error" style={{ marginBottom: "16px" }}>
          ⚠ {actionError}
        </div>
      )}

      {/* ── Search bar ──────────────────────────────────────────────────── */}
      <div style={{ marginBottom: "16px" }}>
        <input
          type="text"
          className="mod-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search templates…"
          style={{ width: "100%", maxWidth: "320px" }}
        />
      </div>

      {/* ── Module grid ─────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">⬡</div>
          <h4>No templates found</h4>
          {search ? (
            <p>No templates match "{search}"</p>
          ) : (
            <>
              <p>
                The template registry is empty. Click below to load the built-in
                module templates.
              </p>
              <button
                className="btn-primary"
                onClick={() => void handleSeed()}
                disabled={seeding}
                style={{ marginTop: "12px" }}
              >
                {seeding ? "Seeding…" : "Seed Templates"}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="mod-grid">
          {filtered.map((mod) => {
            const accent = MODULE_COLOR[mod.slug] ?? "var(--accent-primary)";
            const features = MODULE_FEATURES[mod.slug] ?? [];
            return (
              <ModuleCard
                key={mod.slug}
                mod={mod}
                accent={accent}
                features={features}
                onFork={openForkModal}
                onPreview={setPreviewTarget}
              />
            );
          })}
        </div>
      )}

      {/* ── Preview modal ────────────────────────────────────────────────── */}
      {previewTarget && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreviewTarget(null);
          }}
        >
          <div
            style={{
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-color)",
              borderRadius: "var(--radius-lg)",
              width: "100%",
              maxWidth: "580px",
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              boxShadow: "var(--shadow-lg)",
              overflow: "hidden",
            }}
          >
            {/* header */}
            <div
              style={{
                padding: "20px 24px 16px",
                borderBottom: "1px solid var(--border-color)",
                display: "flex",
                alignItems: "center",
                gap: "14px",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: "48px",
                  height: "48px",
                  borderRadius: "10px",
                  background: `${MODULE_COLOR[previewTarget.slug] ?? "var(--accent-primary)"}18`,
                  border: `1px solid ${MODULE_COLOR[previewTarget.slug] ?? "var(--accent-primary)"}33`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "26px",
                  flexShrink: 0,
                }}
              >
                {MODULE_EMOJI[previewTarget.slug] ?? "📋"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "17px",
                    fontWeight: 700,
                    color: "var(--text-primary)",
                  }}
                >
                  {previewTarget.name}
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    marginTop: "2px",
                  }}
                >
                  {previewTarget.description ??
                    `Pre-built ${previewTarget.name.toLowerCase()} workflow template`}
                </div>
              </div>
              <button
                onClick={() => setPreviewTarget(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: "22px",
                  cursor: "pointer",
                  lineHeight: 1,
                  padding: "0 4px",
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>

            {/* scrollable body */}
            <div
              style={{
                overflowY: "auto",
                padding: "20px 24px",
                display: "flex",
                flexDirection: "column",
                gap: "24px",
              }}
            >
              {/* ── States ── */}
              <div>
                <SectionLabel>Workflow States</SectionLabel>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {(MODULE_STATES[previewTarget.slug] ?? []).map((s, i) => {
                    const accent =
                      MODULE_COLOR[previewTarget.slug] ??
                      "var(--accent-primary)";
                    return (
                      <span
                        key={s.name}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          padding: "5px 12px",
                          borderRadius: "20px",
                          fontSize: "12px",
                          fontWeight: 500,
                          background: s.terminal
                            ? "var(--bg-tertiary)"
                            : `${accent}15`,
                          border: `1px solid ${s.terminal ? "var(--border-color)" : `${accent}40`}`,
                          color: s.terminal ? "var(--text-muted)" : accent,
                        }}
                      >
                        <span
                          style={{
                            fontSize: "10px",
                            opacity: 0.5,
                            minWidth: "12px",
                          }}
                        >
                          {i + 1}
                        </span>
                        {s.name}
                        {s.terminal && (
                          <span
                            style={{
                              fontSize: "9px",
                              opacity: 0.55,
                              fontWeight: 400,
                            }}
                          >
                            END
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* ── Transitions ── */}
              {(MODULE_TRANSITIONS[previewTarget.slug] ?? []).length > 0 && (
                <div>
                  <SectionLabel>Transitions</SectionLabel>
                  <div
                    style={{
                      borderRadius: "var(--radius-sm)",
                      overflow: "hidden",
                      border: "1px solid var(--border-color)",
                    }}
                  >
                    {(MODULE_TRANSITIONS[previewTarget.slug] ?? []).map(
                      (t, i) => (
                        <div
                          key={`${t.from}-${t.to}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                            padding: "9px 14px",
                            background:
                              i % 2 === 0
                                ? "var(--bg-primary)"
                                : "var(--bg-tertiary)",
                            fontSize: "12px",
                          }}
                        >
                          <span
                            style={{
                              color: "var(--text-primary)",
                              fontWeight: 500,
                              flex: 1,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {t.from}
                          </span>
                          <span
                            style={{
                              color: "var(--text-muted)",
                              fontSize: "11px",
                              background: "var(--bg-tertiary)",
                              border: "1px solid var(--border-color)",
                              borderRadius: "4px",
                              padding: "2px 8px",
                              whiteSpace: "nowrap",
                              flexShrink: 0,
                            }}
                          >
                            {t.label}
                          </span>
                          <span
                            style={{
                              color: "var(--text-muted)",
                              fontSize: "14px",
                              flexShrink: 0,
                            }}
                          >
                            →
                          </span>
                          <span
                            style={{
                              color: "var(--text-primary)",
                              fontWeight: 500,
                              flex: 1,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              textAlign: "right",
                            }}
                          >
                            {t.to}
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              )}

              {/* ── Fields ── */}
              <div>
                <SectionLabel>Fields</SectionLabel>
                <div
                  style={{
                    borderRadius: "var(--radius-sm)",
                    overflow: "hidden",
                    border: "1px solid var(--border-color)",
                  }}
                >
                  {(MODULE_FIELDS[previewTarget.slug] ?? []).map((f, i) => (
                    <div
                      key={f.label}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "9px 14px",
                        background:
                          i % 2 === 0
                            ? "var(--bg-primary)"
                            : "var(--bg-tertiary)",
                        fontSize: "13px",
                      }}
                    >
                      <span
                        style={{
                          color: "var(--text-primary)",
                          fontWeight: 500,
                        }}
                      >
                        {f.label}
                      </span>
                      <span
                        style={{
                          color: "var(--text-muted)",
                          fontSize: "11px",
                          background: "var(--bg-tertiary)",
                          border: "1px solid var(--border-color)",
                          borderRadius: "4px",
                          padding: "2px 7px",
                        }}
                      >
                        {FIELD_TYPE_LABEL[f.type] ?? f.type}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── What's Included ── */}
              <div>
                <SectionLabel>What's Included</SectionLabel>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                  }}
                >
                  {(MODULE_FEATURES[previewTarget.slug] ?? []).map((f) => (
                    <div
                      key={f}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      <span
                        style={{ color: "hsl(150,75%,45%)", fontSize: "13px" }}
                      >
                        ✓
                      </span>
                      {f}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* footer */}
            <div
              style={{
                padding: "14px 24px 20px",
                borderTop: "1px solid var(--border-color)",
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
                flexShrink: 0,
              }}
            >
              <button
                className="btn-secondary"
                onClick={() => setPreviewTarget(null)}
              >
                Close
              </button>
              {!previewTarget.isSystem && (
                <button
                  className="btn-primary"
                  style={{
                    background: `linear-gradient(135deg, ${MODULE_COLOR[previewTarget.slug] ?? "var(--accent-primary)"}, ${MODULE_COLOR[previewTarget.slug] ?? "var(--accent-primary)"}cc)`,
                  }}
                  onClick={() => {
                    setPreviewTarget(null);
                    openForkModal(previewTarget);
                  }}
                >
                  Fork Template
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Fork modal ───────────────────────────────────────────────────── */}
      {forkTarget && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeForkModal();
          }}
        >
          <div
            style={{
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-color)",
              borderRadius: "var(--radius-lg)",
              width: "100%",
              maxWidth: "480px",
              boxShadow: "var(--shadow-lg)",
              overflow: "hidden",
            }}
          >
            {/* modal header */}
            <div
              style={{
                padding: "20px 24px 16px",
                borderBottom: "1px solid var(--border-color)",
                display: "flex",
                alignItems: "center",
                gap: "14px",
              }}
            >
              <div
                style={{
                  width: "46px",
                  height: "46px",
                  borderRadius: "10px",
                  background: `${MODULE_COLOR[forkTarget.slug] ?? "var(--accent-primary)"}18`,
                  border: `1px solid ${MODULE_COLOR[forkTarget.slug] ?? "var(--accent-primary)"}33`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "24px",
                  flexShrink: 0,
                }}
              >
                {MODULE_EMOJI[forkTarget.slug] ?? "📋"}
              </div>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontSize: "16px",
                    fontWeight: 700,
                    color: "var(--text-primary)",
                  }}
                >
                  Fork "{forkTarget.name}"
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    marginTop: "2px",
                  }}
                >
                  Creates a named copy — entity type, fields, and workflow ready
                  to use.
                </div>
              </div>
              <button
                onClick={closeForkModal}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: "20px",
                  cursor: "pointer",
                  lineHeight: 1,
                  padding: "0 4px",
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>

            {/* modal body */}
            <div style={{ padding: "20px 24px" }}>
              {/* what gets created */}
              <div
                style={{
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "var(--radius-sm)",
                  padding: "12px 14px",
                  marginBottom: "20px",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    marginBottom: "8px",
                  }}
                >
                  What gets created
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  {(MODULE_FEATURES[forkTarget.slug] ?? []).map((f) => (
                    <div
                      key={f}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      <span
                        style={{ color: "hsl(150,75%,45%)", fontSize: "12px" }}
                      >
                        ✓
                      </span>
                      {f}
                    </div>
                  ))}
                </div>
              </div>

              {/* workflow name input */}
              <div className="form-group">
                <label className="form-label">Workflow Name</label>
                <input
                  type="text"
                  className="form-input"
                  value={forkName}
                  onChange={(e) => {
                    setForkName(e.target.value);
                    setActionError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !nameConflict && forkName.trim())
                      void handleFork();
                    if (e.key === "Escape") closeForkModal();
                  }}
                  placeholder="e.g. Customer Support Tickets"
                  autoFocus
                />
                <div className="form-hint">
                  Names the workflow created from this template. Must be unique.
                </div>
                {nameConflict && (
                  <div
                    style={{
                      marginTop: "6px",
                      fontSize: "12px",
                      color: "var(--danger)",
                    }}
                  >
                    ⚠ A workflow with this name already exists.
                  </div>
                )}
              </div>

              {actionError && (
                <div
                  className="alert alert-error"
                  style={{ marginTop: "12px" }}
                >
                  ⚠ {actionError}
                </div>
              )}
            </div>

            {/* modal footer */}
            <div
              style={{
                padding: "14px 24px 20px",
                borderTop: "1px solid var(--border-color)",
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
              }}
            >
              <button
                className="btn-secondary"
                onClick={closeForkModal}
                disabled={forking}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => void handleFork()}
                disabled={forking || !forkName.trim() || nameConflict}
                style={{ minWidth: "120px" }}
              >
                {forking ? "Forking…" : "Fork Template"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ModuleCard ────────────────────────────────────────────────────────────────

function ModuleCard({
  mod,
  accent,
  features,
  onFork,
  onPreview,
}: {
  mod: Module;
  accent: string;
  features: string[];
  onFork: (mod: Module) => void;
  onPreview: (mod: Module) => void;
}): React.ReactElement {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: "var(--bg-card)",
        border: `1px solid ${hovered ? accent + "55" : "var(--border-color)"}`,
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        transition: "border-color .15s, box-shadow .15s",
        boxShadow: hovered ? `0 4px 20px ${accent}22` : "none",
        position: "relative",
      }}
    >
      {/* top accent stripe */}
      <div
        style={{
          height: "3px",
          background: `linear-gradient(90deg, ${accent}, ${accent}99)`,
        }}
      />

      {/* card header */}
      <div
        style={{
          padding: "18px 20px 14px",
          display: "flex",
          alignItems: "flex-start",
          gap: "14px",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        {/* icon */}
        <div
          style={{
            width: "48px",
            height: "48px",
            borderRadius: "10px",
            background: `${accent}14`,
            border: `1px solid ${accent}30`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "24px",
            flexShrink: 0,
          }}
        >
          {MODULE_EMOJI[mod.slug] ?? mod.slug.slice(0, 2).toUpperCase()}
        </div>

        {/* name + badges */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
              marginBottom: "6px",
            }}
          >
            <span
              style={{
                fontSize: "15px",
                fontWeight: 700,
                color: "var(--text-primary)",
                fontFamily: "var(--font-heading)",
              }}
            >
              {mod.name}
            </span>
            {mod.isSystem && (
              <span
                className="badge badge-primary"
                style={{ fontSize: "10px" }}
              >
                Core
              </span>
            )}
          </div>

          {/* plan badge */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span
              style={{
                padding: "2px 8px",
                borderRadius: "20px",
                fontSize: "10px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                background: "var(--bg-tertiary)",
                color: "var(--text-muted)",
                border: "1px solid var(--border-color)",
              }}
            >
              {PLAN_LABEL[mod.minPlan] ?? mod.minPlan}
            </span>
          </div>
        </div>
      </div>

      {/* description + features */}
      <div style={{ padding: "14px 20px", flex: 1 }}>
        <p
          style={{
            fontSize: "13px",
            color: "var(--text-secondary)",
            lineHeight: "1.55",
            margin: "0 0 12px",
          }}
        >
          {mod.description ??
            `The ${mod.name} template provides pre-built entity types, state machine workflows, and field definitions ready to customise.`}
        </p>

        {features.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "4px 8px",
            }}
          >
            {features.slice(0, 4).map((f) => (
              <div
                key={f}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "12px",
                  color: "var(--text-muted)",
                }}
              >
                <div
                  style={{
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    background: accent,
                    flexShrink: 0,
                  }}
                />
                {f}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* card footer */}
      <div
        style={{
          padding: "12px 20px 16px",
          borderTop: "1px solid var(--border-color)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <code
            style={{
              fontSize: "11px",
              fontFamily: "monospace",
              color: "var(--text-muted)",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-color)",
              borderRadius: "4px",
              padding: "2px 7px",
            }}
          >
            {mod.slug}
          </code>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            v{mod.version}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            title="Preview template details"
            onClick={() => onPreview(mod)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "30px",
              height: "30px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-color)",
              background: "var(--bg-tertiary)",
              color: "var(--text-muted)",
              cursor: "pointer",
              transition: "background .15s, color .15s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--bg-secondary)";
              (e.currentTarget as HTMLButtonElement).style.color =
                "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--bg-tertiary)";
              (e.currentTarget as HTMLButtonElement).style.color =
                "var(--text-muted)";
            }}
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <path
                d="M7.5 3C4.5 3 2 5.5 1 7.5c1 2 3.5 4.5 6.5 4.5S13 9.5 14 7.5C13 5.5 10.5 3 7.5 3z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <circle
                cx="7.5"
                cy="7.5"
                r="2"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
          </button>
          {!mod.isSystem && (
            <button
              className="btn-primary btn-sm"
              onClick={() => onFork(mod)}
              style={{
                background: `linear-gradient(135deg, ${accent}, ${accent}cc)`,
                boxShadow: `0 2px 8px ${accent}33`,
              }}
            >
              Fork
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
