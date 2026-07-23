import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../../", "");

  const zitadelIssuer = env["ZITADEL_ISSUER"] ?? process.env["ZITADEL_ISSUER"];
  const zitadelClientId =
    env["ZITADEL_OIDC_CLIENT_ID"] ?? process.env["ZITADEL_OIDC_CLIENT_ID"];
  const zitadelClientSecret =
    env["ZITADEL_OIDC_CLIENT_SECRET"] ??
    process.env["ZITADEL_OIDC_CLIENT_SECRET"];

  return {
    plugins: [react()],
    build: { target: "es2022" },
    server: { port: 3004 },
    define: {
      "process.env.ZITADEL_ISSUER": JSON.stringify(zitadelIssuer),
      "process.env.ZITADEL_OIDC_CLIENT_ID": JSON.stringify(zitadelClientId),
      "process.env.ZITADEL_OIDC_CLIENT_SECRET":
        JSON.stringify(zitadelClientSecret),
    },
  };
});
