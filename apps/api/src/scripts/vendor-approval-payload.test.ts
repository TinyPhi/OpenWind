import { describe, it, expect } from "vitest";
import {
  VendorPayloadSchema,
  mapVendorPayload,
} from "./vendor-approval-payload.js";

const VALID = {
  source: "synthetic-demo",
  externalId: "ext-001",
  vendor: {
    name: "Acme Analytics",
    email: "sales@acme.example",
    category: "software",
    annualSpend: 120000,
    currency: "inr",
    justification: "Replaces three finance spreadsheets.",
  },
};

describe("VendorPayloadSchema", () => {
  it("accepts a well-formed payload", () => {
    expect(VendorPayloadSchema.safeParse(VALID).success).toBe(true);
  });

  it("rejects an unknown category", () => {
    const bad = { ...VALID, vendor: { ...VALID.vendor, category: "catering" } };
    expect(VendorPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a negative spend and a malformed email", () => {
    const negative = {
      ...VALID,
      vendor: { ...VALID.vendor, annualSpend: -1 },
    };
    const badEmail = { ...VALID, vendor: { ...VALID.vendor, email: "nope" } };
    expect(VendorPayloadSchema.safeParse(negative).success).toBe(false);
    expect(VendorPayloadSchema.safeParse(badEmail).success).toBe(false);
  });
});

describe("mapVendorPayload", () => {
  it("maps the payload onto vendor entity fields, carrying source and external id", () => {
    const fields = mapVendorPayload(VendorPayloadSchema.parse(VALID));
    expect(fields).toEqual({
      vendor_name: "Acme Analytics",
      category: "software",
      contact_email: "sales@acme.example",
      annual_spend_estimate: { amount: 120000, currency: "INR" },
      business_justification: "Replaces three finance spreadsheets.",
      source_system: "synthetic-demo",
      external_ref: "ext-001",
    });
  });
});
