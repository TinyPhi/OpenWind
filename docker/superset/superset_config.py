"""Superset configuration — OpenWind reporting (track 3G, Stage 1).

Loaded via SUPERSET_CONFIG_PATH. Everything security-relevant here is driven by
environment variables that @platform/config validates before the API will start
in production — see packages/config/src/env.ts.

Spec: docs/specs/superset-embedded-dashboarding.md
"""

import logging
import json
import os
import re
from datetime import timedelta

logger = logging.getLogger(__name__)

# ─── Secrets ────────────────────────────────────────────────────────────────
# No fallback values. A missing key here should stop the container, not quietly
# start Superset on a guessable signing key — a known SECRET_KEY forges an admin
# session, which is the mechanism behind CVE-2023-27524 (that CVE itself does
# not affect 4.0.2; shipping a default key recreates the same attack anyway).
SECRET_KEY = os.environ["SUPERSET_SECRET_KEY"]
GUEST_TOKEN_JWT_SECRET = os.environ["SUPERSET_GUEST_TOKEN_SECRET"]

SQLALCHEMY_DATABASE_URI = os.environ["DATABASE_URL"]

# ─── Embedding ──────────────────────────────────────────────────────────────
# Header text and browser tab title. Left unset, Superset defaults to
# "Superset" everywhere - this is the standalone-login surface (Stage 2),
# so it should read as the OpenWind product, not the tool underneath it.
APP_NAME = "OpenWind"


def _logo_right_text() -> str:
    # LOGO_RIGHT_TEXT is called with no arguments (superset/views/base.py's
    # menu_data: `brand_text()`), so the current user comes from
    # flask_login's request-scoped current_user, not a passed parameter.
    # Real, per-request data - the same first/last name Zitadel supplied at
    # login (auth_user_oauth below), not a placeholder.
    from flask_login import current_user

    if current_user and current_user.is_authenticated:
        return f"User: {current_user.username}"
    return ""


LOGO_RIGHT_TEXT = _logo_right_text

FEATURE_FLAGS = {
    "EMBEDDED_SUPERSET": True,
    # docs/specs/superset-standalone-with-zitadel.md T18/T19 — without this,
    # Dashboard.roles (what bootstrap.py's dashboard-grant loop actually
    # sets) is silently ignored for any normally-logged-in FAB role; it only
    # matters for the embedded guest-token path, which uses a completely
    # different mechanism (the guest role + embedded dashboard uuid lookup).
    # Confirmed live: a "user"-role standalone login still saw "My
    # Organisation Overview" despite lacking the ReportingStaff role that
    # dashboard is gated on, until this flag was turned on — the fix wasn't
    # inert by design, it was inert because Superset itself defaults this
    # flag to False (superset/config.py:708) and nothing here ever set it.
    "DASHBOARD_RBAC": True,
}

# The role guests are given when they present a pass.
#
# NOT "Public". Public is Flask-AppBuilder's *anonymous* role (AUTH_ROLE_PUBLIC
# defaults to "Public"), so granting embedded-viewer permissions to it hands
# them to every unauthenticated visitor, not just pass holders. Verified on a
# running instance before this was written: with permissions on Public, an
# unauthenticated GET /api/v1/dashboard/ answered 200 rather than 401.
#
# bootstrap.py creates this role and grants it exactly the permissions an
# embedded dashboard needs (EMBEDDED_VIEWER_PERMISSIONS). Spec R6 / §V.
GUEST_ROLE_NAME = "EmbeddedViewer"

# How long a pass is valid. Superset's own default is 300s
# (superset/config.py). The spec's revocation guarantee (R9) is stated as 60s —
# a pass cannot be revoked mid-life, so this value *is* the window during which
# a disabled user or tenant keeps working. Left unset, the real window would be
# five times what the spec promises.
GUEST_TOKEN_JWT_EXP_SECONDS = 60

# Audience is deliberately not set: Superset falls back to get_url_host(), which
# binds each pass to the instance that issued it. That default is what prevents
# a pass minted against staging from being replayed against production, so
# setting it by hand here would only risk weakening it.

