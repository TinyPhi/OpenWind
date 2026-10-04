import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { initTheme } from "./lib/theme.js";
import "./i18n.js";

initTheme();

// After a redeploy, an open tab references chunk hashes that no longer exist.
// Reload once to pick up the new build; the timestamp guard prevents a reload
// loop if the failure is a real outage rather than a stale deploy.
window.addEventListener("vite:preloadError", (event) => {
  const key = "ow:chunk-reload-at";
  try {
    const last = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
