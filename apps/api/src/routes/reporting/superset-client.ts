import { env } from "@platform/config";
import { logger } from "@platform/logger";

/**
 * Superset's HTTP surface, as far as reporting needs it.
 *
 * Every call goes to SUPERSET_INTERNAL_URL — the container-internal address.
 * SUPERSET_SITE_URL is the browser-facing one and must never be used here: the
 * two differ in any real deployment, and using the wrong one either fails to
 * resolve or sends the service-account credential somewhere it should not go.
 *
 * Spec: docs/specs/superset-embedded-dashboarding.md
 */

/** A row filter Superset ANDs into every query the dashboard generates. */
export type RlsRule = {
  clause: string;
  /**
   * Superset's own wire field: the numeric dataset this clause is restricted
   * to. Resolved from `datasetTable` at mint time — never set by the caller,
   * because the id is per-environment.
   */
  dataset?: number;
  /**
   * Ours, not Superset's. The table this clause may be applied to, named
   * rather than numbered so the caller can stay declarative.
   *
   * Omit it deliberately for a clause that must apply everywhere — the tenant
   * filter is the one such case, since every reporting table carries
   * `tenant_id` and a tenant clause that missed a dataset would be a hole.
   */
  datasetTable?: string;
};

export class SupersetUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SupersetUnavailableError";
  }
}

type SupersetSession = {
  accessToken: string;
  csrfToken: string;
  cookie: string;
};

function supersetUrl(path: string): string {
  return `${env.SUPERSET_INTERNAL_URL.replace(/\/$/, "")}${path}`;
}

async function login(): Promise<string> {
  const response = await fetch(supersetUrl("/api/v1/security/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: env.SUPERSET_SERVICE_ACCOUNT_USER,
      password: env.SUPERSET_SERVICE_ACCOUNT_PASSWORD,
      provider: "db",
      refresh: false,
    }),
  });

  if (!response.ok) {
    // Deliberately does not include the response body: it can echo the
    // submitted credential back on some failures.
    throw new SupersetUnavailableError(
      `Superset login failed with status ${response.status}`,
    );
  }

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new SupersetUnavailableError(
      "Superset login returned no access token",
    );
  }
  return body.access_token;
}

/**
 * Fetch a CSRF token *and the session cookie it belongs to*.
 *
 * Both are required. Superset ties the CSRF token to the session that issued
 * it, so sending the token without its cookie fails with "CSRF session token is
 * missing" — a 400 that reads like a malformed request rather than a missing
 * cookie, which is why this returns the pair rather than just the token.
 */
