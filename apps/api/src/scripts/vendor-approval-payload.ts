import { z } from "zod";

// The single seam between an external vendor source and the vendor-approval
// module (docs/specs/vendor-approval.md §D2). Today only the synthetic demo
// fixtures feed it; a real source (#634) replaces the caller, not this shape
// or anything downstream of it.
export const VendorPayloadSchema = z.object({
  source: z.string().min(1).max(64),
  externalId: z.string().min(1).max(128),
  vendor: z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    category: z.enum(["software", "services", "hardware", "consulting"]),
    annualSpend: z.number().nonnegative(),
    currency: z.string().length(3),
    justification: z.string().min(1).max(5000),
  }),
});

export type VendorPayload = z.infer<typeof VendorPayloadSchema>;

export type VendorFields = {
  vendor_name: string;
  category: VendorPayload["vendor"]["category"];
  contact_email: string;
  annual_spend_estimate: { amount: number; currency: string };
  business_justification: string;
  source_system: string;
  external_ref: string;
};

export function mapVendorPayload(payload: VendorPayload): VendorFields {
  return {
    vendor_name: payload.vendor.name,
    category: payload.vendor.category,
    contact_email: payload.vendor.email,
    annual_spend_estimate: {
      amount: payload.vendor.annualSpend,
      currency: payload.vendor.currency.toUpperCase(),
    },
    business_justification: payload.vendor.justification,
    source_system: payload.source,
    external_ref: payload.externalId,
  };
}
