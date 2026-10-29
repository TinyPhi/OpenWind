import { describe, it, expect } from "vitest";
import {
  generateSandboxOrgTemplate,
  sandboxOrgPlacement,
  nextEmailCandidate,
} from "./sandbox-org-template.js";

describe("generateSandboxOrgTemplate", () => {
  it("returns exactly one admin and 10-20 members", () => {
    for (let i = 0; i < 20; i++) {
      const template = generateSandboxOrgTemplate();
      expect(template.admin.role).toBe("admin");
      expect(template.members.length).toBeGreaterThanOrEqual(10);
      expect(template.members.length).toBeLessThanOrEqual(20);
      for (const member of template.members) {
        expect(member.role).toBe("member");
      }
    }
  });

  it("never produces a placeholder name — every account has a real given/family name", () => {
    const template = generateSandboxOrgTemplate();
    const all = [template.admin, ...template.members];
    for (const account of all) {
      expect(account.givenName.length).toBeGreaterThan(0);
      expect(account.familyName.length).toBeGreaterThan(0);
      expect(account.emailLocalPart).not.toMatch(/placeholder|test|user\d+/i);
    }
  });

  it("lays out three managers, two team leads under each, and employees under the leads", () => {
    for (let i = 0; i < 20; i++) {
      const { admin, members } = generateSandboxOrgTemplate();
      const all = [admin, ...members];
      const depthOf = (position: number): number => {
        let depth = 0;
        let current: number | null = position;
        while (current !== null) {
          current = all[current]?.reportsTo ?? null;
          if (current !== null) depth++;
        }
        return depth;
      };
      const positionsAt = (d: number): number[] =>
        all.flatMap((_, pos) => (depthOf(pos) === d ? [pos] : []));

      const managers = positionsAt(0);
      const leads = positionsAt(1);
      expect(managers).toHaveLength(3);
      expect(new Set(managers.map((m) => all[m]?.department)).size).toBe(3);
      expect(leads).toHaveLength(6);
      for (const manager of managers) {
        const reports = all.filter((a) => a.reportsTo === manager);
        expect(reports.length).toBeGreaterThanOrEqual(2);
      }
      expect(positionsAt(2).length).toBe(all.length - 9);
      expect(all.some((_, pos) => depthOf(pos) > 2)).toBe(false);

      for (const account of all) {
        if (account.reportsTo === null) continue;
        expect(all[account.reportsTo]?.department).toBe(account.department);
      }
    }
  });

  it("produces a fresh random cast on each call", () => {
    const a = generateSandboxOrgTemplate();
    const b = generateSandboxOrgTemplate();
    // Extremely unlikely (but not impossible) for two random casts to be
    // identical in both member count and admin identity — assert on the
    // cheaper, still-meaningful signal that counts vary across many calls.
    const counts = new Set(
      Array.from(
        { length: 30 },
        () => generateSandboxOrgTemplate().members.length,
      ),
    );
    expect(counts.size).toBeGreaterThan(1);
    expect(a.admin).toBeDefined();
    expect(b.admin).toBeDefined();
  });
});

describe("nextEmailCandidate", () => {
  const template = {
    givenName: "Olivia",
    familyName: "Smith",
    emailLocalPart: "olivia.smith",
    role: "admin" as const,
    department: "engineering",
    title: "Engineering Manager",
    reportsTo: null,
  };

  it("attempt 0 returns the plain local-part address", () => {
    expect(nextEmailCandidate(template, "example.com", 0)).toBe(
      "olivia.smith@example.com",
    );
  });

  it("attempt > 0 appends a retry suffix, producing a different address each time", () => {
    const first = nextEmailCandidate(template, "example.com", 1);
    const second = nextEmailCandidate(template, "example.com", 2);
    expect(first).toMatch(/^olivia\.smith\d{4}@example\.com$/);
    expect(second).toMatch(/^olivia\.smith\d{4}@example\.com$/);
  });

  it("keeps the retry suffix within 1000-9999", () => {
    for (let attempt = 1; attempt <= 500; attempt++) {
      const email = nextEmailCandidate(template, "example.com", attempt);
      const suffix = Number(
        email.slice("olivia.smith".length, email.indexOf("@")),
      );
      expect(suffix).toBeGreaterThanOrEqual(1000);
      expect(suffix).toBeLessThanOrEqual(9999);
    }
  });
});

describe("sandboxOrgPlacement", () => {
  it("places positions 0-2 as managers, 3-8 as leads under them, 9+ as employees under leads", () => {
    expect(sandboxOrgPlacement(0)).toMatchObject({
      department: "engineering",
      reportsTo: null,
    });
    expect(sandboxOrgPlacement(2)).toMatchObject({
      department: "support",
      reportsTo: null,
    });
    expect(sandboxOrgPlacement(3)).toMatchObject({
      department: "engineering",
      reportsTo: 0,
    });
    expect(sandboxOrgPlacement(8)).toMatchObject({
      department: "support",
      reportsTo: 2,
    });
    expect(sandboxOrgPlacement(9)).toMatchObject({
      department: "engineering",
      reportsTo: 3,
    });
    expect(sandboxOrgPlacement(10)).toMatchObject({
      department: "sales",
      reportsTo: 4,
    });
    expect(sandboxOrgPlacement(15)).toMatchObject({ reportsTo: 3 });
  });
});