async function getCsrfToken(
  accessToken: string,
): Promise<{ token: string; cookie: string }> {
  const response = await fetch(supersetUrl("/api/v1/security/csrf_token/"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new SupersetUnavailableError(
      `Superset CSRF token request failed with status ${response.status}`,
    );
  }

  const body = (await response.json()) as { result?: string };
  const cookie = response.headers.get("set-cookie");
  if (!body.result || !cookie) {
    throw new SupersetUnavailableError(
      "Superset CSRF response was missing the token or its session cookie",
    );
  }
  return { token: body.result, cookie };
}

async function openSession(): Promise<SupersetSession> {
  const accessToken = await login();
  const { token: csrfToken, cookie } = await getCsrfToken(accessToken);
  return { accessToken, csrfToken, cookie };
}

/**
 * Resolve a dashboard's *embedded* uuid from its slug.
 *
 * Superset holds two identifiers per dashboard and only one of them works for
 * embedding. The embedded uuid is generated when embedding is enabled, so it
 * cannot be pinned from configuration — and hardcoding one in source breaks a
 * fresh clone, because provisioning will have generated a different value. The
 * slug is the stable, configurable handle; this resolves it at runtime.
 *
 * Passing the dashboard's own uuid instead is a trap worth knowing about: the
 * mint succeeds and every dashboard API call the embed makes then 404s.
 */
export async function resolveEmbeddedId(
  slug: string,
  session: SupersetSession,
): Promise<string> {
  const response = await fetch(
    supersetUrl(`/api/v1/dashboard/${encodeURIComponent(slug)}/embedded`),
    { headers: { Authorization: `Bearer ${session.accessToken}` } },
  );

  if (!response.ok) {
    throw new SupersetUnavailableError(
      `Could not resolve embedded id for dashboard '${slug}' (status ${response.status})`,
    );
  }

  const body = (await response.json()) as { result?: { uuid?: string } };
  const uuid = body.result?.uuid;
  if (!uuid) {
    // Reached when the dashboard exists but was never marked embeddable —
    // provisioning did not complete, rather than Superset being down.
    throw new SupersetUnavailableError(
      `Dashboard '${slug}' is not embeddable — provisioning may not have run`,
    );
  }
  return uuid;
}

/**
 * Resolve a dataset's numeric id by table name.
 *
 * Resolved at runtime, never configured, for the same reason dashboards are
 * addressed by slug: dataset ids are per-environment integers assigned by
 * whatever order provisioning happened to run in. A literal here would be
 * correct on one deployment and silently wrong on the next.
 *
 * This exists so a row filter can name the dataset it applies to. A rule with
 * no dataset is applied by Superset to *every* dataset on the dashboard, with
 * the clause injected as raw SQL and no column checking — so a per-user filter
 * naming `assigned_to` breaks every tile built on a table that has no such
 * column.
 */
export async function resolveDatasetId(
  tableName: string,
  session: SupersetSession,
): Promise<number> {
  // Matched on the connection as well as the table name. A table name is not
  // unique across Superset connections: a stale connection carrying a dataset
  // of the same name makes the lookup order-dependent, and picking the wrong
  // id silently detaches the row filter that id scopes — the filter then
  // applies to a dataset no tile reads, so it constrains nothing and the
  // caller sees more rows, not an error. Observed live: two
  // `entity_instances` datasets, one on an orphaned connection.
  //
  // The connection is matched below on the response rather than in the query
  // because Superset's own `database` filter takes a numeric connection id,
  // which is per-environment and would need `can_read` on Database to resolve
  // — a permission this account otherwise has no use for. The listing already
  // carries `database.database_name`, so matching here grants nothing.
  const query = encodeURIComponent(
    JSON.stringify({
      filters: [{ col: "table_name", opr: "eq", value: tableName }],
    }),
  );
  const response = await fetch(supersetUrl(`/api/v1/dataset/?q=${query}`), {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });

  if (!response.ok) {
    throw new SupersetUnavailableError(
      `Could not resolve dataset '${tableName}' (status ${response.status})`,
    );
  }

  const body = (await response.json()) as {
    result?: { id?: number; database?: { database_name?: string } }[];
  };
  const matches = (body.result ?? []).filter(
    (row) => row.database?.database_name === env.SUPERSET_REPORTING_DB_NAME,
  );
  if (matches.length > 1) {
    // Refused rather than resolved. Guessing here would silently mis-scope a
    // row filter, which fails open — the caller sees data rather than an error.
    throw new SupersetUnavailableError(
      `Dataset '${tableName}' is ambiguous — ${matches.length} matches on connection '${env.SUPERSET_REPORTING_DB_NAME}'`,
    );
  }
  const id = matches[0]?.id;
  if (typeof id !== "number") {
    // The dataset is missing, not Superset being down — provisioning did not
    // complete. Distinguished in the message because the remedy is different.
    throw new SupersetUnavailableError(
      `Dataset '${tableName}' is not registered — provisioning may not have run`,
    );
  }
  return id;
}

/**
 * The datasets a dashboard's tiles actually read.
 *
 * Used to prove every one of them is covered by a row filter before a pass is
 * minted. Superset returns a dataset with no rule attached *unfiltered*, so an
 * uncovered dataset is not a missing tile — it is every row in the tenant,
 * rendered under whatever personal label the tile carries.
 */
export async function listDashboardDatasets(
  slug: string,
  session: SupersetSession,
): Promise<string[]> {
  const response = await fetch(
    supersetUrl(`/api/v1/dashboard/${encodeURIComponent(slug)}/datasets`),
    { headers: { Authorization: `Bearer ${session.accessToken}` } },
  );

  if (!response.ok) {
    throw new SupersetUnavailableError(
      `Could not list datasets for dashboard '${slug}' (status ${response.status})`,
    );
  }

  const body = (await response.json()) as {
    result?: { table_name?: string }[];
  };
  return (body.result ?? [])
    .map((row) => row.table_name)
    .filter((name): name is string => typeof name === "string");
}

/**
 * Mint a guest token for one dashboard, carrying its row filters.
 *
 * `username` is load-bearing beyond identification: Superset hands it to
 * DB_CONNECTION_MUTATOR, which stamps it onto the database connection as
 * app.tenant_id so the platform's row-level security applies to every query the
 * dashboard runs. It must therefore be the tenant id, and nothing else — see
 * docker/superset/superset_config.py.
 */
export async function mintGuestToken(
  embeddedId: string,
  tenantId: string,
  rls: RlsRule[],
  session: SupersetSession,
): Promise<string> {
  const response = await fetch(supersetUrl("/api/v1/security/guest_token/"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessToken}`,
      "X-CSRFToken": session.csrfToken,
      Cookie: session.cookie,
    },
    body: JSON.stringify({
      user: { username: tenantId },
      resources: [{ type: "dashboard", id: embeddedId }],
      rls,
    }),
  });

  if (!response.ok) {
    throw new SupersetUnavailableError(
      `Superset guest-token mint failed with status ${response.status}`,
    );
  }

  const body = (await response.json()) as { token?: string };
  if (!body.token) {
    throw new SupersetUnavailableError(
      "Superset guest-token response had no token",
    );
  }
  return body.token;
}

/** Open a session, resolve the dashboard, and mint — the whole mint path. */
export async function mintDashboardPass(
  slug: string,
  tenantId: string,
  rls: RlsRule[],
  // Only the per-viewer dashboard needs this. On a tenant-wide dashboard the
  // tenant clause is deliberately unscoped — it applies to every dataset — so
  // there is nothing per-dataset to be missing.
  requireFullCoverage = false,
): Promise<{
  token: string;
  embeddedId: string;
}> {
  const startedAt = Date.now();
  const session = await openSession();
  const embeddedId = await resolveEmbeddedId(slug, session);

  // Turn each rule's table name into the numeric dataset id Superset expects.
  // A rule with no table name is left unscoped on purpose and applies to every
  // dataset — see RlsRule.datasetTable.
  const scopedRls: RlsRule[] = [];
  for (const rule of rls) {
    if (!rule.datasetTable) {
      scopedRls.push({ clause: rule.clause });
      continue;
    }
    scopedRls.push({
      clause: rule.clause,
      dataset: await resolveDatasetId(rule.datasetTable, session),
    });
  }

  // Refuse to mint a pass that would leave part of the dashboard unfiltered.
  //
  // This is not belt-and-braces; it is the check for the one failure mode this
  // whole scoping mechanism has. A rule names a dataset, so a dataset nobody
  // named is not restricted — it is returned whole. That fails *open*, and
  // silently: the tile renders a plausible number, just the tenant's instead
  // of the viewer's. Observed exactly once, when a dashboard gained two
  // datasets and the running API had not been rebuilt with the filters for
  // them — both personal counters showed the tenant's total.
  //
  // Checked against the dashboard's live dataset list rather than a constant,
  // so adding a tile on a new dataset breaks loudly here instead of quietly
  // widening what a viewer can see.
  if (requireFullCoverage) {
    const covered = new Set(
      rls.filter((r) => r.datasetTable).map((r) => r.datasetTable),
    );
    const uncovered = (await listDashboardDatasets(slug, session)).filter(
      (table) => !covered.has(table),
    );
    if (uncovered.length > 0) {
      throw new SupersetUnavailableError(
        `Dashboard '${slug}' has dataset(s) with no row filter: ${uncovered.join(", ")}`,
      );
    }
  }

  const token = await mintGuestToken(embeddedId, tenantId, scopedRls, session);

  logger.debug(
    { slug, embeddedId, durationMs: Date.now() - startedAt },
    "reporting: minted Superset guest token",
  );
  return { token, embeddedId };
}
