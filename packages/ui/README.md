# @platform/ui

Reusable UI primitive components built with Radix UI, TailwindCSS, and React.

## Module Side-Effects Audit

This package is configured with `"sideEffects": false` in `package.json` to enable fine-grained tree-shaking across consumer application bundles.

### Audit Summary

- **Styles**: Pure Tailwind CSS class composition via `clsx` and `tailwind-merge` (`cn`). No module-scoped `.css` imports or CSS variable injection at import time.
- **Polyfills & Prototypes**: Zero global polyfills, prototype augmentations, or `globalThis` / `window` bindings at module scope.
- **Components**: Functional React components with Radix UI primitives (`@radix-ui/react-dialog`, `@radix-ui/react-alert-dialog`, `@radix-ui/react-slot`). All runtime side-effects are scoped inside standard React component lifecycles.
- **Exports Audited**:
  - `alert-dialog.tsx` (clean)
  - `button.tsx` (clean)
  - `dialog.tsx` (clean)
  - `icon-button.tsx` (clean)
  - `table.tsx` (clean)
  - `tokens.ts` (clean)
  - `use-hover-style.ts` (clean)
  - `utils.ts` (clean)
  - `index.ts` (clean)