# ─── Tenant isolation ───────────────────────────────────────────────────────
# This is the whole tenancy boundary for reporting. Read it before changing it.
#
# The platform's own isolation is Postgres row-level security, keyed on a
# per-connection setting: every policy is
# `tenant_id = current_setting('app.tenant_id', true)::uuid`, and the API sets
# that setting per request. Superset does not do that, which is what made
# reporting isolation an open question — a shared reporting connection with no
# setting would see either nothing or everything, depending on the role.
#
# DB_CONNECTION_MUTATOR closes it. Superset calls this hook while building the
# connection for a query, and hands it the identity of whoever asked. We stamp
# that identity onto the connection as `app.tenant_id`, so the platform's
# EXISTING RLS policies apply to Superset exactly as they apply to the API. No
# new views, no second isolation mechanism to keep in sync with the first.
#
# Two properties make this safe, both verified against this image's source
# rather than assumed:
#
#  1. No connection is reused across tenants. `get_sqla_engine_with_context()`
#     takes `nullpool: bool = True` by default, so NullPool is used: a fresh
#     physical connection per query, closed after. A stamped connection cannot
#     be handed to a different tenant's request later.
#  2. The identity is available without enabling impersonation.
#     `get_effective_user()` consults `get_username()` — i.e. `g.user.username`,
#     which for an embedded request is the `user.username` field of the guest
#     token our mint endpoint issues — before it ever looks at
#     `impersonate_user`.
#
# Fails closed. If the identity is absent or not a tenant id (an admin browsing
# Superset directly, say), the setting is left unset. `current_setting(...,
# true)` then returns NULL, every RLS policy evaluates false, and the query
# returns no rows. The failure mode is an empty dashboard, never another
# tenant's data.
# Subject ids reach a connection string, so only characters that cannot
# terminate an option or start another are permitted. Zitadel issues numeric
# subjects; the wider set matches what the API already accepts as a principal.
_PRINCIPAL_ID_RE = re.compile(r"^[A-Za-z0-9_.:@-]{1,255}$")

_TENANT_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


def _tenant_from_user_roles():
    """The tenant bound to the logged-in user, from their `tenant:<uuid>` role.

    Returns None when nobody is logged in, or when the account carries no such
    role — a user whose claims resolved to no tenant. Both must leave the
    connection unstamped so row-level security yields nothing.

    Exactly one is expected. More than one means a binding was not cleaned up,
    and guessing between them would be choosing whose data to show, so it
    refuses instead.
    """
    try:
        from flask import has_request_context
        from flask_login import current_user

        if not has_request_context() or not getattr(current_user, "is_authenticated", False):
            return None
        prefix = "tenant:"
        found = [
            r.name[len(prefix):]
            for r in getattr(current_user, "roles", []) or []
            if r.name.startswith(prefix)
        ]
    except Exception:  # noqa: BLE001
        return None

    if len(found) != 1:
        if found:
            logger.error(
                "user carries %d tenant roles; refusing to choose between them",
                len(found),
            )
        return None
    return found[0]


def _own_rows_subject():
    """The subject id a logged-in session is narrowed to, if it is narrowed.

    Returns None for staff and for the embedded path, both of which see the
    whole tenant. The binding is a role added at login (`owuser:<subject>`), so
    its *absence* means tenant-wide — a lookup that fails therefore widens
    nothing, it simply leaves the session as broad as the tenant filter allows.
    """
    try:
        from flask import has_request_context
        from flask_login import current_user

        if not has_request_context() or not getattr(current_user, "is_authenticated", False):
            return None
        prefix = "owuser:"
        found = [
            r.name[len(prefix):]
            for r in getattr(current_user, "roles", []) or []
            if r.name.startswith(prefix)
        ]
    except Exception:  # noqa: BLE001
        return None

    if len(found) != 1:
        if found:
            logger.error(
                "session carries %d own-rows bindings; refusing to choose", len(found)
            )
            # Two bindings is a broken account, and picking one would be
            # choosing whose rows to show. Returning a value that matches
            # nothing is the safe reading of an ambiguous session.
            return "__ambiguous__"
        return None
    return found[0]


def _tenant_from_guest_token(security_manager):
    """The tenant of the embedded viewer, read from their signed guest token.

    Returns None whenever there is no request, no token, or a token that does
    not verify — every one of which must leave the connection without a tenant
    rather than guess at one.
    """
    try:
        from flask import has_request_context, request

        if not has_request_context():
            return None
        guest_user = security_manager.get_guest_user_from_request(request)
    except Exception:  # noqa: BLE001
        # A malformed or expired token raises here. That is a caller with no
        # provable tenant, which is exactly the case that must see no rows.
        return None

    if guest_user is None:
        return None
    return getattr(guest_user, "username", None)


