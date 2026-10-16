/**
 * Where the login page's "Contact us" link goes: a Gmail draft to the sales inbox, prefilled
 * as a product-trial request, so a prospect only has to fill in their details.
 */

export const CONTACT_EMAIL = "info@rokkalabs.com";

export const CONTACT_SUBJECT = "OpenWind product trial request";

export const CONTACT_BODY = [
  "Hi Rokka Labs team,",
  "",
  "I'd like to try OpenWind for my organisation and would like to know more about a product trial.",
  "",
  "Name:",
  "Company:",
  "Role:",
  "Team size:",
  "Phone (optional):",
  "What we'd like to use OpenWind for:",
  "",
  "Please let me know the next steps.",
  "",
  "Thanks,",
].join("\n");

/** Gmail's compose window (view=cm), opened full-page (fs=1). */
export function contactUsHref(): string {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: CONTACT_EMAIL,
    su: CONTACT_SUBJECT,
    body: CONTACT_BODY,
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}
