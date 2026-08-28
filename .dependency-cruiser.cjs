// dependency-cruiser config — mirrors the import-boundary rules already enforced by
// eslint.config.mjs (CLAUDE.md's "Dependency rule"), but on a real transitive graph
// instead of per-file import-specifier matching, so it also catches boundary violations
// laundered through a re-export. eslint stays the CI-blocking check; this is a second,
// queryable view of the same rules plus the `--reaches`/`--focus` impact-analysis
// commands (see .claude/context/dependency-graph.md).
//
// A forbidden cross-package/cross-module import is, by construction, never declared as
// an npm dependency (that's what makes it forbidden) — so pnpm never symlinks it into
// node_modules, and dependency-cruiser can't resolve a bare `@platform/*`/`@modules/*`
// specifier to a real path. Verified empirically: an unresolvable import is still
// recorded with `resolved` set to the raw specifier text (e.g. `"@platform/workflow-engine"`,
// `couldNotResolve: true`), and path-matching runs against that field regardless of
// whether resolution succeeded — so every rule below matches both the resolved-path form
// (relative imports) and the raw bare-specifier form. Dropping either form silently
// reintroduces a false "no violations" result for exactly the realistic case (a plain
// `@platform/workflow-engine` import) this file exists to catch.
const fs = require("node:fs");
const path = require("node:path");

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function packageNameOf(dir, folder) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, dir, folder, "package.json"), "utf8"),
    ).name;
  } catch {
    return null;
  }
}

const appDirNames = fs
  .readdirSync(path.join(__dirname, "apps"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

// App package names (e.g. "@platform/api") don't follow a predictable prefix the way
// packages/modules do, so they have to be read from each app's package.json rather than
// pattern-matched.
const appPackageNames = appDirNames
  .map((dirName) => packageNameOf("apps", dirName))
  .filter((name) => typeof name === "string");

const appAliasAlternatives = appPackageNames.map((name) => `${escapeRegex(name)}(?:$|/)`);
const packagesNoAppsPattern = ["apps/", ...appAliasAlternatives].join("|");

// One rule per app (not a single backreference-based rule like no-cross-module) —
// app package names don't derive from the folder name predictably (see
// appPackageNames's own comment above), so a single "$1"-style self-exclusion
// can't be built generically across apps the way it can for modules/*. Skips
// generating a rule at all when there are no sibling apps (otherAlternatives
// would be empty and `^(?:)` matches every string, inverting a no-op into
// "forbid everything from this app" — not reachable today at 3 apps, but a
// silent trap if this ever runs against a single-app workspace).
const noCrossAppRules = appDirNames
  .map((dirName) => {
    const otherAlternatives = appDirNames
      .filter((other) => other !== dirName)
      .flatMap((other) => {
        const pkgName = packageNameOf("apps", other);
        return [
          `apps/${escapeRegex(other)}/`,
          ...(pkgName ? [`${escapeRegex(pkgName)}(?:$|/)`] : []),
        ];
      });
    if (otherAlternatives.length === 0) return null;
    return {
      name: `no-cross-app-${dirName}`,
      comment: `apps/${dirName} cannot import from other apps.`,
      severity: "error",
      from: { path: `^apps/${escapeRegex(dirName)}/` },
      to: { path: `^(?:${otherAlternatives.join("|")})` },
    };
  })
  .filter((rule) => rule !== null);

module.exports = {
  forbidden: [
    {
      // Path regexes can only cross-reference from.path's capture group into to.path (as
      // "$1"), not the other way, so this needs exactly one rule with one capture group —
      // not one generated rule per module folder (that was also a latent regex-injection
      // risk: folder names went unescaped into a template literal).
      name: "no-cross-module",
      comment:
        "Modules cannot import from other modules. Use the event bus or entity engine relations API instead.",
      severity: "error",
      from: { path: "^modules/([^/]+)/" },
      to: {
        path: "^(?:modules/[^/]+/|@modules/[^/]+)",
        pathNot: "^(?:modules/$1/|@modules/$1(?:$|/))",
      },
    },
    {
      name: "packages-no-apps",
      comment: "Packages cannot import from apps.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: `^(?:${packagesNoAppsPattern})` },
    },
    {
      name: "packages-no-modules",
      comment: "Packages cannot import from modules.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^(?:modules/|@modules/)" },
    },
    {
      name: "entity-engine-no-workflow-or-automation",
      comment:
        "entity-engine cannot import from workflow-engine or automation-engine (dependency flows downward only).",
      severity: "error",
      from: { path: "^packages/entity-engine/" },
      to: {
        path: "^(?:packages/(?:workflow-engine|automation-engine)/|@platform/(?:workflow-engine|automation-engine)(?:$|/))",
      },
    },
    {
      name: "workflow-engine-no-automation",
      comment:
        "workflow-engine cannot import from automation-engine (dependency flows downward only).",
      severity: "error",
      from: { path: "^packages/workflow-engine/" },
      to: { path: "^(?:packages/automation-engine/|@platform/automation-engine(?:$|/))" },
    },
    ...noCrossAppRules,
  ],
  options: {
    // "dist" alongside node_modules: cross-package imports (@platform/*) resolve through
    // node_modules symlinks to each package's built dist/index.js (there's no root tsconfig
    // path-mapping to source), so dist has to stay reachable as an edge TARGET for cross-package
    // --reaches/--focus queries to work. Without also listing it here, passing "apps packages
    // modules" as cruise roots makes every compiled dist/*.js a first-class module in its own
    // right, doubling the graph with a redundant dist-internal mirror of the real source graph.
    // Anchored to whole path segments (not a bare substring) so a real source folder like
    // `src/distribution/` can't be mistaken for build output.
    doNotFollow: { path: "(?:^|/)(?:node_modules|dist)(?:$|/)" },
    tsPreCompilationDeps: true,
  },
};
