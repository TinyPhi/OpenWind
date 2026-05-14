import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import noRestrictedImports from "eslint-plugin-no-relative-import-paths";
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
    ignores: ["packages/config/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
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

  // ─── Tests: relaxed rules + disable type-checked rules ───────────────────
  // Test files are excluded from the per-package tsconfigs (they're compiled by
  // vitest, not tsc). Disabling type-checked rules avoids "file not in project"
  // errors while still linting test code for obvious mistakes.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "tests/**/*.ts"],
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
