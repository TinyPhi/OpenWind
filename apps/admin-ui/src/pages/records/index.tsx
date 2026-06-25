import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { useEntityTypes } from "../../entity-type-context.js";

function toWorkflowSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

type Workflow = {
  id: string;
  name: string;
  entityTypeId: string;
  initialState: string;
  recordCount: number;
  states: {
    name: string;
    label: string;
    color: string | null;
    isTerminal: boolean;
  }[];
  transitions: { id: string }[];
};

const CARD_GRADIENTS = [
  "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
  "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
  "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
  "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
  "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)",
  "linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)",
];

export function AdminRecords(): React.ReactElement {
  const navigate = useNavigate();
  const { entityTypes } = useEntityTypes();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWithAuth(`${API_URL}/workflows`)
      .then((res) => {
        setWorkflows((res as { data?: Workflow[] }).data ?? []);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
  }, []);

  const etMap = new Map(entityTypes.map((e) => [e.id, e]));

  if (loading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading records…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <div className="empty-icon">⚠</div>
        <h4>Failed to load</h4>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "28px",
        }}
      >
        <div>
          <h2 className="page-title">Records</h2>
          <p className="page-subtitle">
            Browse all workflow record types. Click a card to view and manage
            its records.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <div className="stat-pill">{workflows.length} workflows</div>
        </div>
      </div>

      {workflows.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <h4>No workflows yet</h4>
          <p>Create a workflow to start tracking records.</p>
          <button
            className="btn-primary"
            style={{ marginTop: "16px" }}
            onClick={() => navigate("/workflows/new")}
          >
            + New Workflow
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: "20px",
          }}
        >
          {workflows.map((wf, i) => {
            const et = etMap.get(wf.entityTypeId);
            const wfSlug = toWorkflowSlug(wf.name);
            const gradient = CARD_GRADIENTS[i % CARD_GRADIENTS.length];
            const activeStates = wf.states.filter((s) => !s.isTerminal);
            const terminalStates = wf.states.filter((s) => s.isTerminal);

            return (
              <div
                key={wf.id}
                onClick={() => navigate(`/workflows/${wfSlug}/records`)}
                style={{
                  borderRadius: "16px",
                  overflow: "hidden",
                  cursor: "pointer",
                  border: "1px solid var(--border-color)",
                  background: "var(--bg-secondary)",
                  transition: "transform .15s, box-shadow .15s",
                  boxShadow: "var(--shadow-sm)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.transform =
                    "translateY(-3px)";
                  (e.currentTarget as HTMLDivElement).style.boxShadow =
                    "var(--shadow-lg)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.transform =
                    "translateY(0)";
                  (e.currentTarget as HTMLDivElement).style.boxShadow =
                    "var(--shadow-sm)";
                }}
              >
                {/* Gradient header */}
                <div
                  style={{
                    background: gradient,
                    padding: "24px 24px 20px",
                    position: "relative",
                  }}
                >
                  {wf.recordCount > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        top: "12px",
                        right: "12px",
                        background: "rgba(255,255,255,.25)",
                        backdropFilter: "blur(4px)",
                        borderRadius: "20px",
                        padding: "2px 10px",
                        fontSize: "11px",
                        fontWeight: 600,
                        color: "#fff",
                      }}
                    >
                      {wf.recordCount} record{wf.recordCount !== 1 ? "s" : ""}
                    </div>
                  )}
                  <div style={{ fontSize: "32px", marginBottom: "8px" }}>
                    {et?.icon ?? "📋"}
                  </div>
                  <div
                    style={{
                      fontSize: "18px",
                      fontWeight: 700,
                      color: "#fff",
                      lineHeight: 1.2,
                    }}
                  >
                    {wf.name}
                  </div>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "rgba(255,255,255,.75)",
                      marginTop: "4px",
                    }}
                  >
                    {wf.states.length} states · {wf.transitions.length}{" "}
                    transitions
                  </div>
                </div>

                {/* Card body */}
                <div style={{ padding: "16px 20px 20px" }}>
                  {/* State pills */}
                  <div
                    style={{
                      display: "flex",
                      gap: "6px",
                      flexWrap: "wrap",
                      marginBottom: "16px",
                    }}
                  >
                    {activeStates.slice(0, 4).map((s) => (
                      <span
                        key={s.name}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          padding: "2px 8px",
                          borderRadius: "20px",
                          fontSize: "11px",
                          fontWeight: 500,
                          background: s.color
                            ? `${s.color}22`
                            : "var(--bg-tertiary)",
                          color: s.color ?? "var(--text-muted)",
                          border: `1px solid ${s.color ? `${s.color}44` : "var(--border-color)"}`,
                        }}
                      >
                        <span
                          style={{
                            width: "6px",
                            height: "6px",
                            borderRadius: "50%",
                            background: s.color ?? "var(--text-muted)",
                            flexShrink: 0,
                          }}
                        />
                        {s.label}
                      </span>
                    ))}
                    {terminalStates.length > 0 && (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          padding: "2px 8px",
                          borderRadius: "20px",
                          fontSize: "11px",
                          color: "var(--text-muted)",
                          background: "var(--bg-tertiary)",
                          border: "1px solid var(--border-color)",
                        }}
                      >
                        ⬡ {terminalStates[0]?.label}
                      </span>
                    )}
                  </div>

                  <button
                    className="btn-primary"
                    style={{ width: "100%", justifyContent: "center" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/workflows/${wfSlug}/records`);
                    }}
                  >
                    View Records →
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