def DB_CONNECTION_MUTATOR(  # noqa: N802  (name fixed by Superset's config contract)
    sqlalchemy_url,
    params,
    username,
    security_manager,
    source,
):
    """Stamp the caller's tenant onto the connection, so platform RLS applies."""
    tenant_id = str(username) if username else ""

    if not _TENANT_ID_RE.match(tenant_id):
        # Not every query arrives carrying the viewer's identity. Superset runs
        # a dashboard-level query — a native filter loading its dropdown values
        # — as the *dashboard owner* rather than the guest, so `username` here
        # is the service account and carries no tenant. Without this branch
        # those queries got no tenant stamped and RLS returned nothing, which
        # showed up as filter dropdowns that were simply empty.
        #
        # The guest's tenant is still recoverable, from the guest token on the
        # request. That is the same source the per-chart path already trusts,
        # and it is verified the same way: get_guest_user_from_request() checks
        # the token's signature against GUEST_TOKEN_JWT_SECRET before returning
        # anything, so a forged or edited token yields nothing rather than a
        # tenant of the caller's choosing.
        tenant_id = _tenant_from_guest_token(security_manager) or ""

    if not _TENANT_ID_RE.match(tenant_id):
        # Stage 2: a logged-in analyst writing their own SQL. Their tenant is
        # bound to the account at login as a `tenant:<uuid>` role, so it is read
        # back from the session rather than from the connection's username.
        #
        # This is what makes "whatever query they write" safe (spec R2): the
        # scoping is stamped on the connection before their SQL runs, so it
        # applies to a hand-written join the same way it applies to a chart.
        tenant_id = _tenant_from_user_roles() or ""

    if not _TENANT_ID_RE.match(tenant_id):
        # Deliberately no fallback value. Leaving the setting unset is what
        # makes an unidentified caller see nothing instead of everything.
        if username:
            # Expected for service-account metadata calls (listing a
            # dashboard's datasets, provisioning), which read Superset's own
            # catalogue rather than tenant rows. Logged at info, not warning,
            # so a genuinely unidentified data query stands out instead of
            # being buried in routine noise.
            logger.info(
                "reporting connection for '%s' carries no tenant — app.tenant_id "
                "left unset, so RLS returns no rows",
                username,
            )
        return sqlalchemy_url, params

    # The regex above is the whole defence against injecting extra options into
    # this string — it permits only hex digits and hyphens, so there is no way
    # to terminate the option and append another.
    connect_args = params.setdefault("connect_args", {})
    existing_options = connect_args.get("options", "")
    tenant_option = f"-c app.tenant_id={tenant_id}"

    # A non-staff session is narrowed to its own tickets, by the database rather
    # than by the query. Stamped here so it applies to a chart and to SQL the
    # user wrote themselves in exactly the same way — the embedded dashboards
    # achieve this with a clause in the guest token, which SQL Lab has no
    # equivalent of (migration 0116).
    subject = _own_rows_subject()
    if subject and _PRINCIPAL_ID_RE.match(subject):
        tenant_option += (
            f" -c app.reporting_scope=own -c app.reporting_user_id={subject}"
        )
    elif subject:
        # An unusable binding must not fall back to tenant-wide: scope to a
        # subject nothing matches, so the session sees nothing at all.
        tenant_option += " -c app.reporting_scope=own -c app.reporting_user_id=-"
    connect_args["options"] = (
        f"{existing_options} {tenant_option}".strip() if existing_options else tenant_option
    )
    return sqlalchemy_url, params


# ─── Caching ────────────────────────────────────────────────────────────────
# Query results live here, outside the tables the SQL grant governs — so tenant
# data exists in Redis too. The TTL is therefore a retention decision, not just
# a performance one: it bounds how long a purged tenant's rows can survive a
# GDPR deletion (spec T25c).
_REDIS_URL = os.environ["REDIS_URL"]

CACHE_CONFIG = {
    "CACHE_TYPE": "RedisCache",
    "CACHE_DEFAULT_TIMEOUT": 300,
    "CACHE_KEY_PREFIX": "superset_",
    "CACHE_REDIS_URL": _REDIS_URL,
}

DATA_CACHE_CONFIG = {
    "CACHE_TYPE": "RedisCache",
    "CACHE_DEFAULT_TIMEOUT": 300,
    "CACHE_KEY_PREFIX": "superset_data_",
    "CACHE_REDIS_URL": _REDIS_URL,
}

# ─── Embedding origins ──────────────────────────────────────────────────────
# The admin-ui origin that may frame a dashboard. Anything wider would let a
# hostile page frame the embed and relay a live pass within its lifetime.
_ADMIN_UI_ORIGIN = os.environ.get("SUPERSET_EMBED_ORIGIN", "http://localhost:3001")

