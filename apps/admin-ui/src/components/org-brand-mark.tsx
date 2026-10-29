import React, { useState } from "react";
import { initials } from "../lib/format.js";

export interface OrgBrandMarkProps {
  name: string;
  logo?: string | null | undefined;
  /** Height in px; the logo keeps its aspect ratio, the initials tile is square. */
  size: number;
  className?: string | undefined;
}

/**
 * An org's mark: its logo, or when none is set (or it fails to load) a tile with the initials of
 * its name -- the same rule the user avatar uses. Shared by the app header and the platform-admin
 * branding dialog's preview (docs/specs/multi-org-sandbox.md R12).
 */
export function OrgBrandMark({
  name,
  logo,
  size,
  className,
}: OrgBrandMarkProps): React.ReactElement {
  const [failedLogo, setFailedLogo] = useState<string | null>(null);

  if (logo && logo !== failedLogo) {
    return (
      <img
        src={logo}
        alt=""
        className={className}
        onError={() => setFailedLogo(logo)}
        style={{
          height: `${size}px`,
          width: "auto",
          maxWidth: `${size * 3}px`,
          objectFit: "contain",
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "6px",
        background: "var(--accent-primary, #00aa55)",
        color: "#ffffff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: `${Math.round(size * 0.45)}px`,
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      {initials(name)}
    </div>
  );
}
