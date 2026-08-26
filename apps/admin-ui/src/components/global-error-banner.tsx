import React, {
  useEffect,
  useState,
  useCallback,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { userManager } from "../authProvider.js";
import { subscribe, getSnapshot } from "../lib/network-status.js";

interface ApiErrorEvent {
  type: "auth" | "server";
  message: string;
}

interface Banner {
  id: number;
  type: "auth" | "server";
  message: string;
}

let _nextId = 0;

export function GlobalErrorBanner(): React.ReactElement | null {
  const { t } = useTranslation();
  const [banners, setBanners] = useState<Banner[]>([]);
  const network = useSyncExternalStore(subscribe, getSnapshot);

  const dismiss = useCallback((id: number) => {
    setBanners((prev) => prev.filter((b) => b.id !== id));
  }, []);

  useEffect(() => {
    const handler = (e: Event): void => {
      const { type, message } = (e as CustomEvent<ApiErrorEvent>).detail;
      // De-duplicate: don't stack identical auth errors.
      setBanners((prev) => {
        if (type === "auth" && prev.some((b) => b.type === "auth")) return prev;
        const id = ++_nextId;
        // Auto-dismiss server errors after 6 s; auth errors stay until acted on.
        if (type === "server") {
          setTimeout(() => dismiss(id), 6_000);
        }
        return [...prev, { id, type, message }];
      });
    };
    window.addEventListener("api:error", handler);
    return () => window.removeEventListener("api:error", handler);
  }, [dismiss]);

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

  if (banners.length === 0 && !networkBanner) return null;

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
      {banners.map((b) => (
        <div key={b.id} className={`geb-banner geb-${b.type}`}>
          <span className="geb-icon" aria-hidden="true">
            {b.type === "auth" ? "🔒" : "⚠️"}
          </span>
          <span className="geb-msg">{b.message}</span>
          <div className="geb-actions">
            {b.type === "auth" && (
              <button
                className="geb-btn geb-btn-primary"
                onClick={() => {
                  void userManager.signinRedirect();
                }}
              >
                {t("network.logInAgain")}
              </button>
            )}
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