ENABLE_CORS = True
CORS_OPTIONS = {
    "supports_credentials": True,
    "allow_headers": ["*"],
    "resources": ["*"],
    "origins": [_ADMIN_UI_ORIGIN],
}

TALISMAN_ENABLED = False

# ── Date range ───────────────────────────────────────────────────────────────
#
# No custom quick-pick buttons: Superset's Common-tab presets (Last day/week/
# month/quarter/year) are hardcoded in the compiled frontend bundle with no
# config override — checked directly against the shipped assets, not assumed.
# `COMMON_TIME_RANGES` was tried here and removed: it is not a real Superset
# setting, and it was a no-op.
#
# What does work, verified live against the reporting connection: typing a
# relative phrase into the filter's Custom/Advanced tab. "Last 7 days",
# "Last 14 days", "previous calendar month" and "Year to date" (calendar year;
# there is no native financial-year variant) all parse and filter correctly.
# That is the supported path today — a decision, not a placeholder for a future
# fix, per 2026-09-17.
DEFAULT_TIME_FILTER = "No filter"

# ── Chart colour scheme ──────────────────────────────────────────────────────
#
# EXTRA_CATEGORICAL_COLOR_SCHEMES, confirmed as a real Superset key (config.py),
# registers a named scheme charts can select. Set as the platform default below
# so every chart in tiles.yaml picks it up without naming it per tile.
#
# Ordered so the first colours carry the meanings people already read from the
# app: teal for the primary/normal case, then a red/amber/green triad matching
# the table's own conditional formatting (migration reasoning: one colour
# language across tables and charts, not two).
EXTRA_CATEGORICAL_COLOR_SCHEMES = [
    {
        "id": "openwind",
        "description": "OpenWind brand palette",
        "label": "OpenWind",
        "colors": [
            "#22BFB2",  # accent teal — primary series
            "#EA3E5B",  # error red — breach / urgent
            "#F38516",  # warning amber — due soon
            "#20B670",  # success green — on track / closed
            "#4A5BD4",  # secondary blue
            "#8B5CF6",  # violet
            "#F2B705",  # gold
            "#6B7280",  # neutral grey — "not set" / unknown categories
        ],
    }
]

# There is no global default-scheme config: verified against config.py, a
# chart's colour scheme is its own `color_scheme` param, not a platform
# setting. Every chart in tiles.yaml therefore sets `color_scheme: openwind`
# itself rather than relying on one that does not exist here.

# ── Appearance ───────────────────────────────────────────────────────────────
#
# The dashboard renders inside an iframe on another origin, so the host page
# cannot restyle it — cross-origin CSS is not reachable, by design. Anything
# that should match the host has to be set here, on Superset's own side.
#
# Both a light and a dark theme are defined, and defining both is what makes
# the embed switchable: with only one, Superset pins every viewer to it and the
# SDK's setThemeMode() has nothing to switch between. The host drives the
# choice (apps/admin-ui/src/pages/reporting.tsx) so the panel follows the
# app's own toggle instead of keeping its own.
#
# Ant Design token format (Superset 6). Values are the host's own tokens from
# apps/admin-ui/src/index.css, converted from HSL:
#   --accent-primary hsl(175,70%,44%)  -> #22BFB2
#   --bg-primary     hsl(222,16%,14%)  -> #1E2129   (dark)
#   --text-primary   hsl(0,0%,94%)     -> #F0F0F0   (dark)
#   --bg-primary     hsl(0,0%,100%)    -> #FFFFFF   (light)
#   --text-primary   hsl(225,25%,10%)  -> #131620   (light)
#   --radius-md      12px
_OPENWIND_TOKENS = {
    "colorPrimary": "#22BFB2",
    "colorSuccess": "#20B670",
    "colorWarning": "#F38516",
    "colorError": "#EA3E5B",
    "borderRadius": 8,
    # One step up from Ant's 14px default. Chart text is read at a glance and
    # from further away than form text, and the axis is the smallest thing on
    # the tile that still has to be legible.
    "fontSize": 15,
    "fontFamily": (
        "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, "
        "sans-serif"
    ),
}

