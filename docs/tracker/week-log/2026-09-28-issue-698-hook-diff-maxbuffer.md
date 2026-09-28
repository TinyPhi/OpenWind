# 2026-09-28 — Guardrail hooks misread >1 MiB diffs as empty (#698)

**Session type:** Bug fix (agent guardrails)
**Issue:** #698
**Branch:** `fix/PLAT-698-hook-diff-maxbuffer`

While updating #680 from main after #681's squash-merge, every gate helper reported "nothing to
review / document / stage", even though the merge staged 224 files. `lib/context.js`'s `sh()` and
`shBuf()` called `execSync` without `maxBuffer`, so Node's 1 MiB default applied. #680's
`git diff HEAD` was 1.6 MB. `execSync` threw `ENOBUFS`, and the catch blocks returned an empty
string/buffer, which the gates read as an empty diff. The only way through was a logged
`SHIP_BYPASS=1`, used for #680 (and for #687, whose merge commit genuinely changed no files).

- **Fix:** a shared `MAX_BUFFER` (256 MiB) in `lib/context.js`, used by `sh()` and `shBuf()`,
  and by `write-docs-marker.sh`'s own inline `sh()`.
- **Tests:** two cases in `scripts/test-claude-hooks.sh` pipe 2 MiB through `shBuf` and `sh`
  and assert the full length comes back. Both return 0 without the fix.
- **Not changed:** the catch-and-return-empty behaviour itself. An ENOBUFS-sized diff now
  succeeds. A _failing_ git command still reads as empty, which is how the hooks already treated
  "no repo / no diff".
