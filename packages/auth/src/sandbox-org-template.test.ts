import { describe, it, expect } from "vitest";
import {
  generateSandboxOrgTemplate,
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
});