# Chart axis labels read from `colorText` and `colorTextSecondary` (confirmed
# against the running build's own chart code, not inferred). Ant Design derives
# those from colorTextBase at reduced opacity — secondary lands near 65% — which
# is fine for incidental UI text and too faint for an axis, where the label is
# the only thing naming what a bar means.
#
# So both are pinned to this app's real text colours instead of being left to
# derive, with secondary raised to full-strength primary: an axis label is
# primary information here, not a subtitle. Tertiary keeps the app's secondary
# tone for genuinely incidental text, so the whole thing does not flatten into
# one weight.
THEME_DEFAULT = {
    "algorithm": "default",
    "token": {
        **_OPENWIND_TOKENS,
        "colorBgBase": "#FFFFFF",
        "colorTextBase": "#131620",
        "colorText": "#131620",
        "colorTextSecondary": "#131620",
        "colorTextTertiary": "#555B6D",
        "colorTextDescription": "#555B6D",
        "colorBorder": "#A7ADBE",
        "colorSplit": "#D9DDE6",
    },
}

THEME_DARK = {
    "algorithm": "dark",
    "token": {
        **_OPENWIND_TOKENS,
        "colorBgBase": "#1E2129",
        "colorTextBase": "#F0F0F0",
        "colorText": "#F0F0F0",
        "colorTextSecondary": "#F0F0F0",
        "colorTextTertiary": "#B6BAC3",
        "colorTextDescription": "#B6BAC3",
        "colorBorder": "#5A6172",
        "colorSplit": "#3A404E",
    },
}

# Off, not left at Superset's own default (which is True). With it on, a live
# theme switch (what the embedded SDK's setThemeMode triggers) is served via
# GET /api/v1/theme/system rather than read straight out of THEME_DEFAULT/
# THEME_DARK above — and the embedded guest role has no permission to call
# that endpoint (confirmed: bootstrap logs "permissions not found in this
# Superset build: ['can_read on ThemeRestApi']", so it cannot be granted
# either). The result was a toggle that silently did nothing for every
# embedded viewer. This deployment has no Superset-side theme-editing UI to
# offer anyway — the host app is the only thing that ever picks light/dark
# (reporting.tsx) — so the admin-UI theme picker this flag turns on has
# nothing to do here. With it off, theme resolution reads THEME_DEFAULT/
# THEME_DARK directly, no DB lookup, no permission required.
ENABLE_UI_THEME_ADMINISTRATION = False


# ── Stage 2: Zitadel login, for users who write their own queries ────────────
#
# Stage 1 needs none of this — nobody reaches Superset, and the only identity is
# a guest token our API mints per request. Stage 2 puts Superset on its own URL
# with a real login, which changes the threat model completely: the user picks
# the query, so every table the connection can read is reachable.
#
# Off unless SUPERSET_OAUTH_CLIENT_ID is set. An unconfigured deployment keeps
# database login and only the embedded path, rather than half-opening a door.
_OAUTH_CLIENT_ID = os.environ.get("SUPERSET_OAUTH_CLIENT_ID", "").strip()

