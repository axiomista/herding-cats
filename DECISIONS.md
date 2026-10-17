# Decisions

Deviations from `project-plan/herding-cats-spec.md`, made during the overnight offline build. Each entry says what was chosen and why.

## Simplification options taken (P1 to P9)

None. The full design is built.

## Additions marked (new)

| Addition | Where | Why |
| --- | --- | --- |
| `FAKE_BOX=1` dev mode | `src/config.ts`, `src/server.ts`, `src/fake-box.ts` | Runs the server on the seed docs, planted tasks and recorded fixtures with no Box calls. Required config falls back to placeholders; `DEMO_PASSCODE` is still required. `FAKE_BOX_LATENCY_MS` (default 300 in the server) slows fake AI calls so a scan is observable. |
| `FakeBox` | `src/fake-box.ts` | One fake implementing both `BoxGateway` and `TrackerAdapter`, logging every write. It lives in `src/` (not `test/`) because `FAKE_BOX=1` runs it from the server. |
| Work-breakdown contracts | `src/types.ts`, `src/box.ts` | `Finding.fingerprint`, `ExtractedItem`, `AuditEntry`, `AppState`, `BoxGateway`, as listed in the work breakdown. |
| Extra optional fields | `src/types.ts` | `Commitment.flags`, `dueAbsolute`, `mentions`, `statusEvidence`; `Finding.proposal`, `rivalScore`; `AppState.files`, `errors`, `unverified`; `ExtractedItem.fileId`. Cards and checks need them; the spec's fields are unchanged. |
| `TrackerAdapter.hasComment(fileId, fingerprint)` | `src/types.ts` | The spec says the app checks a file's comments for the fingerprint before posting; this is that check. |
| `BoxGateway.serviceUserId()`, `folderAncestors()` | `src/box.ts` | For ignoring the service account's own webhook events and for the audit-folder startup check. |
| `src/score.ts` | | Scoring shared by the replay test, `npm run eval` and `POST /api/score`. |
| `scripts/eval.ts`, `scripts/probe.ts` | | `npm run eval` (live, never run tonight) and the first-hour probes from the work breakdown. |
| `scripts/copy-web.mjs` | | Copies `index.html` and `style.css` into `dist/web/` during `npm run build`. |
| `web/mock-state.json` | | Work-breakdown contract: an `AppState` with a finding in every bucket, generated from a fake full scan. |

## Spec ambiguities and the choice made

1. **Matching runs once per cycle across the folder, not per file.** Step 7 matches "the file's commitments" against every task, but orphans and misfiled tasks can only be judged with every file's commitments in view (T7 sits on the brainstorm but belongs to the memo). Each cycle scans only the files it is given, keeps each file's extracted commitments in memory, then matches all known commitments against all folder tasks. Orphans are reported only for tasks on files scanned in this process, so a restart never turns every task into an orphan.
2. **Restatements across files merge.** Step 6 deduplicates within a file. The answer key counts C01 once although sync01 restates it, so the same rule (same owner, similarity of 80 or more) also merges across files, keeping the earliest document's commitment and recording the others as `mentions`. A task on a file with a mention is not misfiled.
3. **Edit check (step 8) is the orphan rule.** Rescanning a file replaces its commitments in memory; a task on it whose commitment is gone is then unpaired, so it becomes a low-certainty orphan.
4. **Status changes.** A `status_change` with `cancelled` or `completed` updates the best commitment whose text scores 85 or more against `refers_to`. With no such commitment in memory, it becomes a commitment of its own (owner missing, so low certainty) that can still pair with the open task.
5. **Completed tasks.** A pair with a completed task is `matched`; conflicts on a closed task are not reported. Unpaired completed tasks are not orphans.
6. **Certainty of matched findings.** The bucket check passes for `matched` (nothing to write), so matched cards are high certainty and do not crowd the top of the page.
7. **Pairing check.** Applies only when a task is paired. "No other candidate within 10 points" passes when the best rival on either side of the pair scores at least 10 below the pair. Untracked findings have no pairing check; their best task scored below 60 by definition.
8. **Scan marker format.** `hcScannedVersion` is `<file_version id>@<prompt version>` (for example `2810308355440@v1`), so a new prompt version rescans every file without a separate field.
9. **Versions are Box `file_version` IDs**, which change on every upload. The audit entry's "version" is that ID.
10. **Dry run keeps scan markers in memory.** Metadata is written in apply mode only, as the spec says, but a dry-run sweep still skips files this process already scanned, so repeated sweeps cost no AI units. In apply mode, metadata is written for every file whose marker in Box is missing or stale, including files scanned earlier in dry run.
11. **Metadata write.** One write per file with all `hc*` fields, after every task, comment and audit write of the cycle. `hcOpenFindings` is a count; `hcLastChange` is the trigger of the cycle that wrote it.
12. **HELD entries** are logged once per finding fingerprint per process, so each sweep does not repeat them.
13. **Audit trigger labels**: `webhook`, `sweep`, `full-scan`, `click`. Times are Pacific (`PT`).
14. **Audit fields not in the sample.** The `finding` line follows the sample (`bucket: action, due date`); the owner appears in the `change` line. Orphan evidence is written as `none (task <id> on file <id>)`.
15. **Comment wording** starts with "Herding Cats:" and ends with `fingerprint: <fingerprint>`.
16. **Dates.** Only explicit dates resolve ("October 23", "Oct 23, 2026", ISO). A month and day before the document date roll to the next year. Relative dates ("next Friday") are flagged and never guessed.
17. **Owners.** "I", "me" or "myself" in an email thread resolve to the sender of the message containing the evidence. External people (`external: true`) and people with no Box user are flagged.
18. **Unsupported types.** Supported extensions: txt, md, pdf, doc, docx, rtf, odt, html, htm, ppt, pptx, xls, xlsx.
19. **Express 5** is what `npm install express` resolves to today; the spec names no version.
