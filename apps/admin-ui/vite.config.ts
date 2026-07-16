import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

function envJsPlugin(vars: Record<string, string | undefined>): Plugin {
  // ZITADEL_OIDC_CLIENT_SECRET is intentionally excluded — it must never reach the browser.
  // The SPA uses PKCE; the client secret is only needed for confidential server-side clients.
  const js = `window.__CONFIG__ = ${JSON.stringify({
    ZITADEL_ISSUER: vars["ZITADEL_ISSUER"] ?? vars["VITE_ZITADEL_ISSUER"] ?? "",
    ZITADEL_OIDC_CLIENT_ID:
      vars["ZITADEL_OIDC_CLIENT_ID"] ??
      vars["VITE_ZITADEL_OIDC_CLIENT_ID"] ??
      "",
  })};`;
  return {
    name: "serve-env-js",
    configureServer(server) {
      server.middlewares.use("/env.js", (_req, res) => {
        res.setHeader("Content-Type", "application/javascript");
        res.end(js);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load environment variables from the monorepo root (.env.local)
  const env = loadEnv(mode, "../../", "");

  return {
    plugins: [react(), envJsPlugin(env)],
    build: { target: "es2022" },
    optimizeDeps: { esbuildOptions: { target: "es2022" } },
    server: {
      port: 3001,
      host: "0.0.0.0",
      ...(env["VITE_ALLOWED_HOSTS"]
        ? { allowedHosts: env["VITE_ALLOWED_HOSTS"].split(",") }
        : {}),
      watch: {
        usePolling: true,
        interval: 300,
      },
      ...(env["VITE_API_PROXY_TARGET"]
        ? {
            proxy: {
              "/api": {
                target: env["VITE_API_PROXY_TARGET"],
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, ""),
              },
            },
          }
        : {}),
    },
  };
});
