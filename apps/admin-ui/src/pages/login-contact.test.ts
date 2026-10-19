import { describe, it, expect } from "vitest";
import {
  contactUsHref,
  CONTACT_EMAIL,
  CONTACT_SUBJECT,
  CONTACT_BODY,
} from "./login-contact.js";

describe("contactUsHref", () => {
  const url = new URL(contactUsHref());

  it("opens Gmail's compose window", () => {
    expect(url.origin).toBe("https://mail.google.com");
    expect(url.pathname).toBe("/mail/");
    expect(url.searchParams.get("view")).toBe("cm");
    expect(url.searchParams.get("fs")).toBe("1");
  });

  it("addresses the draft to the sales inbox", () => {
    expect(CONTACT_EMAIL).toBe("info@rokkalabs.com");
    expect(url.searchParams.get("to")).toBe("info@rokkalabs.com");
  });

  it("prefills the trial-request subject and body, line breaks intact", () => {
    expect(url.searchParams.get("su")).toBe(CONTACT_SUBJECT);
    const body = url.searchParams.get("body") ?? "";
    expect(body).toBe(CONTACT_BODY);
    expect(body.split("\n")).toContain("Company:");
    expect(body).toMatch(/product trial/);
  });

  it("keeps characters like & and ' from breaking the URL", () => {
    // "I'd" and any & in the template must survive encoding as part of the body.
    expect(url.searchParams.get("body")).toContain("I'd like to try OpenWind");
    expect([...url.searchParams.keys()].sort()).toEqual(
      ["body", "fs", "su", "to", "view"].sort(),
    );
  });
});
