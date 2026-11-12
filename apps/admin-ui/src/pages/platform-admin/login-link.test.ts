import { describe, it, expect } from "vitest";
import { loginLink } from "./login-link.js";

describe("loginLink", () => {
  it("is the origin's /login with the login key as the org value", () => {
    expect(loginLink("3f9a1c7e2b4d8a60", "https://app.example.com")).toBe(
      "https://app.example.com/login?org=3f9a1c7e2b4d8a60",
    );
  });

  it("uses the page's own origin when none is given", () => {
    expect(loginLink("3f9a1c7e2b4d8a60")).toBe(
      `${window.location.origin}/login?org=3f9a1c7e2b4d8a60`,
    );
  });

  it("encodes a key that ever contains a reserved character", () => {
    expect(loginLink("a b&c", "https://x.test")).toBe(
      "https://x.test/login?org=a%20b%26c",
    );
  });
});
