import { useTranslation } from "react-i18next";
import React from "react";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import {
  ACTION_LABEL,
  groupByDay,
  relativeTime,
  shortId,
  type AuditEntry,
  type PlatformAdminAction,
} from "./format.js";

const PAGE_SIZE = 20;

type ActionFilter = "all" | PlatformAdminAction;

export interface ActivityTimelineProps {
  /** Narrows to one tenant's actions; omitted = every platform-admin action. */
  targetTenantId?: string;
  /** Tenant id -> name, from the dashboard's tenant list. A miss means the tenant is gone. */
  tenantNames: ReadonlyMap<string, string>;
  currentUserId: string | null;
  /** Bumped by the parent after a create/reset/delete so the timeline reloads. */
  refreshKey: number;
  /** Per-tenant drawer view: no action filter, no tenant name on each entry. */
  compact?: boolean;
}

/**
 * T16's platform_admin_audit_log as a timeline (completed create/reset/delete actions only,
 * spec R9). Keyset-paged through GET /platform-admin/audit-log's `before` cursor.
 */
export function ActivityTimeline({
  targetTenantId,
  tenantNames,
  currentUserId,
  refreshKey,
  compact = false,
}: ActivityTimelineProps): React.ReactElement {
  const { t } = useTranslation();
  const [entries, setEntries] = React.useState<AuditEntry[] | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<ActionFilter>("all");

  const fetchPage = React.useCallback(
    async (before?: string): Promise<AuditEntry[]> => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (before) params.set("before", before);
      if (targetTenantId) params.set("targetTenantId", targetTenantId);
      const res = await fetchWithAuth(
        `${API_URL}/platform-admin/audit-log?${params.toString()}`,
      );
      // fetchWithAuth returns unknown; { data: AuditEntry[] } is the
      // platform-admin/audit-log contract.
      return (res as { data: AuditEntry[] }).data;
    },
    [targetTenantId],
  );

  React.useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    fetchPage()
      .then((page) => {
        if (cancelled) return;
        setEntries(page);
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : t("platformAdmin.couldNotLoadActivity"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, refreshKey]);

  async function loadMore(): Promise<void> {
    const last = entries?.[entries.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(last.id);
      setEntries((prev) => [...(prev ?? []), ...page]);
      setHasMore(page.length === PAGE_SIZE);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("platformAdmin.couldNotLoadActivity"),
      );
    } finally {
      setLoadingMore(false);
    }
  }

  if (error) {
    return (
      <p role="alert" style={{ color: "var(--danger)" }}>
        {error}
      </p>
    );
  }

  if (entries === null) {
    return (
      <div aria-label="Loading activity">
        {[0, 1, 2].map((i) => (
          <div key={i} className="pa-skeleton" style={{ marginBottom: 12 }} />
        ))}
      </div>
    );
  }

  const visible =
    filter === "all" ? entries : entries.filter((e) => e.action === filter);

  return (
    <div>
      {!compact && (
        <div className="pa-toolbar">
          <select
            className="pa-select"
            aria-label="Filter activity by action"
            value={filter}
            // The <option> values below are exactly ActionFilter's members.
            onChange={(e) => setFilter(e.target.value as ActionFilter)}
          >
            <option value="all">{t("platformAdmin.allActions")}</option>
            <option value="sandbox.created">
              {t("platformAdmin.actionCreated")}
            </option>
            <option value="sandbox.reset">
              {t("platformAdmin.actionReset")}
            </option>
            <option value="sandbox.deleted">
              {t("platformAdmin.actionDeleted")}
            </option>
            <option value="sandbox.trial_changed">
              {t("platformAdmin.actionTrialExtended")}
            </option>
            <option value="sandbox.trial_ended">
              {t("platformAdmin.actionTrialEnded")}
            </option>
          </select>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="pa-muted">{t("platformAdmin.noActivity")}</p>
      ) : (
        groupByDay(visible).map((group) => (
          <div key={group.label}>
            <div className="pa-tl-day">{group.label}</div>
            <ul className="pa-tl-list">
              {group.entries.map((entry) => (
                <TimelineItem
                  key={entry.id}
                  entry={entry}
                  tenantName={tenantNames.get(entry.targetTenantId)}
                  isCurrentUser={entry.actorSub === currentUserId}
                  compact={compact}
                />
              ))}
            </ul>
          </div>
        ))
      )}

      {hasMore && (
        <Button
          variant="secondary"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore
            ? t("platformAdmin.loadingMore")
            : t("platformAdmin.loadMore")}
        </Button>
      )}
    </div>
  );
}

function TimelineItem({
  entry,
  tenantName,
  isCurrentUser,
  compact,
}: {
  entry: AuditEntry;
  tenantName: string | undefined;
  isCurrentUser: boolean;
  compact: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const dotClass = `pa-tl-dot pa-tl-dot-${entry.action.split(".")[1] ?? "created"}`;
  const target =
    tenantName ?? `Deleted tenant ${shortId(entry.targetTenantId)}`;
  return (
    <li className="pa-tl-item">
      <span className={dotClass} aria-hidden="true" />
      <div className="pa-tl-title">
        {ACTION_LABEL[entry.action]}
        {!compact && (
          <>
            {" "}
            <span aria-hidden="true">·</span> <strong>{target}</strong>
          </>
        )}
      </div>
      <div className="pa-tl-meta">
        {isCurrentUser
          ? t("platformAdmin.you")
          : t("platformAdmin.adminLabel", { id: shortId(entry.actorSub) })}{" "}
        ·{" "}
        <time
          dateTime={entry.createdAt}
          title={new Date(entry.createdAt).toLocaleString()}
        >
          {relativeTime(entry.createdAt)}
        </time>
      </div>
    </li>
  );
}
