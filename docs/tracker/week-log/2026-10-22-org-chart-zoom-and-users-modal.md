# 2026-10-22 — Org chart: zoom and pan, and a "View org chart" button on the Users page

**Session type:** feature (docs/specs/org-directory.md R7-R9, admin-ui)
**Branch:** `feat/org-chart-zoom-and-users-modal` (off `upstream/main`)

- **Why.** The org chart scrolled sideways only, so a tree with several managers and their teams
  was awkward to read, and it could only be reached from its own page.
- **Chart.** Rendered with React Flow and dagre (both already used by the workflow builder, so
  no new dependency): wheel and pinch zoom (10%-200%), drag to pan, +/- and fit-view buttons,
  and a minimap. Cards keep their look; the +/- under a card still expands and collapses its
  reports without moving the camera. A search match is highlighted, auto-expanded (as before)
  and now also panned and zoomed into view.
- **Users page.** A "View org chart" button opens the same chart in a modal
  (`OrgChartPanel`, shared with `/org-directory`).
- **Not in this PR.** The tree-key fix that makes levels below the first draw at all is a
  separate PR; without it the chart shows the root and its direct reports only.
- **Tests.** Zoom controls render; the toggle open/close of the modal; the existing search,
  highlight and admin-only Sync tests still pass. The chart tests wait up to 5 seconds because
  React Flow loads on first render and the default 1 second is too tight in a full run.
