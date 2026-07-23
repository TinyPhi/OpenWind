import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import globals from "globals";

/**
 * ESLint flat config.
 *
 * CRITICAL: The import boundary rules here enforce the platform's dependency
 * rule. Violations are errors, not warnings. They will fail CI.
 *
 * Rule summary:
 *   modules/* → cannot import from other modules/*
 *   packages/* → cannot import from apps/* or modules/*
 *   apps/* → cannot import from other apps/*
 *   All code → no direct process.env (use @platform/config)
 *   All code → no 'any' type (use unknown + type guards)
 */

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.next/**",
      "**/build/**",
    ],
  },

  // ─── Base JS rules ────────────────────────────────────────────────────────
  js.configs.recommended,

  // ─── TypeScript rules ─────────────────────────────────────────────────────
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "@typescript-eslint": tsPlugin,
      import: importPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // ── TypeScript strictness ──────────────────────────────────────────
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/explicit-function-return-type": ["error", {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
        allowHigherOrderFunctions: true,
      }],
      "@typescript-eslint/consistent-type-imports": ["error", {
        prefer: "type-imports",
        fixStyle: "separate-type-imports",
      }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/no-non-null-assertion": "error",

      // ── General quality ───────────────────────────────────────────────
      // Disabled in favour of @typescript-eslint/no-unused-vars (which
      // understands TypeScript type-only parameter names and has the
      // correct argsIgnorePattern config).
      "no-unused-vars": "off",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
    },
  },

  // ─── Boundary rules: modules/* ────────────────────────────────────────────
  {
    files: ["modules/**/*.ts", "modules/**/*.tsx"],
    plugins: { import: importPlugin },
    rules: {
      // modules cannot import from other modules
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["@modules/*"],
            message:
              "Modules cannot import from other modules. Use the event bus or entity engine relations API instead.",
          },
        ],
      }],
    },
  },

  // ─── Boundary rules: packages/* ──────────────────────────────────────────
  {
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    plugins: { import: importPlugin },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["@platform/app-*", "../../apps/*", "../../../apps/*"],
            message: "Packages cannot import from apps.",
          },
          {
            group: ["@modules/*"],
            message: "Packages cannot import from modules.",
          },
        ],
      }],
    },
  },

  // ─── Boundary rules: packages/entity-engine ──────────────────────────────
  {
    files: ["packages/entity-engine/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["@platform/workflow-engine", "@platform/automation-engine"],
            message:
              "entity-engine cannot import from workflow-engine or automation-engine (dependency flows downward only).",
          },
        ],
      }],
    },
  },

  // ─── Boundary rules: packages/workflow-engine ────────────────────────────
  {
    files: ["packages/workflow-engine/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["@platform/automation-engine"],
            message:
              "workflow-engine cannot import from automation-engine (dependency flows downward only).",
          },
        ],
      }],
    },
  },

  // ─── Security: no direct process.env ─────────────────────────────────────
  {
    files: ["apps/**/*.ts", "packages/**/*.ts", "modules/**/*.ts"],
    ignores: [
      "packages/config/**/*.ts",
      // logger is foundational infra like config — it cannot import
      // @platform/config without forcing every consumer (tests, scripts,
      // minimal contexts) through the full app env schema (S3/Zitadel/Novu/
      // Anthropic/OpenBao, ~20 required vars) just to construct a logger.
      "packages/logger/**/*.ts",
      "**/*.test.ts",
      "**/*.spec.ts",
      // build/test tooling configs, not application code
      "**/vite.config.ts",
      "**/vitest.config.ts",
      "**/drizzle.config.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Do not read process.env directly. Import from @platform/config instead.",
        },
      ],
    },
  },

  // ─── Scripts: relaxed rules, no tsconfig project ─────────────────────────
  // Dev scripts in scripts/ are not part of any workspace package and do not
  // have a tsconfig that eslint can resolve via project:true.  Use the same
  // relaxed config as test files to avoid "file not in project" parse errors.
  {
    files: ["scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: false,
      },
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/prefer-optional-chain": "off",
      "no-restricted-syntax": "off",
      // Developer scripts legitimately use console.log for user-facing output
      "no-console": "off",
      // no-undef is too aggressive without a tsconfig project — TS covers this
      "no-undef": "off",
    },
  },

  // ─── Tests: relaxed rules + disable type-checked rules ───────────────────
  // Test files are excluded from the per-package tsconfigs (they're compiled by
  // vitest, not tsc). Disabling type-checked rules avoids "file not in project"
  // errors while still linting test code for obvious mistakes.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "tests/**/*.ts", "**/vitest.config.ts", "**/vite.config.ts", "**/drizzle.config.ts"],
    languageOptions: {
      parserOptions: {
        project: false,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/prefer-optional-chain": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-restricted-imports": "off",
    },
  },
];
