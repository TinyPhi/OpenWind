import type { z } from "zod";

// No `credentials` field: connector code never sees raw secrets (ADR-009 Decision #5).
// The runtime decrypts credentials server-side and attaches them inside callApi() only.
export interface ConnectorContext {
  tenantId: string;
  callApi: (config: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }) => Promise<Response>;
  log: (
    level: "info" | "warn" | "error",
    message: string,
    meta?: object,
  ) => void;
}

export interface TriggerDefinition {
  id: string;
  name: string;
  description: string;
  type: "webhook" | "polling";
  webhook?: {
    // No validateSignature: verification is centralized in the webhook gateway
    // (ADR-009 Decision #3), not connector-authored code.
    transform: (rawPayload: unknown) => Promise<Record<string, unknown>>;
  };
  polling?: {
    intervalMinutes: number;
    fetch: (
      ctx: ConnectorContext,
      cursor?: string,
    ) => Promise<{
      events: Record<string, unknown>[];
      nextCursor?: string;
    }>;
  };
}

// Default cap on a connector action's serialized output payload, enforced at
// the outbound delivery boundary (ADR-009 Decision #10, issue #365) — an
// integrity/DoS control, distinct from the confidentiality control the
// sensitivity redactor provides. Chosen to comfortably fit a real event
// payload while still rejecting a runaway/malformed one before any network
// call is attempted; roughly in line with common webhook-provider caps
// (e.g. Svix recommends keeping payloads well under 256KB).
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export interface ActionDefinition {
  id: string;
  name: string;
  description: string;
  input: z.ZodSchema;
  output: z.ZodSchema;
  execute: (input: unknown, ctx: ConnectorContext) => Promise<unknown>;
  rateLimit?: { requestsPerMinute: number; requestsPerDay?: number };
  retryConfig?: {
    maxAttempts: number;
    backoffMs: number;
    retryOn: (error: Error) => boolean;
  };
  /**
   * Max serialized size (bytes, UTF-8) of this action's output payload,
   * enforced at the outbound delivery boundary before any delivery attempt
   * (ADR-009 Decision #10). Defaults to DEFAULT_MAX_OUTPUT_BYTES if omitted.
   */
  maxOutputBytes?: number;
}

// Discriminated union of supported auth mechanisms for a connector's outbound
// API calls (ADR-009 Decision #5). `credentialKey` (and its variants) names a
// logical secret — the `connector_credentials.secrets` column (issue #363)
// stores a JSONB map of `credentialKey -> ciphertext` per tenant-connector
// installation.
export type ConnectorAuthConfig =
  | { type: "bearer"; credentialKey: string }
  | {
      type: "basic";
      usernameCredentialKey: string;
      passwordCredentialKey: string;
    }
  | { type: "apiKey"; headerName: string; credentialKey: string };

export interface ConnectorDefinition {
  meta: {
    id: string;
    name: string;
    version: string;
    description: string;
    iconUrl: string;
    docsUrl?: string;
    category:
      | "communication"
      | "finance"
      | "crm"
      | "hr"
      | "storage"
      | "ecommerce"
      | "other";
  };
  // Per-connector egress allowlist (ADR-009 Decision #5): callApi() enforces this
  // and validateWebhookUrl() against the target on every call, so a connector can
  // only ever reach the third-party host(s) it declares here.
  // Hostnames only — no scheme, no path, no wildcards (e.g. ["api.slack.com"]).
  allowedHosts: string[];
  auth: ConnectorAuthConfig;
  triggers: TriggerDefinition[];
  actions: ActionDefinition[];
  onInstall?: (ctx: ConnectorContext) => Promise<void>;
  onUninstall?: (ctx: ConnectorContext) => Promise<void>;
}
