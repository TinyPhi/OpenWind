import React, { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { showAlert } from "../../components/global-alert-dialog.js";
import type { ScheduleRule } from "./index.js";

interface Execution {
  id: string;
  scheduledAt: string;
  firedAt: string | null;
  status: "success" | "failed" | "skipped";
  ticket: { id: string; title: string | null } | null;
  errorCode: string | null;
}

interface NextFire {
  fireAt: string;
}

/**
 * Schedule Rule detail — execution history + next-fires preview —
 * docs/specs/temporal-scheduler.md T16/T17, R5/R6.
 *
 * The next-fires preview is edit/detail-only: GET .../next-fires requires an
 * existing rule id, so a not-yet-saved rule (create-mode modal) has nothing
 * to preview against.
 */
export function ScheduleRuleDetailPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [rule, setRule] = useState<ScheduleRule | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [nextFires, setNextFires] = useState<NextFire[]>([]);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback((): void => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      fetchWithAuth(`${API_URL}/admin/schedule-rules/${id}`),
      fetchWithAuth(`${API_URL}/admin/schedule-rules/${id}/executions`),
      fetchWithAuth(`${API_URL}/admin/schedule-rules/${id}/next-fires`),
    ])
      .then(([ruleRes, execRes, fireRes]) => {
        setRule((ruleRes as { data: ScheduleRule }).data);
        setExecutions((execRes as { data: Execution[] }).data);
        const fireData = (
          fireRes as { data: { timezone: string; fires: string[] } }
        ).data;
        setTimezone(fireData.timezone);
        setNextFires(fireData.fires.map((f) => ({ fireAt: f })));
      })
      .catch(() => showAlert("Failed to load schedule rule."))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading schedule rule…</span>
      </div>
    );
  }

  if (!rule) {
    return (
      <div className="wfl-empty">
        <h4>Schedule rule not found</h4>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className="portal-back-link"
        onClick={() => navigate("/admin/schedule-rules")}
      >
        ← Schedule Rules
      </button>
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">{rule.name}</h2>
          <p className="page-subtitle">
            {rule.cronHuman ?? rule.cronExpr} ({rule.timezone}) — {rule.status}
          </p>
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <h3 className="page-title" style={{ fontSize: 16 }}>
          Next fires
        </h3>
        {nextFires.length === 0 ? (
          <p className="page-subtitle">
            No upcoming fires (rule is paused or archived).
          </p>
        ) : (
          <ul>
            {nextFires.map((f) => (
              <li key={f.fireAt}>
                {new Date(f.fireAt).toLocaleString()}
                {timezone ? ` (${timezone})` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ marginTop: 32 }}>
        <h3 className="page-title" style={{ fontSize: 16 }}>
          Execution history
        </h3>
        {executions.length === 0 ? (
          <div className="wfl-empty">
            <h4>No executions yet</h4>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scheduled</TableHead>
                <TableHead>Fired</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Ticket</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {executions.map((exec) => (
                <TableRow key={exec.id}>
                  <TableCell>
                    {new Date(exec.scheduledAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {exec.firedAt
                      ? new Date(exec.firedAt).toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell>{exec.status}</TableCell>
                  <TableCell>
                    {exec.ticket ? (
                      <Link to={`/records/ticket/${exec.ticket.id}`}>
                        {exec.ticket.title ?? exec.ticket.id}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {exec.errorCode ? (
                      <span className="alert-badge">{exec.errorCode}</span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
