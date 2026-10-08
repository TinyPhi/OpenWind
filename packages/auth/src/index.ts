export {
  requireAuth,
  requirePlatformAdmin,
  requirePlatformAdminIdentity,
  requireRole,
  requireIntrospection,
  hashApiKey,
  hashApiKeyArgon2,
  lookupTenantIdByOrgId,
  lookupOrgIdByTenantId,
  API_KEY_DEFAULT_TTL_DAYS,
  API_KEY_ROTATION_OVERLAP_HOURS,
  billingGate,
  resolveTenantPlan,
  resolveTenantIpAllowlist,
  checkIpInAllowlist,
} from "./middleware.js";
export {
  invalidateTenantStatusCache,
  getCachedTenantPlan,
  setCachedTenantPlan,
  getCachedTenantIpAllowlist,
  setCachedTenantIpAllowlist,
  startTenantStatusInvalidationSubscriber,
  stopTenantStatusInvalidationSubscriber,
} from "./tenant-status-cache.js";
export {
  getTenantRateLimitOverride,
  setTenantRateLimitOverride,
  _clearTenantRateLimitCacheForTests,
} from "./tenant-rate-limit.js";
export type {
  AuthContext,
  PlatformAdminAuthContext,
  ZitadelClaims,
  IntrospectionResult,
} from "./types.js";
export {
  verifyJwt,
  verifyJwtWithAudience,
  extractAuthContext,
  extractPlatformAdminContext,
  PLATFORM_ADMIN_ROLE,
} from "./jwks.js";
export {
  assertExternalIssuerEgressAllowed,
  SsrfGuardError,
} from "./ssrf-guard.js";
export {
  requireActingPerson,
  ACTING_PERSON_TOKEN_MAX_AGE_MINUTES,
} from "./dual-identity.js";
export type { ActingPersonContext } from "./dual-identity.js";
export { introspectToken } from "./introspection.js";
export {
  listProjectRoles,
  listOrgUsers,
  listUserIdsWithRole,
  listUserRolesByUserId,
  getUserById,
  getOrgMetadataForUser,
  invalidateUserCache,
  deleteUser,
  parseProvisioningServiceAccountKey,
} from "./zitadel-management.js";
export type {
  OrgUser,
  OrgMetadata,
  ServiceAccountKey,
} from "./zitadel-management.js";
export {
  detectScopesFormat,
  unknownTicketActionScopes,
  TICKET_ACTION_VERBS,
} from "./scopes.js";
export type { ScopesFormat, TicketActionVerb } from "./scopes.js";
export { applicationActorIdFromUserId } from "./application-actor-id.js";
export {
  requestMfaCode,
  verifyMfaCode,
  isMfaVerified,
} from "./platform-admin-mfa.js";
