# 2026-10-22 — The org directory sync could never read manager or department data

**Session type:** fix (docs/specs/org-directory.md, metadata read)
**Branch:** `fix/org-metadata-list-endpoint` (off `upstream/main`)

- **Symptom.** On a tenant whose users had `manager_id`, `department` and `title` set in
  Zitadel, the org chart still put every user directly under the root card.
- **Cause.** `getOrgMetadataForUser` called `zitadel.user.v2.UserService/ListMetadata`. That
  method does not exist on the Zitadel v2 API and answers 404, so every lookup took the
  "list metadata failed" path and returned empty metadata. The real method is
  `ListUserMetadata`; its response has the same `metadata: [{ key, value }]` shape, so nothing
  else changes.
- **Fix.** One-word change to the request path (and the comment that names it).
- **Test.** `getOrgMetadataForUser request` stands in for Zitadel by request path and asserts
  that the call goes to `UserService/ListUserMetadata` (never `ListMetadata`) and that the
  base64 values decode to manager, department and title. It fails against the old path.
- **Verified live.** Against a real Zitadel org: `ListMetadata` answered `404 page not found`;
  `ListUserMetadata` answered 200 with the user's metadata.
