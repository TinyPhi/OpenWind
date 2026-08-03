# file/files field-type widgets for FieldInput (#289)

> PR #288 consolidated `FieldInput` but deferred `file`/`files` field types (they currently fall
> through to the `default` case — an editable plain-text input, which is actively wrong, not just
> a placeholder). This adds real upload widgets reusing the existing upload flow.

status: draft
created: 2026-08-02
updated: 2026-08-02

---

## §G Goal

`field-input.tsx`'s `file`/`files` cases render a real upload widget instead of falling through to
a plain-text input. Both reuse the existing `useFileUpload` hook and `file-attachment.tsx`
components (`AttachmentUploadZone`, `StagedFileChip`, `FileChip`) rather than reimplementing
upload/scan-status/preview logic.

---

## §C Constraints

| constraint        | value                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack             | React 18, existing `useFileUpload` hook (`apps/admin-ui/src/hooks/use-file-upload.ts`), existing `file-attachment.tsx` components — no new upload/scan logic                                                                                                                                                                                                                                   |
| hooks rule        | `useFileUpload` calls `useState`/`useEffect` — it MUST be called unconditionally at a component's own top level, never inside `FieldInput`'s switch statement directly. Solution: a new dedicated sub-component (same pattern as `UserRefPicker`/`EntityRefPicker`), mounted only when the `file`/`files` case renders — the hook lives inside that sub-component, not in `FieldInput` itself. |
| new required prop | `FieldInputProps` gains `moduleSlug: string` (the upload API's required namespacing param) — threaded from all 4 call sites, each of which already has (or can derive) it                                                                                                                                                                                                                      |
| new optional prop | `FieldInputProps` gains `entityId?: string` — undefined during create flows (matches `useFileUpload`'s existing optional `entityId`)                                                                                                                                                                                                                                                           |
| value shape       | `file` → `string \| null` (a single fileId); `files` → `string[]` (array of fileIds) — consistent with how `user_ref`/`entity_ref` already store bare IDs, not embedded objects                                                                                                                                                                                                                |
| out of scope      | New API endpoints (reuses existing `POST /files`, `GET /entities/:id/attachments`); building a per-file metadata endpoint; changing `AttachmentUploadZone`/`StagedFileChip`/`FileChip`/`useFileUpload`                                                                                                                                                                                         |

---

## §I Interfaces

**New file:** `apps/admin-ui/src/components/file-field-picker.tsx`

```ts
export interface FileFieldPickerProps {
  value: string | string[] | null;
  onChange: (v: string | string[] | null) => void;
  multiple: boolean; // true for "files", false for "file"
  moduleSlug: string;
  entityId?: string;
}
export function FileFieldPicker(
  props: FileFieldPickerProps,
): React.ReactElement;
```

Internally: calls `useFileUpload({ entityId, moduleSlug })` for new-upload staging (renders
`AttachmentUploadZone` + `StagedFileChip` for anything mid-upload/scan). For displaying the
_already-set_ value(s) when editing an existing record (`entityId` present and `value` non-empty):
self-fetches `GET /entities/{entityId}/attachments` (the same generic, entity-engine-level
endpoint `record-detail.tsx` already uses for its own attachments section — confirmed it works
for any entity type, not just tickets) and filters to the id(s) in `value`, rendering each via the
existing `FileChip` component. "Remove" on a `FileChip` here means "clear this field's reference"
(update `value` via `onChange`) — it does **not** call the entity-level delete-attachment endpoint,
since the underlying file may still be a legitimate part of the entity's general attachment list.

**`field-input.tsx` changes:**

- `FieldInputProps` gains `moduleSlug: string` and `entityId?: string`.
- New `case "file":` → `<FileFieldPicker value={...} onChange={...} multiple={false} moduleSlug={moduleSlug} entityId={entityId} />`
- New `case "files":` → same with `multiple={true}`.

**4 call sites gain `moduleSlug`/`entityId` props on their existing `<FieldInput>` usages:**

| File                               | `moduleSlug` source                                                                                                                                                                                       | `entityId` source             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `customer/record-detail.tsx`       | already computes `moduleSlug` locally for its own `useFileUpload` call — reuse it                                                                                                                         | `id` (route param)            |
| `customer/record-create.tsx`       | already computes `typeSlug ?? "unknown"` for its own `useFileUpload` call — reuse it                                                                                                                      | `undefined` (not created yet) |
| `entity-types/instance-detail.tsx` | new: `useEntityTypes()`'s `modules`/`getTypeById(entityTypeId)`, `modules.find(m => m.id === type?.moduleId)?.slug ?? "platform"` (fallback for module-less core entity types — `moduleId` can be `null`) | `instanceId` (route param)    |
| `entity-types/instance-create.tsx` | same derivation as instance-detail.tsx (already imports `useEntityTypes`)                                                                                                                                 | `undefined` (not created yet) |

---

## §R Requirements

**R1: `file`/`files` fields no longer render as an editable plain-text input**
✓ `grep` for `case "file"` / `case "files"` in `field-input.tsx` finds explicit handling, not a
fallthrough to `default`

**R2: New uploads work end-to-end through the field**
✓ Selecting a file via `AttachmentUploadZone` stages it (`StagedFileChip` shows progress/scan
status), and once scan completes clean, `onChange` fires with the new fileId (single) or
appended array (multi)

**R3: An existing value (editing a record where the field was already set) displays real metadata**
✓ When `entityId` is set and `value` is non-empty, the widget fetches and shows the file's real
name/size/type via the existing `FileChip`, not a bare ID
✓ "Remove" clears the field's value without deleting the underlying file record

**R4: Works in create flows where `entityId` is undefined**
✓ `FileFieldPicker` renders correctly with `entityId={undefined}` (upload-only, no
existing-value fetch attempted — matches `record-create.tsx`'s existing pattern for its own
attachments section)

**R5: `moduleSlug` reaches `FieldInput` at all 4 call sites**
✓ Each of the 4 files passes a real, non-empty `moduleSlug` string (verified per the table above)

---

## §V Invariants

- `useFileUpload` (and any other stateful hook) is never called conditionally inside
  `FieldInput`'s switch statement — it only ever lives inside a dedicated sub-component mounted
  by a specific `case`, matching the existing `UserRefPicker`/`EntityRefPicker` pattern.
- Field-level file "removal" only clears the field's own reference; it never deletes the
  underlying file or affects the entity's general attachments list.

## §T Tasks

| id  | task                                                                                        | phase | status | depends |
| --- | ------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Add `file-field-picker.tsx` (+ test)                                                        | 1     | todo   | —       |
| T2  | Wire `case "file"`/`case "files"` into `field-input.tsx`, add `moduleSlug`/`entityId` props | 1     | todo   | T1      |
| T3  | Thread `moduleSlug`/`entityId` through all 4 call sites                                     | 2     | todo   | T2      |
| T4  | Full exit condition + manual diff review                                                    | 3     | todo   | T3      |

phase gate: typecheck + lint + test pass before advancing

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
