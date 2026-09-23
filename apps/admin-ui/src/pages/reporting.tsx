import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  embedDashboard,
  type EmbeddedDashboard,
} from "@superset-ui/embedded-sdk";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { userManager } from "../authProvider.js";
import { TOKENS } from "@platform/ui";
import { getSavedTheme } from "../lib/theme.js";
import { ReportingBYOQSidebar } from "./reporting-byoq.js";

/**
 * Reporting — embedded Superset dashboards (track 3G, Stage 1)
 * with native BYOQ (Build Your Own Query) sidebar control panel.
 *
 * Everything outside the iframe is ours; everything inside it is Superset's.
 * We never hold a Superset credential here: the page asks our API for a
 * short-lived pass, and the SDK exchanges it. The 4 tenant-tab KPI tiles are
 * native Superset charts inside that iframe (D6) — this page no longer
 * renders any of the dashboard's own tiles itself.
 *
 * Spec: docs/specs/superset-embedded-dashboarding.md
 */

type DashboardKey = "tenant" | "user";

const TABS: { key: DashboardKey; label: string }[] = [
  { key: "tenant", label: "My Organisation Overview" },
  { key: "user", label: "My Performance" },
];

/**
 * How much to shrink the embedded dashboard.
 *
 * Superset's own chrome is built for a full-page app and renders noticeably
 * larger than this app's type and spacing, so at 1:1 the panel reads as a
 * different product bolted on. Scaling the frame is the only lever available:
 * the iframe is cross-origin, so its stylesheet cannot be touched from here.
 *
 * The iframe is sized up by the inverse of this before being scaled down, so
 * the dashboard still fills the panel and stays fully interactive — this is a
 * visual scale, not a crop.
 */
const EMBED_SCALE = 0.85;

/**
 * Floor for the embed panel, before the dashboard reports its own height.
 *
 * Measured from the viewport rather than fixed, so the panel fills the screen
 * on any display instead of leaving a band of empty page under a short
 * dashboard. 70px header and 64px of .main-content padding are this app's own
 * chrome (index.css); the rest of the page is the panel.
 *
 * It is only a floor — the measured height replaces it as soon as the
 * dashboard reports one, and that is normally taller than the viewport.
 */
const PAGE_CHROME_PX = 70 + 64;
function viewportEmbedHeight(): number {
  return Math.max(700, window.innerHeight - PAGE_CHROME_PX);
}

/**
 * How long to keep re-measuring the dashboard after it mounts.
 *
 * Its height is not final when the embed resolves — charts are still fetching,
 * and each one that lands changes it. A single measurement therefore catches
 * the skeleton, not the dashboard, so this re-asks a few times and keeps the
 * largest answer.
 */
const HEIGHT_POLL_MS = 1500;
const HEIGHT_POLL_COUNT = 8;

/**
 * Translate this app's theme into the one the embedded dashboard understands.
 *
 * Superset names its light theme "default", not "light" — verified against the
 * running build's own enum rather than guessed, because an unrecognised mode is
 * ignored silently and would look like the toggle simply not working.
 *
 * Synchronously checks both the DOM's data-theme attribute and the stored
 * theme preference from lib/theme.js to guarantee the right mode is returned
 * even before the DOM attribute has settled.
 */
function supersetThemeMode(): "default" | "dark" {
  const active =
    document.documentElement.getAttribute("data-theme") ?? getSavedTheme();
  return active === "dark" ? "dark" : "default";
}

/**
 * The installed SDK's own type declares getScrollSize/setThemeMode as always
 * present, but an older Superset build's embed response can omit them (see
 * the "still renders when the embed has no theme support" test) — the type
 * is a contract for the SDK version we build against, not a guarantee about
 * what a given deployment's Superset actually returns. Narrowed here so the
 * optional-chained calls below are honest to the type checker instead of
 * tripping "unnecessary optional chain".
 */
type EmbeddedDashboardCompat = Omit<
  EmbeddedDashboard,
  "getScrollSize" | "setThemeMode"
> &
  Partial<Pick<EmbeddedDashboard, "getScrollSize" | "setThemeMode">>;

type GuestTokenResponse = {
  data: {
    token: string;
    dashboardId: string;
    supersetDomain: string;
  };
};

