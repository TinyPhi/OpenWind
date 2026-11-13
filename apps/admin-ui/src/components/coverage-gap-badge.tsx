import React from "react";
import { useTranslation } from "react-i18next";
import { useTeamCoverageGap } from "../lib/oncall-coverage.js";

/**
 * "No on-call coverage" pill for a ticket that has a team, no assignee, and a
 * team with no active on-call schedule (docs/specs/oncall-routing.md R9/T19).
 * Staff only: `enabled` must reflect an actual admin or agent role, because the
 * endpoint behind it is agent/admin-only. Renders nothing while loading, on a
 * failed lookup, for a covered team, and for an assigned ticket (no request is
 * made for any of those that can be decided without one).
 */
export function CoverageGapBadge({
  teamId,
  assignedTo,
  enabled,
}: {
  teamId: string | null;
  assignedTo: string | null;
  enabled: boolean;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const unassignedWithTeam = !assignedTo && !!teamId;
  const inGap = useTeamCoverageGap(unassignedWithTeam ? teamId : null, enabled);
  if (!inGap) return null;

  return (
    <span
      role="status"
      title={t("severity.noCoverageTooltip")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 7px",
        borderRadius: "20px",
        fontSize: "10.5px",
        fontWeight: 600,
        background: "color-mix(in srgb, var(--warning) 14%, transparent)",
        color: "var(--warning)",
        border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)",
        whiteSpace: "nowrap",
      }}
    >
      {t("severity.noCoverage")}
    </span>
  );
}
