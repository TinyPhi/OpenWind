/**
 * docs/specs/multi-org-sandbox.md T6 (Phase 2) — the fixed org template a sandbox is
 * provisioned from: 1 admin + 10-20 real accounts with randomized realistic names, never
 * placeholder strings (R3). One shape, reused every time -- "randomized org shapes" is
 * explicitly out of scope (§C).
 *
 * Email/username candidates are regenerable on retry rather than pre-checked/reserved (R3:
 * "no pre-check/reservation table") -- Zitadel uniqueness is instance-wide, so T7's
 * provisioning job calls nextEmailCandidate with an incrementing attempt number each time
 * Zitadel reports a conflict, until an unused one is accepted.
 */

const GIVEN_NAMES = [
  "Olivia",
  "Liam",
  "Emma",
  "Noah",
  "Ava",
  "Elijah",
  "Sophia",
  "James",
  "Isabella",
  "Benjamin",
  "Mia",
  "Lucas",
  "Charlotte",
  "Henry",
  "Amelia",
  "Alexander",
  "Harper",
  "Mason",
  "Evelyn",
  "Ethan",
  "Abigail",
  "Daniel",
  "Ella",
  "Matthew",
  "Scarlett",
  "Jackson",
  "Grace",
  "Sebastian",
  "Chloe",
  "David",
] as const;

const FAMILY_NAMES = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Gonzalez",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
  "Moore",
  "Jackson",
  "Martin",
  "Lee",
  "Perez",
  "Thompson",
  "White",
  "Harris",
  "Sanchez",
  "Clark",
  "Ramirez",
  "Lewis",
  "Robinson",
] as const;

export type SandboxAccountRole = "admin" | "member";

export interface SandboxAccountTemplate {
  givenName: string;
  familyName: string;
  /** Local-part base, before the retry suffix and @domain are applied. */
  emailLocalPart: string;
  role: SandboxAccountRole;
}

export interface SandboxOrgTemplate {
  admin: SandboxAccountTemplate;
  members: SandboxAccountTemplate[];
}

const MIN_MEMBERS = 10;
const MAX_MEMBERS = 20;

function pick<T>(pool: readonly T[]): T {
  const item = pool[Math.floor(Math.random() * pool.length)];
  if (item === undefined) throw new Error("sandbox-org-template: empty pool");
  return item;
}

function randomAccountCount(): number {
  return (
    MIN_MEMBERS + Math.floor(Math.random() * (MAX_MEMBERS - MIN_MEMBERS + 1))
  );
}

function slugifyLocalPart(givenName: string, familyName: string): string {
  return `${givenName}.${familyName}`.toLowerCase().replace(/[^a-z.]/g, "");
}

function randomAccount(role: SandboxAccountRole): SandboxAccountTemplate {
  const givenName = pick(GIVEN_NAMES);
  const familyName = pick(FAMILY_NAMES);
  return {
    givenName,
    familyName,
    emailLocalPart: slugifyLocalPart(givenName, familyName),
    role,
  };
}

/**
 * Generates one admin + 10-20 members. Each call produces a fresh random cast — this is
 * called once per sandbox creation, never cached/reused across sandboxes.
 */
export function generateSandboxOrgTemplate(): SandboxOrgTemplate {
  const memberCount = randomAccountCount();
  return {
    admin: randomAccount("admin"),
    members: Array.from({ length: memberCount }, () => randomAccount("member")),
  };
}

/**
 * Produces the email to try for a given account template and attempt number.
 * attempt 0 is the plain `givenName.familyName@domain` address; attempt > 0 appends a random
 * 4-digit suffix so a Zitadel uniqueness conflict can be retried with a fresh candidate
 * without a pre-check/reservation table (R3).
 */
export function nextEmailCandidate(
  template: SandboxAccountTemplate,
  domain: string,
  attempt: number,
): string {
  if (attempt <= 0) return `${template.emailLocalPart}@${domain}`;
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${template.emailLocalPart}${suffix}@${domain}`;
}
