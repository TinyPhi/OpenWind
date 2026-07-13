export interface AuthContext {
  userId: string;
  tenantId: string;
  roles: string[];
  email: string;
  displayName: string;
  orgId?: string | undefined;
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
