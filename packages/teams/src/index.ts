/**
 * @platform/teams
 *
 * docs/specs/oncall-routing.md T1-T3, T44 (R1d) -- teams/services/on-call
 * schedule primitives and the shared cross-tenant FK validation helper
 * reused across the on-call routing (3E) and temporal-scheduler (3F) tracks.
 *
 * Teams and services are plain Drizzle-managed tables (see
 * packages/db/src/schema/teams.ts), not entity-engine entity types --
 * ADR-016 Decision 1: on-call lookup is a hot path and must be a single
 * indexed query, not a JSONB traversal.
 */

export {
  validateCrossTenantRefs,
  lookupValidIdsInTable,
  type CrossTenantRefCheck,
  type FieldError,
} from "./cross-tenant-ref-validator.js";

export { compactTeamPositions, replaceTeamMembers } from "./team-members.js";

export { loadTeamMemberIds, loadPreviousHolders } from "./rotation-state.js";

export {
  nextAssignment,
  planWindows,
  shouldAnnounceWindow,
  ROTATION_MIN_CYCLE_DAYS,
  ROTATION_MAX_CYCLE_DAYS,
  ROTATION_DEFAULT_CYCLE_DAYS,
  ROTATION_MAX_STEPS_PER_RUN,
  ROTATION_NOTICE_LEAD_MS,
  type RotationHolders,
  type NextAssignment,
  type GeneratedWindow,
  type PlanWindowsInput,
  type PlanWindowsResult,
} from "./rotation.js";

export {
  getActiveScheduleForTeam,
  getUsersResolvableSet,
  isUserResolvable,
  classifyOncallUser,
  resolveOncallCascade,
  type OnCallScheduleRow,
  type ResolvedOncallUser,
  type OncallTier,
  type CascadeResult,
} from "./oncall-resolver.js";
