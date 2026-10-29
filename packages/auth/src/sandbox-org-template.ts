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

import { randomInt } from "node:crypto";

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
  /** Written to Zitadel user metadata (`department`/`title`) so the org chart has real data. */
  department: string;
  title: string;
  /**
   * Position of this account's manager in `[admin, ...members]` (0 = the admin), or null for a
   * top-level manager, who attaches directly under the org-chart root card.
   */
  reportsTo: number | null;
}

export interface SandboxOrgTemplate {
  admin: SandboxAccountTemplate;
  members: SandboxAccountTemplate[];
}

// Four org-chart levels: org-name root card -> three department managers (the admin plus the
// first two members) -> two team leads per manager (members 2-7) -> employees spread across the
// leads. Every manager therefore branches into at least two people. MIN_MEMBERS (10) guarantees
// the eight manager/lead slots exist, leaving at least two employees.
const DEPARTMENTS = [
  {
    name: "engineering",
    managerTitle: "Engineering Manager",
    leadTitle: "Engineering Team Lead",
    staffTitle: "Software Engineer",
  },
  {
    name: "sales",
    managerTitle: "Sales Manager",
    leadTitle: "Sales Team Lead",
    staffTitle: "Sales Executive",
  },
  {
    name: "support",
    managerTitle: "Support Manager",
    leadTitle: "Support Team Lead",
    staffTitle: "Support Specialist",
  },
] as const;

const MIN_MEMBERS = 10;
const MAX_MEMBERS = 20;

function pick<T>(pool: readonly T[]): T {
  const item = pool[randomInt(pool.length)];
  if (item === undefined) throw new Error("sandbox-org-template: empty pool");
  return item;
}

function randomAccountCount(): number {
  return randomInt(MIN_MEMBERS, MAX_MEMBERS + 1);
}

function slugifyLocalPart(givenName: string, familyName: string): string {
  return `${givenName}.${familyName}`.toLowerCase().replace(/[^a-z.]/g, "");
}

function randomAccount(
  role: SandboxAccountRole,
  placement: Pick<SandboxAccountTemplate, "department" | "title" | "reportsTo">,
): SandboxAccountTemplate {
  const givenName = pick(GIVEN_NAMES);
  const familyName = pick(FAMILY_NAMES);
  return {
    givenName,
    familyName,
    emailLocalPart: slugifyLocalPart(givenName, familyName),
    role,
    ...placement,
  };
}

export interface SandboxOrgPlacement {
  department: string;
  title: string;
  /** Position of the manager in the same ordering, or null for a top-level manager. */
  reportsTo: number | null;
}

/**
 * The default department/reporting structure, by position in a list of accounts (0 = admin):
 * positions 0-2 are the three managers, 3-8 the six team leads (two per manager), 9+ employees
 * spread across the leads. Used both to build a new sandbox's template and to back-fill an
 * existing sandbox's users, so the two can never drift apart.
 */
export function sandboxOrgPlacement(position: number): SandboxOrgPlacement {
  const dept = (index: number): (typeof DEPARTMENTS)[number] =>
    DEPARTMENTS[index % 3] ?? DEPARTMENTS[0];
  if (position < 3) {
    return {
      department: dept(position).name,
      title: dept(position).managerTitle,
      reportsTo: null,
    };
  }
  if (position < 9) {
    const managerPosition = (position - 3) % 3;
    return {
      department: dept(managerPosition).name,
      title: dept(managerPosition).leadTitle,
      reportsTo: managerPosition,
    };
  }
  const leadPosition = 3 + ((position - 9) % 6);
  const departmentIndex = (leadPosition - 3) % 3;
  return {
    department: dept(departmentIndex).name,
    title: dept(departmentIndex).staffTitle,
    reportsTo: leadPosition,
  };
}

/**
 * Generates one admin + 10-20 members using `sandboxOrgPlacement` (three managers, six team
 * leads, the rest employees). Each call produces a fresh random cast — called once per sandbox
 * creation, never cached/reused across sandboxes.
 */
export function generateSandboxOrgTemplate(): SandboxOrgTemplate {
  const memberCount = randomAccountCount();
  return {
    admin: randomAccount("admin", sandboxOrgPlacement(0)),
    members: Array.from({ length: memberCount }, (_, i) =>
      randomAccount("member", sandboxOrgPlacement(i + 1)),
    ),
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
  const suffix = randomInt(1000, 10000);
  return `${template.emailLocalPart}${suffix}@${domain}`;
}
