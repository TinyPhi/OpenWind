import React, { useEffect, useState } from "react";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";

interface Failure {
  channel: string;
  occurredAt: string;
}

function parseFailures(res: unknown): Failure[] {
  // fetchWithAuth returns unknown; the shape is narrowed row by row below.
  const rows = (res as { data?: { failures?: unknown } }).data?.failures;
  if (!Array.isArray(rows)) return [];
  const failures: Failure[] = [];
  // rows is unknown (it came off the wire); each field is typeof-checked in the loop.
  for (const row of rows as { channel?: unknown; occurredAt?: unknown }[]) {
    if (typeof row.channel === "string" && typeof row.occurredAt === "string") {
      failures.push({ channel: row.channel, occurredAt: row.occurredAt });
    }
  }
  return failures;
}

/**
 * "Notification failed" pill for a ticket whose on-call notification could not
 * be delivered on a channel in the last 24 hours (docs/specs/oncall-routing.md
 * R18/T33). Staff only: `enabled` must reflect an actual admin or agent role,
 * because the endpoint behind it is agent/admin-only. Shows the channels and
 * how long ago the latest failure was, never the provider's error text (the
 * endpoint does not return it). Renders nothing while loading, on a failed
 * lookup, and when there is no failure; no request is made when disabled.
 */
export function NotificationFailureBadge({
  ticketId,
  enabled,
}: {
  ticketId: string;
  enabled: boolean;
}): React.ReactElement | null {
  const [failures, setFailures] = useState<Failure[]>([]);

  useEffect(() => {
    setFailures([]);
    if (!enabled) return;
    let cancelled = false;
    fetchWithAuth(`${API_URL}/entities/${ticketId}/notification-failures`).then(
      (res) => {
        if (!cancelled) setFailures(parseFailures(res));
      },
      () => {
        if (!cancelled) setFailures([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ticketId, enabled]);

  // The API returns newest first.
  const latest = failures[0]?.occurredAt;
  if (!enabled || latest === undefined) return null;

  const channels = [...new Set(failures.map((f) => f.channel))];

  return (
    <span
      role="status"
      title="A notification for this ticket could not be delivered in the last 24 hours."
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 7px",
        borderRadius: "20px",
        fontSize: "10.5px",
        fontWeight: 600,
        background: "color-mix(in srgb, var(--danger) 12%, transparent)",
        color: "var(--danger)",
        border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
        whiteSpace: "nowrap",
      }}
    >
      Notification failed: {channels.join(", ")} · {relativeTime(latest)}
    </span>
  );
}
