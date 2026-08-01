# a11y wave 2 — migrate remaining single-instance modals to Dialog/AlertDialog (#284)

> Wave 1 (#198, PR #285) consolidated the 2 duplicated modal patterns into shared
> `ConfirmDeleteDialog`/`TransitionModal` components. This wave converts the remaining
> ~27 single-instance modals (no shared component to extract — each stays in its own file)
> onto `@platform/ui`'s `Dialog`/`AlertDialog` primitives, in place, using the same
> style-reset technique `TransitionModal` already established.

status: draft
created: 2026-08-02
updated: 2026-08-02

---

## §G Goal

Every remaining hand-rolled `<div className="modal-overlay">`/`<div className="modal">` pair
(conditionally rendered via `{show && (...)}`, backdrop-click-to-close, no `role="dialog"`) is
replaced with Radix-based `Dialog`/`AlertDialog` + `DialogContent`/`AlertDialogContent`, wired to
`open`/`onOpenChange` instead of a raw conditional render. Existing `.modal`/`.modal-header`/
`.modal-title`/`.modal-close`/`.modal-body`/`.modal-footer` CSS classes keep applying unchanged
(via resetting `DialogContent`'s default inline styles to `undefined`, exactly as
`transition-modal.tsx` already does for `.tm-modal`). Form logic, validation, and button behavior
are untouched — only the outer wrapper/backdrop/close-button/accessibility plumbing changes.

---

## §C Constraints

| constraint            | value                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack                 | React 18, `@platform/ui`'s existing `Dialog`/`AlertDialog` (no new primitives needed)                                                                                                                                                                                                                                                                                                                                                               |
| conversion pattern    | Match `apps/admin-ui/src/components/transition-modal.tsx`: `<DialogContent className="modal" style={{background: undefined, border: undefined, borderRadius: undefined, boxShadow: undefined, maxWidth: undefined, maxHeight: undefined, overflowY: undefined, padding: 0}}>`, `DialogTitle asChild` wrapping the existing `<h3 className="modal-title">`, `DialogClose asChild` wrapping the existing `<button className="modal-close">×</button>` |
| Dialog vs AlertDialog | `AlertDialog` for destructive/discard confirms (nav-away "unsaved changes" guard, archive confirmation); `Dialog` for everything else (forms, informational modals) — matches `ConfirmDeleteDialog`'s existing AlertDialog precedent                                                                                                                                                                                                                |
| out of scope          | `TransitionPanel` in `workflow-canvas.tsx` (a `position:absolute` slide-in side panel, no backdrop — not a true modal; converting to `Dialog` loses the in-context slide-in feel) and the access-denied overlay in `record-detail.tsx` (likely a full-page state, not a dialog) — both explicitly flagged in the issue as needing a separate manual judgment call, not this pass                                                                    |
| out of scope          | `apps/portal` (removed, stub only); wave 1's already-shared `ConfirmDeleteDialog`/`TransitionModal` (done)                                                                                                                                                                                                                                                                                                                                          |

---

## §I Interfaces

No new exports — reuses `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`,
`DialogFooter`, `DialogClose`, `AlertDialog`, `AlertDialogContent`, `AlertDialogTitle`,
`AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogAction`, `AlertDialogCancel` — all
already in `@platform/ui`.

**Full modal inventory** (24 to migrate, 2 explicitly deferred):

| File                                     | Modal                                   | Type        |
| ---------------------------------------- | --------------------------------------- | ----------- |
| `pages/workflows/detail.tsx`             | Add Field                               | Dialog      |
| `pages/workflows/detail.tsx`             | Add State                               | Dialog      |
| `pages/workflows/detail.tsx`             | Add Transition                          | Dialog      |
| `pages/workflows/detail.tsx`             | Edit Field                              | Dialog      |
| `pages/workflows/detail.tsx`             | Edit State                              | Dialog      |
| `pages/workflows/detail.tsx`             | Edit Transition                         | Dialog      |
| `pages/workflows/detail.tsx`             | Nav-away guard (unsaved canvas changes) | AlertDialog |
| `pages/customer/record-detail.tsx`       | Access-change modal                     | Dialog      |
| `pages/customer/record-detail.tsx`       | Mention-grant confirmation modal        | Dialog      |
| `pages/customer/record-detail.tsx`       | Archive confirmation modal              | AlertDialog |
| `pages/customer/record-detail.tsx`       | Create sub-task modal                   | Dialog      |
| `pages/customer/record-detail.tsx`       | Transition modal (record-detail's own)  | Dialog      |
| `pages/customer/record-detail.tsx`       | Confirm access-request modal            | Dialog      |
| `pages/customer/record-detail.tsx`       | Resolve access-request modal            | Dialog      |
| `pages/customer/record-detail.tsx`       | Ticket alerts modal (display-only)      | Dialog      |
| `components/workflow-canvas.tsx`         | AddStateDialog                          | Dialog      |
| `components/workflow-canvas.tsx`         | EditStateDialog                         | Dialog      |
| `pages/modules.tsx`                      | Preview modal                           | Dialog      |
| `pages/modules.tsx`                      | Fork / "Copy Template" modal            | Dialog      |
| `pages/entity-types/index.tsx`           | New Entity Type modal                   | Dialog      |
| `pages/entity-types/detail.tsx`          | Add Field modal                         | Dialog      |
| `pages/entity-types/detail.tsx`          | Edit Field modal                        | Dialog      |
| `pages/entity-types/instance-detail.tsx` | Change State modal                      | Dialog      |
| `pages/customer/record-list.tsx`         | Save View modal                         | Dialog      |

**Deferred (not this pass):** `workflow-canvas.tsx`'s `TransitionPanel` (slide-in side panel);
`record-detail.tsx`'s access-denied overlay (likely a full-page state).

---

## §R Requirements

**R1: Every migrated modal opens/closes via `open`/`onOpenChange`, not a raw conditional render + backdrop `onClick`**
✓ Each modal's existing boolean state (`showAddField`, `editingField`, etc.) drives `Dialog`'s/
`AlertDialog`'s `open` prop directly (`open={showAddField}` or `open={editingField !== null}`)
✓ `onOpenChange={(next) => { if (!next) <existing close handler>(); }}` replaces the old
`onClick={() => setShowX(false)}` on the overlay div
✓ Escape-key-to-close and backdrop-click-to-close work via Radix's built-in behavior (no manual
wiring needed — this is a behavior _gain_, not present before for any of these except implicitly
via the removed backdrop onClick)

**R2: Existing visual design is pixel-identical**
✓ `.modal`/`.modal-header`/`.modal-title`/`.modal-close`/`.modal-body`/`.modal-footer` classes
still apply, unchanged, via the same style-reset technique as `transition-modal.tsx`
✓ No new CSS added or removed in this pass (CSS already exists and already applies via
classNames — nothing in `index.css` needs touching)

**R3: Each modal gets `role="dialog"`/`aria-modal="true"` and an accessible title**
✓ `DialogContent`/`AlertDialogContent` supply `role="dialog"`/`aria-modal` automatically (already
proven in `packages/ui/src/dialog.test.tsx`)
✓ Every modal's existing `<h3 className="modal-title">` becomes `<DialogTitle asChild>` (or
`AlertDialogTitle asChild`) wrapping that same `<h3>` — no visual change, real
`aria-labelledby` wiring gained

