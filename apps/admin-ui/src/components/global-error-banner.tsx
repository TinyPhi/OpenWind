import React, { useEffect, useState, useCallback } from "react";
import { userManager } from "../authProvider.js";

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
  const [banners, setBanners] = useState<Banner[]>([]);

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

  if (banners.length === 0) return null;

  return (
    <div className="geb-stack">
      {banners.map((b) => (
        <div key={b.id} className={`geb-banner geb-${b.type}`}>
          <span className="geb-icon">{b.type === "auth" ? "🔒" : "⚠️"}</span>
          <span className="geb-msg">{b.message}</span>
          <div className="geb-actions">
            {b.type === "auth" && (
              <button
                className="geb-btn geb-btn-primary"
                onClick={() => {
                  void userManager.signinRedirect();
                }}
              >
                Log in again
              </button>
            )}
            <button
              className="geb-btn geb-btn-ghost"
              onClick={() => dismiss(b.id)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
