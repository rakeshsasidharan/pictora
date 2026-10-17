# Progress

## #23 Private gallery with detail view, download, rerun and delete

**Status:** blocked, not started. Flagged `needs-human` by the daily build routine on 2026-10-17.

**Done:** nothing on this branch beyond this note.

**Left:** the whole scope of #23 (images API, detail, download redirect, delete, gallery UI, running placeholders, rerun, Edit and Report actions, and the `gallery` and `delete` Playwright specs).

**Why:** two parts of the scope build on code that isn't on `main` yet, and the issue's "Depends on" lists only #17:

- **Rerun** opens the generate screen pre-filled with the same settings and seed. The generate screen is #18, in PR #83, not merged yet.
- **Report** calls #19. The `ReportImage` component and `POST /api/reports` are in PR #84, not merged yet.

Every issue branch starts from `main`, so neither can be built or tested here without copying unmerged code into a second branch.

**Needed:** merge PR #83 and PR #84, then remove `needs-human` from #23 so the next routine run builds the full scope from `main`. Adding #18 and #19 to the issue's "Depends on" line would make the routine wait for them automatically.