export const ReportingPage: React.FC = () => {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const [activeTab, setActiveTab] = useState<DashboardKey>("tenant");
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  // Retrying the same tab has to change something the effect depends on —
  // re-setting activeTab to its current value would not re-run it.
  const [retryCount, setRetryCount] = useState(0);
  // Height of the embedded dashboard, measured from the dashboard itself.
  // Starts at a viewport-ish floor so the panel is never a thin strip while
  // the real size is still being worked out.
  const [embedHeight, setEmbedHeight] = useState(viewportEmbedHeight);
  const [isByoqOpen, setIsByoqOpen] = useState(false);
  const [showInfoTooltip, setShowInfoTooltip] = useState(false);
  const [supersetSiteUrl, setSupersetSiteUrl] = useState(
    "http://localhost:8088",
  );

  // Role gating resolves before anything renders or fetches. Without the
  // `rolesReady` gate a customer navigating straight to /reporting would see
  // the staff tab set for a frame before it narrows — a flash of a surface
  // they are not entitled to. Same pattern as analytics.tsx.
  const [rolesReady, setRolesReady] = useState(false);
  // Staff (admin/agent) get both tabs. Everyone else — "user"/"customer" — is
  // a customer: they get only their own "My Tickets" dashboard, never the
  // tenant-wide one. The API enforces the same split independently
  // (guest-token.ts), so a stale or forged client state here cannot widen
  // access, only mis-render.
  const [isStaff, setIsStaff] = useState(false);

  useEffect(() => {
    void userManager.getUser().then((u) => {
      // oidc-client-ts types User.profile as a generic claims bag — the
      // Zitadel-specific roles claim is not part of that type.
      const profile = u?.profile as Record<string, unknown> | undefined;
      const rolesMap = (profile?.["urn:zitadel:iam:org:project:roles"] ??
        {}) as Record<string, unknown>;
      const roles = Object.keys(rolesMap);
      const staff = roles.includes("admin") || roles.includes("agent");
      setIsStaff(staff);
      setRolesReady(true);
      // A customer landing here mid-way through the tenant tab (e.g. a
      // bookmarked/typed URL from before a role change) gets bounced to their
      // own tab rather than shown nothing.
      if (!staff) setActiveTab("user");
    });
  }, []);

  const tabs = isStaff
    ? TABS
    : TABS.filter((t) => t.key === "user").map((t) => ({
        ...t,
        label: "My Performance",
      }));

  /**
   * Hand the SDK a fresh pass whenever it asks for one.
   *
   * The SDK calls this on mount and again before the current pass lapses, so
   * this is also the revocation path: a caller whose access was withdrawn is
   * refused here on the refresh, not just on first load.
   */
  const fetchGuestToken = useCallback(async (dashboard: DashboardKey) => {
    const response = (await fetchWithAuth(
      `${API_URL}/superset/guest-token?dashboard=${dashboard}`,
    )) as GuestTokenResponse;
    return response.data;
  }, []);

  useEffect(() => {
    if (!rolesReady) return;

    let cancelled = false as boolean;
    let teardown: (() => void) | undefined;

    setLoading(true);
    setFailed(false);
    setEmbedHeight(viewportEmbedHeight());

    void (async () => {
      try {
        const { dashboardId, supersetDomain } =
          await fetchGuestToken(activeTab);
        if (supersetDomain) setSupersetSiteUrl(supersetDomain);
        if (cancelled || !mountRef.current) return;

        const initialTheme = supersetThemeMode();
        const embedded: EmbeddedDashboardCompat = await embedDashboard({
          id: dashboardId,
          supersetDomain,
          mountPoint: mountRef.current,
          // Re-invoked by the SDK on expiry. The pass lifetime is Superset's to
          // decide, so the refresh is expiry-driven rather than a timer we pick
          // here — a hardcoded interval would drift from the real lifetime.
          fetchGuestToken: async () => (await fetchGuestToken(activeTab)).token,
          dashboardUiConfig: {
            hideTitle: true,
            // Shown and expanded. `expanded: false` collapses the filter bar
            // to a strip the viewer has to find and open — the filters were
            // provisioned and present, just invisible, which reads as them not
            // existing. The bar is configured horizontal server-side
            // (tiles.yaml), so expanded costs one row across the top rather
            // than a column down the side.
            filters: { visible: true, expanded: true },
            urlParams: {
              themeMode: initialTheme,
            },
          },
        });

        // Re-checked after the await: the component may have unmounted or the
        // tab changed while the embed was being set up, and mounting into a
        // detached node leaks an iframe.
        if (cancelled as boolean) {
          void embedded.unmount();
          return;
        }

        // Follow the app's own light/dark toggle live, no re-mount. Confirmed
        // against Superset 6.1.0 (the 6.0.0 → 6.1.0 upgrade this depends on):
        // setThemeMode() on an already-mounted embed was a documented no-op
        // in 6.0.0 (its own changelog lists setThemeMode as newly functional
        // in 6.1.0, #36125) — verified live before the upgrade, called with
        // no error, dashboard stayed in its original theme. Verified live
        // again after the upgrade: the dashboard's text color switched to the
        // exact configured THEME_DARK token. setThemeConfig is deliberately
        // never called — Superset already has a complete THEME_DEFAULT/
        // THEME_DARK configured server-side (docker/superset/
        // superset_config.py), hand-converted from this app's own tokens
        // (packages/ui/src/tokens.ts); picking which of the two to show is
        // all this needs to do.
        const applyTheme = (): void => {
          try {
            embedded.setThemeMode?.(supersetThemeMode());
          } catch {
            // A dashboard that renders in the wrong theme is worth far less
            // than one that does not render, so a theme failure must never
            // reach the page's error state.
          }
        };
        applyTheme();
        const themeObserver = new MutationObserver(applyTheme);
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });

        // Size the frame to the dashboard instead of to the viewport, so the
        // whole thing is reachable by scrolling the page rather than scrolling
        // inside the iframe. getScrollSize() is the SDK's own measurement —
        // the height cannot be read from here directly, the frame being
        // cross-origin.
        let polls = 0;
        const measure = async (): Promise<void> => {
          try {
            const size = await embedded.getScrollSize?.();
            const height = size?.height;
            if (typeof height === "number" && height > 0) {
              // Scaled to match the visual scale applied to the frame, and
              // only ever grown: a chart that briefly reports short would
              // otherwise make the page jump as it settles.
              setEmbedHeight((current) =>
                Math.max(current, Math.ceil(height * EMBED_SCALE) + 24),
              );
            }
          } catch {
            // Keep the floor height; a dashboard that cannot be measured is
            // still perfectly usable, just not sized to its content.
          }
        };
        void measure();
        const heightTimer = setInterval(() => {
          polls += 1;
          if (polls > HEIGHT_POLL_COUNT) {
            clearInterval(heightTimer);
            return;
          }
          void measure();
        }, HEIGHT_POLL_MS);

        teardown = () => {
          clearInterval(heightTimer);
          themeObserver.disconnect();
          void embedded.unmount();
        };
        setLoading(false);
      } catch {
        // The API already returns a flat error carrying no internal detail;
        // this shows our own sentence rather than surfacing anything from it.
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [activeTab, retryCount, rolesReady, fetchGuestToken]);

  // Render nothing until roles resolve — see the gate comment above.
  if (!rolesReady) return null;

  return (
    // .main-content is this app's one real scroll container (32px padding,
    // header is 70px — see index.css) and pages are meant to size to their
    // own content rather than open a second nested scroll region inside it
    // (documented at .rcd-page in index.css). An embedded iframe is the
    // exception: percentage/flex heights on it only resolve against an
    // ancestor chain that is itself sized, so this page states one real
    // height once, here, and lets the panel below claim the rest via flex —
    // no second scrollbar, no fixed pixel guess for the panel itself.
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // A floor, not a fixed height. The dashboard is taller than the
        // viewport, and pinning the panel to the viewport put that overflow
        // into a scrollbar *inside* the iframe — a second scroll region nested
        // in .main-content, which is the pattern index.css calls out. Growing
        // the frame to its content instead means one scrollbar, the page's own.
        minHeight: `calc(100vh - ${PAGE_CHROME_PX}px)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>
            {/* With one tab the strip is hidden, so the heading has to say which
                dashboard this is — otherwise a customer gets an unlabelled page
                and no clue that what they are looking at is only their own work. */}
            {tabs.length === 1 && tabs[0] ? tabs[0].label : "Reporting"}
          </h1>
          {tabs.length > 1 && (
            <div style={{ display: "flex", gap: 8 }} role="tablist">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 999,
                    border: `1px solid ${TOKENS.borderColor}`,
                    background:
                      activeTab === tab.key
                        ? TOKENS.accentPrimary
                        : "transparent",
                    color: activeTab === tab.key ? "#fff" : TOKENS.textPrimary,
                    cursor: "pointer",
                    fontSize: 14,
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {isStaff && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* Info Hint with Tooltip */}
            <div
              style={{
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
              }}
              onMouseEnter={() => setShowInfoTooltip(true)}
              onMouseLeave={() => setShowInfoTooltip(false)}
            >
              <span
                role="img"
                aria-label="Reporting Info"
                tabIndex={0}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  border: `1px solid ${TOKENS.borderColor}`,
                  background: "var(--bg-secondary, rgba(255,255,255,0.05))",
                  color: TOKENS.textMuted,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "help",
                }}
              >
                ⓘ
              </span>
              {showInfoTooltip && (
                <div
                  role="tooltip"
                  style={{
                    position: "absolute",
                    top: "100%",
                    right: 0,
                    marginTop: 6,
                    padding: "8px 12px",
                    background: "var(--bg-primary, #1e1e1e)",
                    color: TOKENS.textPrimary,
                    border: `1px solid ${TOKENS.borderColor}`,
                    borderRadius: 6,
                    fontSize: 12,
                    lineHeight: 1.4,
                    width: 250,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
                    zIndex: 100,
                    pointerEvents: "none",
                  }}
                >
                  For more detailed analysis and BYOQ, please visit the Superset
                  report.
                </div>
              )}
            </div>

            {/* Explore Detailed Report Button */}
            <a
              href={supersetSiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Explore Detailed Report in Superset"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 14px",
                borderRadius: "var(--radius-md, 6px)",
                border: `1px solid ${TOKENS.borderColor}`,
                background: "var(--bg-secondary, rgba(255,255,255,0.05))",
                color: TOKENS.accentPrimary,
                textDecoration: "none",
                fontSize: 13,
                fontWeight: 600,
                transition: "all 0.15s ease",
              }}
            >
              Explore Detailed Report →
            </a>
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "flex-start",
          flex: 1,
          minHeight: 0,
        }}
      >
        <ReportingBYOQSidebar
          isOpen={isByoqOpen}
          onToggle={() => setIsByoqOpen((prev) => !prev)}
          isStaff={isStaff}
        />

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {failed ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                border: `1px solid ${TOKENS.borderColor}`,
                borderRadius: 8,
                padding: 24,
                textAlign: "center",
                color: TOKENS.textMuted,
              }}
            >
              <p style={{ margin: "0 0 12px" }}>
                Reporting is not available right now.
              </p>
              <button
                type="button"
                onClick={() => setRetryCount((n) => n + 1)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  border: `1px solid ${TOKENS.borderColor}`,
                  background: "transparent",
                  color: TOKENS.textPrimary,
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
            </div>
          ) : (
            <div
              style={{
                position: "relative",
                // A definite pixel height, not flex or a percentage. The iframe
                // fills its parent with height:100%, and a percentage only
                // resolves against a parent whose own height is definite — once
                // the page switched to min-height, 100% had nothing to resolve
                // against and the frame collapsed to zero. This is the measured
                // dashboard height, so the frame is as tall as its content and the
                // page scrolls rather than the iframe.
                height: embedHeight,
                flexShrink: 0,
              }}
            >
              {loading && (
                // The app's own spinner, not a bare string — Superset shows its
                // own loader inside the iframe, and that one cannot be restyled
                // from here (different origin). Covering the frame with ours until
                // it is ready means the branded loader is the only one seen.
                <div
                  aria-label="Loading dashboard"
                  className="loading-center"
                  style={{
                    position: "absolute",
                    inset: 0,
                    height: "auto",
                    background: "var(--bg-primary)",
                    borderRadius: "var(--radius-md)",
                    zIndex: 1,
                  }}
                >
                  <div className="spinner" />
                  <div className="loader-text">Loading dashboard…</div>
                </div>
              )}
              <div
                ref={mountRef}
                data-testid="superset-mount"
                className="superset-embed-mount"
                style={{
                  width: "100%",
                  height: "100%",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              />
              {/* The SDK's own source sets only `iframe.style.background =
                  "transparent"` on the element it creates — no width or height.
                  Without this rule the browser falls back to the historical
                  default iframe size (300x150px), which is exactly the tiny,
                  scroll-clipped box this was found rendering as. The parent
                  div's CSS above has no way to reach an element the SDK injects
                  after mount, so the iframe needs its own targeted rule. */}
              <style>{`
                .superset-embed-mount {
                  /* The frame is scaled down, so it must be sized up by the
                     inverse first — otherwise scaling shrinks the content away
                     from the right and bottom edges and leaves a blank band. */
                  --embed-scale: ${EMBED_SCALE};
                }
                .superset-embed-mount iframe {
                  border: none;
                  display: block;
                  width: calc(100% / var(--embed-scale));
                  height: calc(100% / var(--embed-scale));
                  transform: scale(var(--embed-scale));
                  transform-origin: top left;
                }
              `}</style>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReportingPage;