if _OAUTH_CLIENT_ID:
    from flask_appbuilder.security.manager import AUTH_OAUTH

    AUTH_TYPE = AUTH_OAUTH

    # First login creates the Superset user. The role it lands in grants
    # nothing: authorization comes from the Zitadel claim below, and a user
    # whose claims carry no reporting role must end up able to log in and see
    # nothing, rather than be indistinguishable from a user who does.
    AUTH_USER_REGISTRATION = True
    AUTH_USER_REGISTRATION_ROLE = "ReportingNoAccess"

    # Re-evaluated every login, not just at registration. Without this a role
    # removed in Zitadel keeps working in Superset until someone edits the
    # account by hand — access outliving the grant that justified it.
    AUTH_ROLES_SYNC_AT_LOGIN = True

    # Zitadel role -> Superset role. Only the analyst role gets query access;
    # everything else falls through to the no-access role above.
    #
    # Every role that should reach reporting at all maps to ReportingAnalyst
    # -- that is what SQL Lab and row-scoped charts run on, and row-level
    # visibility is decided in the database (migration 0116), not here. A
    # role that granted "sees everything" would put the tenant/own boundary
    # back into configuration, where a hand-written query can step around it.
    #
    # ReportingStaff is additional and separate (docs/specs/
    # superset-standalone-with-zitadel.md T18): a pure dashboard-visibility
    # marker, not a data-access grant. Only staff hold it, and only "My
    # Organisation Overview" is gated on it (bootstrap.py) — matching the
    # embedded path, where the tenant-wide dashboard is 403'd server-side
    # for non-staff (guest-token.ts), rather than relying solely on
    # migration 0116's row-scoping to make an org-wide dashboard being
    # openable at all "safe enough" for a non-staff login.
    AUTH_ROLES_MAPPING = {
        "admin": ["ReportingAnalyst", "ReportingStaff"],
        "agent": ["ReportingAnalyst", "ReportingStaff"],
        "user": ["ReportingAnalyst"],
    }

    # Roles whose holders see the whole tenant. Anyone else is narrowed to the
    # tickets they raised or were assigned — the same rule the embedded
    # "My Performance" dashboard applies, moved somewhere SQL Lab cannot avoid.
    STAFF_ROLE_KEYS = {"admin", "agent", "superadmin"}
    OWN_ROWS_ROLE_PREFIX = "owuser:"

    _OAUTH_ISSUER = os.environ.get("SUPERSET_OAUTH_ISSUER", "http://localhost:8080")
    # The browser is redirected to the public issuer; the container fetches
    # tokens and keys over the Docker network. Using one URL for both breaks
    # whichever side cannot resolve it.
    _OAUTH_INTERNAL = os.environ.get(
        "SUPERSET_OAUTH_INTERNAL_ISSUER", _OAUTH_ISSUER
    )
    # The Host to present when talking to the internal address. Defaults to the
    # public issuer's host, because that is the name the identity provider
    # actually answers to.
    _OAUTH_HOST_HEADER = os.environ.get(
        "SUPERSET_OAUTH_HOST_HEADER",
        _OAUTH_ISSUER.split("://", 1)[-1].rstrip("/"),
    )

    OAUTH_PROVIDERS = [
        {
            "name": "zitadel",
            "icon": "fa-key",
            "token_key": "access_token",
            "remote_app": {
                "client_id": _OAUTH_CLIENT_ID,
                "client_secret": os.environ.get("SUPERSET_OAUTH_CLIENT_SECRET", ""),
                "api_base_url": f"{_OAUTH_INTERNAL}/",
                "access_token_url": f"{_OAUTH_INTERNAL}/oauth/v2/token",
                "authorize_url": f"{_OAUTH_ISSUER}/oauth/v2/authorize",
                "jwks_uri": f"{_OAUTH_INTERNAL}/oauth/v2/keys",
                "server_metadata_url": f"{_OAUTH_INTERNAL}/.well-known/openid-configuration",
                "client_kwargs": {
                    # The roles claim rides on the token; without the project
                    # scope Zitadel omits it and every user looks unprivileged.
                    # `urn:zitadel:iam:user:resourceowner` is what makes
                    # Zitadel include the org claim. Without it userinfo comes
                    # back with no resourceowner id, the org cannot be mapped to
                    # a tenant, and the session ends up bound to no tenant —
                    # which fails closed as zero rows everywhere, so it presents
                    # as "logged in, dashboards load, nothing in them".
                    "scope": (
                        "openid profile email "
                        "urn:zitadel:iam:user:resourceowner"
                    ),
                    # Zitadel resolves which instance a request is for from the
                    # Host header, and answers only to its own domains
                    # (`localhost` here). Superset reaches it over the Docker
                    # network as `zitadel`, a name Zitadel does not recognise —
                    # so the address and the Host have to differ: connect to the
                    # container, ask for the domain. Without this every login
                    # fails at the discovery fetch with a 404 that looks like a
                    # missing endpoint rather than a rejected hostname.
                    "headers": {"Host": _OAUTH_HOST_HEADER},
                },
            },
        }
    ]

    # Sessions are the revocation boundary here. Stage 1 bounds exposure to the
    # 60s life of a minted pass; a browser session has no such bound, so both
    # numbers are stated rather than left to defaults (spec §C "session", P5).
    PERMANENT_SESSION_LIFETIME = timedelta(
        minutes=int(os.environ.get("SUPERSET_SESSION_MAX_MINUTES", "480"))
    )
    SESSION_REFRESH_EACH_REQUEST = False

    # ── Tenant binding for query-writing users ───────────────────────────────
    #
    # The embedded path carries the tenant in the guest token's username, which
    # the connection mutator stamps onto the connection. A Stage 2 user has a
    # real Superset account instead, whose username is their login name — so
    # without this the mutator finds no tenant, leaves app.tenant_id unset, and
    # every query returns nothing. Fail-closed, but also unusable.
    #
    # The tenant is therefore bound to the account at login, as a role named
    # `tenant:<uuid>`. Using Superset's own role model rather than a side table
    # means the binding is visible in the security UI, moves with the account,
    # and is re-evaluated on every login like any other role.
    #
    # Derived from the Zitadel org claim each time, never selectable and never
    # defaulted: a login whose claims resolve to no tenant keeps no tenant role,
    # so it sees zero rows rather than someone else's.
    TENANT_ROLE_PREFIX = "tenant:"

    from superset.security import SupersetSecurityManager

    class OpenWindSecurityManager(SupersetSecurityManager):
        """Binds each OAuth login to exactly one tenant."""

        def oauth_user_info(self, provider, response=None):
            if provider != "zitadel":
                return {}
            me = self.appbuilder.sm.oauth_remotes[provider].get("oidc/v1/userinfo")
            data = me.json()
            # Zitadel namespaces both claims; neither has a short alias, so the
            # full URNs are the contract here.
            org_id = data.get("urn:zitadel:iam:user:resourceowner:id") or ""
            # Claim *names* only, never values: which claims arrived is the
            # thing that explains a session bound to no tenant, and it is not
            # recoverable after the fact. A missing org claim usually means the
            # resourceowner scope was not requested or not granted.
            if not org_id:
                logger.warning(
                    "userinfo for '%s' carried no org claim; claims present: %s",
                    data.get("preferred_username"),
                    sorted(data.keys()),
                )
            roles = list(
                (data.get("urn:zitadel:iam:org:project:roles") or {}).keys()
            )
            return {
                # The subject id, not the login name: entity_instances stores
                # `created_by`/`assigned_to` as the Zitadel subject, so that is
                # what any per-user comparison has to be made against.
                "subject_id": data.get("sub") or "",
                "username": data.get("preferred_username") or data.get("sub"),
                "email": data.get("email", ""),
                "first_name": data.get("given_name", ""),
                "last_name": data.get("family_name", ""),
                "role_keys": roles,
                "org_id": org_id,
            }

        def _tenant_for_org(self, org_id):
            """Ask the database which tenant an org maps to.

            Through tenant_for_org(), not a SELECT on `tenants`: the reporting
            role cannot read that table by design (migration 0113), and this
            asks the one question Stage 2 needs without handing back the rest.
            """
            if not org_id:
                return None
            from superset import db as _db
            from superset.models.core import Database
            from sqlalchemy import text as _text

            database = (
                _db.session.query(Database)
                .filter_by(database_name=os.environ.get(
                    "SUPERSET_REPORTING_DB_NAME", "OpenWind Platform"))
                .one_or_none()
            )
            if database is None:
                return None
            try:
                with database.get_sqla_engine() as engine:
                    with engine.connect() as conn:
                        row = conn.execute(
                            _text("SELECT public.tenant_for_org(:org)"),
                            {"org": org_id},
                        ).fetchone()
                return str(row[0]) if row and row[0] else None
            except Exception:  # noqa: BLE001
                logger.exception("tenant lookup failed for org %s", org_id)
                return None

        def auth_user_oauth(self, userinfo):
            user = super().auth_user_oauth(userinfo)
            if user is None:
                return None

            tenant_id = self._tenant_for_org(userinfo.get("org_id"))

            # Rebuilt from scratch each login rather than added to: a user moved
            # between orgs must lose the old binding, and leaving a stale
            # tenant role attached would be exactly the access-outlives-the-grant
            # problem AUTH_ROLES_SYNC_AT_LOGIN exists to prevent.
            user.roles = [
                r for r in user.roles
                if not r.name.startswith(TENANT_ROLE_PREFIX)
            ]

            # Rebuilt each login for the same reason as the tenant role: a
            # promotion or demotion in Zitadel has to take effect on the next
            # login rather than persisting until someone edits the account.
            user.roles = [
                r for r in user.roles
                if not r.name.startswith(OWN_ROWS_ROLE_PREFIX)
            ]
            # The registration role is a starting point, not a permanent mark.
            # AUTH_USER_REGISTRATION_ROLE puts every first-time login into
            # ReportingNoAccess, and FAB's role sync adds the mapped roles
            # alongside it rather than replacing it — so both accounts on this
            # instance ended up holding ReportingNoAccess *and* ReportingAnalyst
            # at the same time. It grants nothing, so nobody noticed, but it
            # makes the one signal that is supposed to mean "this login resolved
            # to no access" true of every login, including the privileged ones.
            #
            # Dropped only when a real role is present. A login whose claims map
            # to nothing keeps it, which is the case it exists for.
            mapped = {
                name
                for names in AUTH_ROLES_MAPPING.values()
                for name in names
            }
            if any(r.name in mapped for r in user.roles):
                user.roles = [
                    r for r in user.roles
                    if r.name != AUTH_USER_REGISTRATION_ROLE
                ]

            claimed = set(userinfo.get("role_keys") or [])
            subject = userinfo.get("subject_id") or ""
            if not (claimed & STAFF_ROLE_KEYS) and subject:
                # Non-staff: pin the subject the database will scope rows to.
                # Absence of this role is what means "whole tenant", so it is
                # added rather than a flag being cleared — a failure to write it
                # leaves the account narrower, never wider.
                own_role_name = f"{OWN_ROWS_ROLE_PREFIX}{subject}"
                own_role = self.find_role(own_role_name) or self.add_role(own_role_name)
                user.roles.append(own_role)

            if tenant_id and _TENANT_ID_RE.match(tenant_id):
                role_name = f"{TENANT_ROLE_PREFIX}{tenant_id}"
                role = self.find_role(role_name) or self.add_role(role_name)
                user.roles.append(role)
            else:
                logger.warning(
                    "login for '%s' resolved to no tenant — session will see no rows",
                    userinfo.get("username"),
                )

            # Superset's own session, not the security manager's: FAB moved
            # `get_session` between versions and it is absent here, which failed
            # the login at the very last step with a 500 after the token
            # exchange had already succeeded.
            from superset import db as _db

            _db.session.commit()
            return user

    CUSTOM_SECURITY_MANAGER = OpenWindSecurityManager

    # ── Query and export audit ───────────────────────────────────────────────
    #
    # Superset keeps its own action log, and the spec is explicit that it is not
    # an audit trail: a Superset admin can edit or purge it, and it sits outside
    # the platform's retention and erasure guarantees (spec §C "audit trail",
    # R7). So query and export events are also appended to the platform's own
    # append-only store.
    #
    # Written through record_reporting_audit() (migration 0115), not a direct
    # INSERT: the reporting role can read six tables and write none, and that
    # stays true. The function fixes the action to the reporting vocabulary, so
    # this path cannot forge a record about a ticket.
    #
    # Best-effort by construction. Superset calls the event logger inside the
    # request, so raising here would turn an audit hiccup into a failed query
    # for the user. A failure is logged loudly and the query proceeds — the
    # alternative, refusing queries when the audit store is unreachable, is a
    # decision for whoever owns the compliance requirement, not a default.
    from superset.utils.log import DBEventLogger

    _AUDITED_ACTIONS = {
        "sql_json": "reporting.query_executed",
        "sqllab_viz": "reporting.query_executed",
        "csv": "reporting.exported",
        "export_csv": "reporting.exported",
        "csv_endpoint": "reporting.exported",
    }

    class PlatformAuditEventLogger(DBEventLogger):
        """Superset's own logger, plus an append to the platform audit store."""

        def log(self, user_id, action, *args, **kwargs):
            # Superset's record is kept as well as ours: it carries detail this
            # does not, and losing it would make Superset harder to debug.
            super().log(user_id, action, *args, **kwargs)

            mapped = _AUDITED_ACTIONS.get(action)
            if mapped is None:
                return
            try:
                self._append_platform_audit(mapped, kwargs)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "failed to record '%s' in the platform audit store", mapped
                )

        def _append_platform_audit(self, action, kwargs):
            from flask_login import current_user
            from sqlalchemy import text as _text
            from superset import db as _db
            from superset.models.core import Database

            tenant_id = _tenant_from_user_roles()
            if not tenant_id:
                # No tenant means the session could not see any data anyway;
                # there is no tenant to attribute the record to.
                return

            actor = getattr(current_user, "username", None) or "unknown"
            payload = {
                "action": action,
                # The query text is the point of the record — "who exported
                # what", not just "who exported". Truncated so one pathological
                # query cannot bloat the audit table.
                "sql": str(kwargs.get("sql") or "")[:4000],
                "database": kwargs.get("database_name"),
                "schema": kwargs.get("schema"),
                "rows": kwargs.get("rows"),
                "duration_ms": kwargs.get("duration_ms"),
            }

            database = (
                _db.session.query(Database)
                .filter_by(database_name=os.environ.get(
                    "SUPERSET_REPORTING_DB_NAME", "OpenWind Platform"))
                .one_or_none()
            )
            if database is None:
                return
            with database.get_sqla_engine() as engine:
                with engine.begin() as conn:
                    conn.execute(
                        _text(
                            "SELECT public.record_reporting_audit"
                            "(:tenant, :actor, :action, CAST(:meta AS jsonb))"
                        ),
                        {
                            "tenant": tenant_id,
                            "actor": actor,
                            "action": action,
                            "meta": json.dumps(payload),
                        },
                    )

    EVENT_LOGGER = PlatformAuditEventLogger()
