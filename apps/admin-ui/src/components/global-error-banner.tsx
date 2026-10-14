import React, {
  useEffect,
  useState,
  useCallback,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { subscribe, getSnapshot } from "../lib/network-status.js";
import { consumeSessionExpiredNotice } from "../lib/session-expiry.js";

interface ApiErrorEvent {
  type: "server";
  message: string;
}

interface Banner {
  id: number;
  type: "auth" | "server";
  message: string;
}

let _nextId = 0;

// Read once at module load, not in the component: React Strict Mode runs the
// state initializer twice in dev, and the notice is one-shot (the first read
// clears it), so the visible mount would otherwise see nothing.
const INITIAL_SESSION_EXPIRED_NOTICE = consumeSessionExpiredNotice();

export function GlobalErrorBanner(): React.ReactElement | null {
  const { t } = useTranslation();
  const [banners, setBanners] = useState<Banner[]>(() =>
    INITIAL_SESSION_EXPIRED_NOTICE
      ? [{ id: ++_nextId, type: "auth", message: t("network.sessionExpired") }]
      : [],
  );
  const [degradedMsg, setDegradedMsg] = useState<string | null>(null);
  const network = useSyncExternalStore(subscribe, getSnapshot);

  const dismiss = useCallback((id: number) => {
    setBanners((prev) => prev.filter((b) => b.id !== id));
  }, []);

  useEffect(() => {
    const handler = (e: Event): void => {
      const { type, message } = (e as CustomEvent<ApiErrorEvent>).detail;
      setBanners((prev) => {
        const id = ++_nextId;
        // Server errors auto-dismiss after 6 s; the session-expired notice stays until dismissed.
        setTimeout(() => dismiss(id), 6_000);
        return [...prev, { id, type, message }];
      });
    };
    window.addEventListener("api:error", handler);
    return () => window.removeEventListener("api:error", handler);
  }, [dismiss]);

  useEffect(() => {
    const handler = (e: Event): void => {
      const { degraded } = (e as CustomEvent<{ degraded: string }>).detail;
      setDegradedMsg(degraded);
    };
    window.addEventListener("tenant:degraded", handler);
    return () => window.removeEventListener("tenant:degraded", handler);
  }, []);

  // Network banners are never dismissible (unlike auth/server banners) — the
  // "recovered" state's own auto-transition to "online" (network-status.ts)
  // is what removes it, so there's no per-banner dismiss affordance to gate.
  const networkBanner = (() => {
    switch (network.kind) {
      case "offline":
        return { icon: "🔌", message: t("network.offline") };
      case "reconnecting":
        return { icon: "⚠️", message: t("network.reconnecting") };
      case "recovered":
        return { icon: "✅", message: t("network.backOnline") };
      case "online":
        return null;
    }
  })();

  if (banners.length === 0 && !networkBanner && !degradedMsg) return null;

  return (
    <div
      className="geb-stack"
      role="status"
      aria-live="polite"
      aria-label={t("network.regionLabel")}
    >
      {networkBanner && (
        <div className="geb-banner geb-network">
          <span className="geb-icon" aria-hidden="true">
            {networkBanner.icon}
          </span>
          <span className="geb-msg">{networkBanner.message}</span>
        </div>
      )}
      {degradedMsg && (
        <div className="geb-banner geb-server geb-degraded">
          <span className="geb-icon" aria-hidden="true">
            ⚠️
          </span>
          <span className="geb-msg">
            {t("network.planDegraded", { metrics: degradedMsg })}
          </span>
          <div className="geb-actions">
            <a className="geb-btn geb-btn-primary" href="#/settings">
              {t("network.viewUsage")}
            </a>
            <button
              className="geb-btn geb-btn-ghost"
              onClick={() => setDegradedMsg(null)}
            >
              {t("network.dismiss")}
            </button>
          </div>
        </div>
      )}
      {banners.map((b) => (
        <div key={b.id} className={`geb-banner geb-${b.type}`}>
          <span className="geb-icon" aria-hidden="true">
            {b.type === "auth" ? "🔒" : "⚠️"}
          </span>
          <span className="geb-msg">{b.message}</span>
          <div className="geb-actions">
            <button
              className="geb-btn geb-btn-ghost"
              onClick={() => dismiss(b.id)}
            >
              {t("network.dismiss")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
