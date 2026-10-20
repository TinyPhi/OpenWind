# Entity create remark warning (#1022)

## Decision

`POST /entities` mirrors the existing child-create contract when the
best-effort first remark cannot be posted: the request still returns `201` with
the created entity and adds `warnings: ["remark_comment_failed"]`. The
`warnings` key is omitted when the comment succeeds or no workflow comment is
attempted.

The create page treats this as a successful creation. It shows the existing
global alert before following the normal navigation path, so both the standard
record-detail flow and hosted `returnTo` flow preserve their current behavior.
The form is not left active after creation, which avoids accidental duplicate
submissions.

## Trade-off and residual exposure

The warning is advisory rather than a retry mechanism. The entity retains its
`remark` field, but an operator must add the missing first comment manually.
This keeps the already-committed create operation non-fatal and matches the
child endpoint instead of introducing a second response contract.

## Stateful behavior

The route creates durable entity and comment records, so the affected outcomes
are recorded explicitly.

| State         | Event                                        | Outcome                                                                                                           | Kind                      | Evidence                                                   |
| ------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| entity absent | create without a workflow                    | entity created; no comment attempted; `warnings` omitted                                                          | unchanged                 | `returns 201 with the created instance on success`         |
| entity absent | create with workflow; first comment succeeds | entity and first comment created; `warnings` omitted                                                              | changed contract coverage | `omits warnings when the first comment posts successfully` |
| entity absent | create with workflow; first comment fails    | entity remains created; no first comment; response is `201` with `remark_comment_failed`; UI alerts and navigates | introduced                | API and create-page warning regression tests               |

Each request creates a distinct entity; replay and interleaving semantics are
unchanged. The first-comment attempt remains after the entity transaction has
committed and is never retried by this request.

## Verification

- Focused API tests for warning presence and omission.
- Focused admin UI tests for the alert and unchanged navigation.
- Repository typecheck and lint gates.
