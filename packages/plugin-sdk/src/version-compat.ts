/**
 * R10: platformVersion compatibility check. Deliberately not the `semver` package —
 * this repo's connector-sdk precedent avoids pulling extra dependencies into a
 * lightweight SDK package for a need this small. Supports exactly the operators a
 * plugin manifest needs: an exact version, or `>=`/`^` against major.minor.patch.
 */

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(version: string): ParsedVersion | null {
  const m = VERSION_RE.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * `range` comes from `PluginManifest.platformVersion`. Supported forms:
 *   "1.2.3"   — exact match only
 *   ">=1.2.3" — platformVersion is at least this
 *   "^1.2.3"  — same major version, >= this minor.patch
 * Anything else (unparseable) is treated as incompatible — fail closed, never
 * silently allow an install whose compatibility we couldn't actually check.
 */
export function isPlatformVersionCompatible(
  range: string,
  platformVersion: string,
): boolean {
  const platform = parseVersion(platformVersion);
  if (!platform) return false;

  if (range.startsWith(">=")) {
    const min = parseVersion(range.slice(2).trim());
    if (!min) return false;
    return compareVersions(platform, min) >= 0;
  }

  if (range.startsWith("^")) {
    const min = parseVersion(range.slice(1).trim());
    if (!min) return false;
    return platform.major === min.major && compareVersions(platform, min) >= 0;
  }

  const exact = parseVersion(range);
  if (!exact) return false;
  return compareVersions(platform, exact) === 0;
}
