import React from "react";
import { OrgBrandMark } from "./org-brand-mark.js";
import type { OrgBrandingState } from "../hooks/use-org-branding.js";

// The top-left brand of the app header and of the login page (docs/specs/multi-org-sandbox.md
// R12, R13). A sandbox shows its own logo (or initials) and name; every other tenant, and every
// visitor without a sandbox login link, keeps OpenWind.
// While the lookup is in flight the OpenWind brand holds the space invisibly, so a sandbox user
// never sees it flash before their org's.
export function HeaderBrand({
  branding,
}: {
  branding: OrgBrandingState;
}): React.ReactElement {
  if (branding.status === "org") {
    return (
      <>
        <OrgBrandMark name={branding.name} logo={branding.logo} size={24} />
        <div className="logo-text" title={branding.name}>
          <span
            style={{
              display: "block",
              minWidth: 0,
              maxWidth: "240px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {branding.name}
          </span>
        </div>
      </>
    );
  }
  return (
    <>
      <img
        src="/favicon.svg"
        alt="OpenWind"
        className="logo-icon"
        style={
          branding.status === "loading" ? { visibility: "hidden" } : undefined
        }
      />
      <div
        className="logo-text"
        style={
          branding.status === "loading" ? { visibility: "hidden" } : undefined
        }
      >
        OpenWind
      </div>
    </>
  );
}
