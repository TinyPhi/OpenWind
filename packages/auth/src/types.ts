export interface AuthContext {
  userId: string;
  tenantId: string;
  roles: string[];
  email: string;
  displayName: string;
  orgId?: string | undefined;
}

/**
 * Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md, ADR-022). Deliberately has no
 * `tenantId` field at all -- platform_admin is cross-tenant by design, and a route reading
 * this type can never accidentally scope a query to "whichever tenant happens to be in the
 * token" the way a stray `auth.tenantId` read would on AuthContext. Routes needing this
 * context use `requirePlatformAdmin()` (packages/auth/src/middleware.ts), never
 * `requireAuth()`.
 */
export interface PlatformAdminAuthContext {
  userId: string;
  roles: string[];
  email: string;
  displayName: string;
}

// Zitadel JWT claim shapes
export interface ZitadelClaims {
  sub: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  // Zitadel sets organization context via this claim — only present when the
  // "urn:zitadel:iam:user:resourceowner" scope is requested at login.
  "urn:zitadel:iam:user:resourceowner:id"?: string;
  // Project-level roles: { [projectId]: { [roleName]: { [orgId]: string } } }
  "urn:zitadel:iam:org:project:roles"?: Record<
    string,
    Record<string, Record<string, string>>
  >;
  // Standard OIDC "Authentication Methods References" claim. Zitadel includes the second
  // factor used (e.g. "otp", "mfa") when the org/login policy required one. Checked by
  // jwks.ts's hasMfaFactor for the platform_admin login path (docs/specs/
  // multi-org-sandbox.md R1) -- MFA enforcement for every other role is Zitadel's login
  // policy alone; platform_admin additionally re-checks it server-side as defense-in-depth,
  // since a platform_admin token is cross-tenant and worth a second, independent guard.
  amr?: string[];
}

export interface IntrospectionResult {
  active: boolean;
  sub?: string;
  email?: string;
  "urn:zitadel:iam:user:resourceowner:id"?: string;
  "urn:zitadel:iam:org:project:roles"?: Record<
    string,
    Record<string, Record<string, string>>
  >;
}