**R4: Form logic, validation, submit handlers, and all other JSX inside each modal body are untouched**
✓ Only the modal's outer wrapper (overlay div → `Dialog`/`AlertDialog`, `.modal` div →
`DialogContent`/`AlertDialogContent`, `.modal-close` button → wrapped in `DialogClose`/
`AlertDialogCancel asChild`) changes
✓ `<form onSubmit={...}>` and everything inside it stays exactly as-is

**R5: The two explicitly-deferred cases are left untouched**
✓ `TransitionPanel` and the access-denied overlay show zero diff

---

## §V Invariants

- The style-reset technique (set `DialogContent`/`AlertDialogContent`'s inline
  `background`/`border`/`borderRadius`/`boxShadow`/`maxWidth`/`maxHeight`/`overflowY` to
  `undefined`, `padding: 0`) is how this repo lets existing bespoke CSS classes keep working
  under the shared Radix primitives — established by `transition-modal.tsx` for `.tm-modal`,
  reused here for the generic `.modal` class. Do not introduce a second styling mechanism.
- `AlertDialog` is reserved for destructive/discard confirmations (matches `ConfirmDeleteDialog`'s
  existing precedent); everything else uses plain `Dialog`, even if it asks for a confirmation of
  a non-destructive action (e.g. "Grant & post", "Resolve request").

## §T Tasks

| id  | task                                                                                                                    | phase | status | depends |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Migrate `pages/workflows/detail.tsx` (7 modals)                                                                         | 1     | todo   | —       |
| T2  | Migrate `pages/customer/record-detail.tsx` (8 modals, 1 deferred)                                                       | 1     | todo   | —       |
| T3  | Migrate `components/workflow-canvas.tsx` (2 modals, 1 deferred) + `pages/modules.tsx` (2 modals)                        | 1     | todo   | —       |
| T4  | Migrate `pages/entity-types/{index,detail,instance-detail}.tsx` (4 modals) + `pages/customer/record-list.tsx` (1 modal) | 1     | todo   | —       |
| T5  | Full exit condition + manual diff review of all migrated files                                                          | 2     | todo   | T1-T4   |

phase gate: typecheck + lint + test pass; manual diff review confirms every migrated modal follows
the same conversion pattern and neither deferred case was touched

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
