# Changelog

All notable changes to AgentTS and DurableTS. This file lists major
non-breaking changes and all breaking changes, with migration guidance
for old workflows. Minor tweaks and internal bug fixes are not listed.
Future releases append r2, r3, … sections incrementally as notable
changes land. The bar for notable: would an end-user developer of
AgentTS need or want to know about this change?

## Versioning

There are no version numbers: no semver, no version field, no versioned
release. A workflow's version is its content hash
([BRA-52](https://linear.app/brandf/issue/BRA-52/workflow-library) Q4:
the hash is the version), and a run pins the exact source it was
submitted with in the frozen closure plus the engine version
(`dquickts-<pin>+durablets-<hash>`). Releases below are named r0
(the MVP) and r1. The CLI reports `agentts-host 0.1.0` (v0) — that is the
host's own version string, not a release version.

## r2

Work landed since r1 (2026-11-19), shipping in the r2 release.

### Added

**Snapshot convert command (`agentts snapshot convert`, [BRA-134](https://linear.app/brandf/issue/BRA-134/production-snapshot-converter)).** A suspended run's snapshot is bound to the engine build that wrote it — an engine upgrade (a dquickts pin bump) strands every parked run, because the new engine cannot read the old snapshot format. This command converts the snapshot in place: `agentts snapshot convert --state-dir DIR --run-id ID --dquickts TREE --new-sig-snap SNAP [--durablets-c PATH]` validates the checkpoint up front (it must exist and be a base — a delta, or a completed run with no manifest, is refused), recompiles the snapshot's bytecode cells from their recorded sources with the new engine's compile helper, re-links the new code into the old snapshot (atoms, constant pool, suspended frame pcs), and rewrites the state dir under the new engine version + format identity (blob/slice/keyframe, manifest keyframeHash/baseSize, registry + queue entry). The new engine version and format identity are computed from the target tree's pin + durablets.c, never taken on faith; the opcode table is parsed from the target tree's quickjs-opcode.h at runtime. The byte converter is a TypeScript port of the BRA-115 strip-and-recompile prototype (which proved the algorithm end to end); the only engine-native operation is recompilation, isolated in the shipped compile helper (`packages/durablets/compile-helper.c`, built per target engine with one `cc` invocation). A snapshot already at the target version is reported as already-converted, not rewritten (a stale record is fixed, the snapshot bytes untouched). All 7 fault-matrix cases refuse loudly with exit 2, no output written and no state touched: eval/`new Function` pre-suspension, same-line identity ambiguity, source drift, delta checkpoint, unremappable pc, class-table mismatch, missing checkpoint. The e2e proves the converted run resumes under the new engine with the identical result (`{"verdict":"RIGHT","total":7}`), while the unconverted copy is refused by the BRA-132 format gate. (The test file is `tests/test-bra134.ts`, run.sh section + suite-inventory.json entry `bra134`.)

**Server auto-restart workflow (restartServer, [BRA-245](https://linear.app/brandf/issue/BRA-245/server-auto-restart)).** The machine stops — the production worker server goes down, the tick/heartbeat loop stops — and today the recovery is a person. This workflow makes it automatic: detect what is down, restart it, verify `/health` answers `ok:true`, report back. Detection: the health check fails (GET `/health` refused, or answers with `ok` not `true`) OR the tick is stale (last tick older than `staleMinutes`, default 15, with pending work — the watchdog's `needsRestart` shape: a dead tick with nothing pending needs no restart). Restart: the standing command (`bun src/cli.ts worker serve --state-dir <dir> --port <N>`, detached via nohup, log to `<runs-dir>/server-restart-N.log`), from the run input's server command / state dir / port, never hardcoded to production. Verify: a bounded poll of GET `/health` — 30 attempts one second apart (30s total); a restart that is not verified is reported as not-verified, never as up. One run makes at most one restart attempt per target; a down server that won't restart is reported as a failure, loudly — not looped silently. An already-up server is verified only, never restarted. The tick-stale case is governed by the same rule: when `/health` is OK but the tick is stale with pending work, the server is up, so no restart happens — restarting the server cannot revive the tick agent (the tick agent beats the server via POST `/tick-beat` and the server only records `tick/state.json`); the tick agent itself is restarted by its own watchdog cron, the report names that, and the Director + affected leads are notified. The trigger is a 15-minute cron invoking the CLI (installed by the lead, not by the workflow). The report returns delivery payloads for the launcher (the Director when a restart happened or failed or the tick is stale; one per affected lead when a restart happened or the tick is stale); a routine verified-up check emits no payload. Owner is required, never assumed from the launcher; cancel is check-then-act; dry-run plans and writes nothing. (The test file is `tests/test-bra245.ts`, run.sh section + suite-inventory.json entry `server-restart`.)

**VM-replacement recovery workflow (recoverVmReplacement, [BRA-246](https://linear.app/brandf/issue/BRA-246/vm-replacement-recovery)).** A VM replacement kills the production worker server mid-run: runs are stranded at "running" in the queue, journals stop mid-slice, the tick goes dead. This workflow makes the recovery automatic: detect the replacement, restart the server, name every interrupted run with its resume point, and tell the affected leads which of their runs resumed and which could not. Detection: a boot-id record at `<stateDir>/boot-id` — the kernel's boot id (`/proc/sys/kernel/random/boot_id`), written by this workflow on real runs; the first run with no record establishes it (not a replacement); a later run whose current boot id differs from the recorded one is a replacement; a corrupt recorded id refuses loudly. Restart: on a replacement the workflow restarts the server with 245's helpers and verifies `/health`; the boot-id record is updated on detection, before the restart, so a failed restart does not re-fire detection on the same boot. Resume: the workflow does NOT drive the queue itself and does NOT execute a full tier-1 inside an exec trap — it classifies each interrupted run (mirroring the engine's `classifyStrandedEntry` evidence: journal lifecycle, registry rc, snapshot blob) and names the resume dir + resume point; the launcher drives the resumes (suite runs via `run.sh --resume-dir` at the first unfinished tier-1 section, workflow runs via the queue drive from the blob). A run with no resume dir recorded is reported as could-not-resume and its lead notified, never silently dropped. The trigger is a systemd user unit delivered to `<stateDir>/vm-recovery.service` on real runs and enabled once by hand; the unit starts the server at boot, runs 246 via the CLI with the input file, then drives the queue. The report returns delivery payloads for the launcher (the Director when a replacement was detected or the trigger established; one per affected lead with their runs, resumed vs could-not-resume vs failed). Owner is required, never assumed from the launcher; cancel is check-then-act; dry-run writes nothing (not the boot-id record, not the unit file, and it does not start the server) but still computes the classification. (The test file is `tests/test-bra246.ts`, run.sh section + suite-inventory.json entry `vm-recovery`.)

**Push manifest + push workflow (pushToDev, [BRA-260](https://linear.app/brandf/issue/BRA-260/lbr-push-manifest-push-workflow)).** The land path's last step: merges land to the live tree, but the push to dev is still done by hand — twice so far (post-r1 push, skill-move push), by the same procedure, each time a person rebuilding the manifest, verifying files against origin, pushing, verifying via the GitHub API. This workflow makes it repeatable and machine-driven, under LBR's landing authorization — never under a per-push approval from Brandon. It rebuilds the push manifest from the dev baseline on every run (the queue entry's `copies` + `order` as the input, the file list from the merge report, the content from the live tree — one row per file with sha256, git blob sha, and status `to-push` / `already-on-dev`), verifies every file against origin before pushing (read from the live tree and hashed, copied into the checkout, re-read and re-hashed there — a mismatch refuses loudly, naming the file, and nothing is pushed), pushes the to-push files to origin's `dev` branch, and verifies what landed via the GitHub API (`gh api` first, `curl` with GH_TOKEN / GITHUB_TOKEN from the environment as fallback; the refs route when the remote is not github.com). A push the API can't confirm is reported as not-verified, never as landed. An interrupted push verifies what landed before retrying — if every file already matches dev, the workflow reports already-pushed (verified) instead of pushing twice. A held push (`run.holdPush`) reports the hold and stops. A blocked queue entry refuses with the failure named. The checkout is a git clone of brandf/agentts at `dev`, prepared by the launcher — the workflow never clones origin and never handles credentials. The queue file is never rewritten. Owner is required, never assumed from the launcher; cancel is check-then-act; dry-run plans and writes nothing. (The test file is `tests/test-bra260.ts`, run.sh section + suite-inventory.json entry `push`.)

**Dual-report verification workflow (dualReportVerdict, [BRA-256](https://linear.app/brandf/issue/BRA-256/qa-regression-verification-workflow-dual-report-verdicts)).** On Nov 20 a FAIL verdict sat unrouted ~5 hours because routing was a chat message. This workflow is the verdict route in the commit mechanism: it re-verifies a fixed item end to end — by driving the test-batching workflow in-run as a child run (one BatchChange per item, the item's tier-1 sections in a scratch tree containing the fix) — and dual-reports the verdict to the owning lead's chat AND to the Director in the same run, never only in QA's own chat. A FAIL names the failure + evidence in both payloads; an unable-to-verify item (the tree is absent, a suite is not a registered tier-1 section) is reported with the reason named, never dropped; an item with no owning lead goes to the Director, recorded. The workflow sends no messages — the report returns one delivery payload per recipient and the launcher delivers them. It never files a bug and never packages a handoff. Owner is required, never assumed from the launcher; cancel is check-then-act; dry-run plans and writes nothing. (The test file is `tests/test-bra256.ts`, run.sh section + suite-inventory.json entry `dual-report`.)

**Throughput report workflow (throughputReport, [BRA-247](https://linear.app/brandf/issue/BRA-247/throughput-reporting)).** The alarms' first half (CPU component 11 of 11): for one day, report the throughput numbers the Director's counting rule defines — a task counts when it is completed verified work (a done run naming the item in the window + a merge report with verdict "merged"), landings listed separately, nothing double-counted. Per queue item in the window: pickup-to-landed (the copy creation time — the copy's manifest `copiedAt`, falling back to the copy dir's mtime, earliest copy wins for a multi-copy item — to its landed time; the ledger's earliest startedAt is NOT the pickup, per the Director's Nov 22 ruling, because it drops the setup lag the standing latency keeps), verify time (the merge report's `suite.elapsedMs` — the tier-1 wall on the merged tree), close time (the land-to-close gap, recognized only as `closed <ISO timestamp>` in the queue notes, else unknown with the reason named), and build time (the sum of active wall over the item's done runs — wall minus gate-hold). Totals: items in window, tasks completed, landings, median pickup-to-landed, median verify time, done/failed run counts, the cost of a kill (failed runs' active wall and tokens; 0 when there are no failed runs, null when failed runs exist but none has a known wall time), skipped ledger lines, collected records, undated runs. Stalled steps are numbers, never silence: an item in status ready/blocked/paused unmoved for longer than `run.stalledAfterMs` (default 2h) is listed with its status named. The audit section carries one observation per workflow with done runs in the window — the audit's rule (median of the last 5 done runs, active wall) against the baselines file's threshold (baseline x 3.0), with the baseline status present/no-baseline. Machine-down is a verdict, not a guess: no new runs in the window AND the production server down (`run.serverUrl` `/health`) — a quiet window with the server up is a quiet window, named as one; no serverUrl means the check was skipped and logged. The workflow never restarts the server. Sources: the ledger tail (last 20 lines, byte-capped at 16KB, header `BTAIL <printed> <total>` so the report names tail incompleteness), the audit baselines file (missing is NO-BASELINE, corrupt is reported, never parsed past), the land queue file (48KB bound; missing is reported, invalid refuses the run; an entry whose only defect is an out-of-vocabulary status is skipped-with-reason and named, and a "pending_qa" entry is counted as pending and shown as awaiting QA), and the merge reports (caller-supplied, in time order; a report belongs to an item when its mergeId, normalized, contains the item's normalized issue key; last match wins; a missing or malformed report is missing-with-reason, never a refusal). The run→item join attributes build time and window membership (NOT pickup — pickup is the copy creation time): a run names an item when the runId's middle key equals the item's issue key after normalization (`run-bra210c-accept-real` names BRA-210c and NOT BRA-210 — one token, never a prefix). A missing source is reported with the reason named, never a refusal (except a corrupt queue or a structurally invalid queue entry, which refuses). Owner is required, never assumed from the launcher; cancel is check-then-act; dry-run plans and writes nothing. The daily brief optionally reads 247's report (`run.throughputReportPath`) and renders one Throughput card: present renders the section, absent renders without it, malformed records missing-with-reason and still renders; the read never blocks the brief. (The test file is `tests/test-bra247.ts`, run.sh section + suite-inventory.json entry `throughput-report`.)

**Bottleneck detection workflow (detectBottleneck, [BRA-248](https://linear.app/brandf/issue/BRA-248/bottleneck-detection)).** The alarms' second half (CPU component 11 of 11): watch the numbers 247 reports, identify the bottleneck, and file a P0 with numbers when a throughput stage of the machine is the bottleneck and the P0 bar is met. 248 reads the same sources 247 reads (the ledger tail, the audit baselines file, the land queue, the merge reports) PLUS 247's report — it re-derives the decomposition from the sources and cross-checks it against 247's report when one is supplied (a mismatch is logged, never fatal). Per item, pickup-to-landed decomposes into build (sum of active wall over the item's done runs), verify (the merge report's `suite.elapsedMs`), and queue-wait (the residual: pickup minus build minus verify, clamped at 0, the clamp logged). The bottleneck is the component with the largest MEDIAN share of pickup-to-landed across the decomposed items: a share of 0.5 or more names it; below 0.5 no single stage dominates ("none", reported, not filed); no complete decomposition means "unknown" (reported, not filed, the reason named). Machine-down overrides: no new runs in the window AND the production server down — the bottleneck IS the machine down, share 1.0, every item in the window blocked. Kinds: "machine-down", "merge" (merge bandwidth), "queue-wait" (the serial queue / LBR wait), "build" (build-stage slowness — the slowest workflow, by median active wall, is named in the filing), "none", "unknown". The P0 bar is Brandon's bar: ETA saving = bottleneck share x median pickup-to-landed x items blocked (wall-clock ms); expected saving = probability x ETA saving (expected value counts for speculative items); the P0 passes when expected saving beats the fix cost (`run.fixCostMs`, build + verification, one number; `run.fixProbability`, default 1). No fix cost supplied means the bar cannot be evaluated — reported, not filed, the reason named. A P0 without numbers is an opinion, not a filing. Filing: while the Linear free-plan limit holds, the goal's BACKLOG.md is the filing target — the entry carries its marker (`fleet-ops-p0: <bottleneck>/<date>`), title, priority P0, estimate in hours from the fix cost, code area, acceptance criteria, parent BRA-248, source + the numbers. 248 does not file a second P0 for the same bottleneck while the first is unanswered — "unanswered" means the filing is still present in BACKLOG.md with no `- **Resolved:**` line recorded under its entry (a human answers a P0 by adding that line under the entry; the filing itself says so). A filed P0 stops the pass until it is answered — 248 returns the filed/open P0 in its report; the workflow itself halts nothing — it reports the stop. 248 never fixes the bottleneck, never takes implementation work, never sits in the critical path of a build. Owner is required, never assumed from the launcher; cancel is check-then-act; dry-run plans and writes nothing. (The test file is `tests/test-bra248.ts`, run.sh section + suite-inventory.json entry `bottleneck-detect`.)

**Lead-loop skeleton (leadLoop).** The generic lead-loop skeleton every lead boots as its main entry point: one workflow (`workflows/library/lead-loop.ts`), configured per lead by a dispatch table in the run input (data, not code). Per iteration it checks cancel (check-then-act), progress-checks its submitted sub-runs pull-only, collects completed reports (bounded at 48KB), files first to BACKLOG.md in the same iteration, claims the next job for its owner from the launcher-supplied list, dispatches per the table via BRA-176 dispatch (whose switch is the single source of truth — the loop checks dispatch's resolution against the table and fails the job loudly on a mismatch, never invoking a workflow from the table directly), submits the routed run through the scheduler with `--adapter direct`, runs periodic work on cron, parks cheaply between jobs, and emits liveness to `<stateDir>/liveness/<loopId>.json` (also the loop's durable cross-shift state: a later run seeds its submitted-run map + collected-run set from it). Owner is required, never assumed from the launcher; a decide is surfaced, never answered; the loop never closes an issue, merges code, or decides acceptance. The loop runs until cancelled (`maxIterations` caps scratch/test runs). V0 claims from the launcher-supplied job list (the shared queue carries no claimable kind field — see the BACKLOG.md follow-up); the dead-owner drill's Director-side half is boot validation, not this build. (No Linear issue exists for this change while the workspace is at its free-plan issue limit; the test file is `tests/test-lead-loop.ts`, run.sh section + suite-inventory.json entry `lead-loop`.) **A dispatch fix rides with this build:** the loop is the first consumer that submits a routed run (BRA-176 tested routing only), and submitting flushed out a dispatch defect — every two-layer switch case built `runId + workDir` and omitted the target workflow's own required `<id>` field, so the CLI schema gate refused the routed input. This build fixes the two cases the loop exercises — dependency-mapping (`mappingId` added, `workDir` dropped) and worker-lifecycle (`lifecycleId` added) — plus the per-case project pick (`pickProject`: mapping's case picks the full project with `workDir` + `resumeDir`, every other two-layer case picks the base project without them) and the loop's `runId` injection (the task fields always carry `runId` = the submit run id, so the sub-workflow's cancel check looks its own queue entry up by it), with regression checks in `tests/test-bra176.ts` §C and the lead-loop test §C; the remaining cases (triage, breakdown, daily-feed, scheduler, merge, verify-fix, gc) carry the same defect class and are filed as a BACKLOG.md follow-up. **QA fix round (same build, before landing):** QA's verification found three blocking defects, all fixed here — (1) the liveness counters (`jobsCompleted`/`jobsPending`) and the report's `collected` list were per-run while `submitted` was cumulative, so after a cross-shift collection the file contradicted itself; the counters now come from the durable sets and `collected` seeds in as placeholders, so both lists and both counters are cumulative; (2) a job refused for no dispatch-table entry was never marked claimed, so it was re-claimed every iteration and starved later jobs — the refusal path now marks it claimed; (3) a cancelled sub-run was treated as still-running and stranded its job as pending with verdict 'completed' — cancellation is now terminal (job refused with the cancellation named, kind unblocks). Plus the Low: an untitled `fileFirst` item was skipped silently — it is now recorded with the reason named, in the job outcome and the report's notes. New §D cases D13 (cross-shift counters), D14 (continuation after refusal), D15 (cancelled sub-run); D8 extended (untitled fileFirst item + cumulative collected).

**Daily brief workflow (dailyBrief, [BRA-274](https://linear.app/brandf/issue/BRA-274/program-manager-daily-report-exec-brief-workflow)).** The daily report / exec brief workflow (CPU component 9 of 11): one workflow, three phases selected by `run.phase` — `prompt` (05:30), `aggregate` (06:30), `brief` (07:00), one phase per cron, the crons stay as triggers. The workflow sends no messages: the prompt phase returns one prompt payload per roster lead (target chat id from the roster; the message names the 06:00 deadline, the schema reminder, the reports-dir path, and the rule that a lead with nothing to say writes a short status and empty lists, never nothing) and the brief phase's report returns the delivery payload (dated HTML path + must-know line) for the launcher to send to main chat at 07:00. The aggregate derives decisions-needed (every `needs_pm`, roster order, attributed), must-know (Director-supplied `run.mustKnow`, then the program-manager report's optional `mustKnow`, then the first decision), risks (every `solutions[].problem`), per-lead sections (status + numbers with trend arrows vs the prior day), and the Director's own report (overall state from the goal notes, what changed from the ledger + status changes, what is next from the backlog + predictions) deterministically, and the brief renders the dated HTML exec brief from the aggregation with the Nov 21 template structure. A missing lead report is noted with the reason named and never blocks the brief; all lead-report fields except `lead` and `date` are optional (an absent optional field is empty, never invalid); a wrong shape on a present field is invalid and recorded missing-with-reason. The lead-report schema gains optional `mustKnow?: string`, used from the program-manager report only (a `mustKnow` on another lead's report is ignored and logged); the skill's daily-report schema section lists it as optional. Predictor-record scoring is out of this build — the aggregate reads the predictor record and logs it, but does not score predictions. Owner is required, never assumed from the launcher; cancel is check-then-act; dry-run writes nothing. (The test file is `tests/test-bra274.ts`, run.sh section + suite-inventory.json entry `daily-brief`.)

**Land queue workflow (landQueue, [BRA-261](https://linear.app/brandf/issue/BRA-261/land-queue-workflow)).** The landing queue (CPU component 10 of 11): one workflow, the queue file's single writer — it orders the landing queue from the queue file (ready first by `ready_at` ascending, then blocked, then paused, then landed as history; `order` reassigned 1..N, so the file on disk IS the ordered queue). A "ready" entry with a failed or missing verification transitions to "blocked" with the failure named in the notes; a blocked entry with a passing verification stays blocked until a caller sets status "ready" in an update — the workflow never promotes on its own, only demotes. Caller updates (`run.updates`) apply to matching entries by issue before ordering; an unknown issue refuses the run. `authorization` is the settled `MergeAuthorization` imported from merge.ts and validated when present. The workflow accepts both entry shapes the file carries (orders with `copies[]` + `parts[]`, and queue-managed orders with singular `copy`, no `parts`, flat `authorized_at`) and preserves every top-level key; it does not fabricate `parts` or convert `copy` to `copies`. Reads/writes go through exec traps in the dispatch pattern (base64 chunks + temp + rename + read-back); the queue-file read bound is 48KB (the live file is already 19,577 bytes) — a file over the bound is refused loudly, never truncated. Cancel is check-then-act; dry-run orders and writes nothing. (The test file is `tests/test-bra261.ts`, run.sh section + suite-inventory.json entry `land-queue`.)

**Land-queue rotation ("Unfiled: land-queue.json needs rotation before it hits the 48KB read bound (Low)").** The land-queue workflow now rotates landed entries as part of the run, so the queue file never needs a hand-operated rotation before it hits the 48KB read bound: when the file at read time is at or over 36KB (75% of the bound — the headroom covers one full merge cycle at the burst growth rate), the 5 most recent landed entries stay and all older landed entries move in full to a dated history file (`land-queue-rotated-<YYYYMMDDTHHMMSSZ>.json`, one file per rotation, named for the run's time), recorded in `updated`, a top-level `rotation` record (appended to a `rotations` array; an existing singular `rotation` seeds the array first), and the report's notes. The history file is written first, then the live file is re-read immediately before the live write — if the bytes differ, the whole run refuses loudly and writes nothing to the live file. A dry-run plans the rotation and names it in the notes, writing nothing. A file already over the bound still refuses before any rotation — the rotation does not rescue it.

**Rebase workflow (rebaseCopy, [BRA-262](https://linear.app/brandf/issue/BRA-262/rebase-workflow)).** Bring a copy onto the latest tree before merging — the step before the merge workflow, not a second merge path. The three-way diff comes from the merge workflow's own sparse-diff script; each copy-changed file is classified with `classifyMergeFile`; a conflict (both sides changed the file differently) refuses loudly before anything is written, the conflicting files named, the copy's manifest byte-identical. A clean rebase re-records the manifest against current live in-shell (live hashes, temp + rename, the `record-copy-manifest.sh` format) and verifies it by re-running the sparse diff (every entry must have base == live). A manifest already current reports rebased and writes nothing (idempotent re-run). A baselines change is not a rebase conflict; the merge refuses baselines at merge time. The rebase never writes live and never merges. Cancel is check-then-act; dry-run plans and writes nothing. (The test file is `tests/test-bra262.ts`, run.sh section + suite-inventory.json entry `rebase`.)

**Test-batching workflow (batchTests, [BRA-263](https://linear.app/brandf/issue/BRA-263/test-batching-workflow)).** Verify a stack of changes passes together without re-verifying each change from scratch. Each suite runs as the run.sh leaf (`run.sh --bash --only <slug>`), output to a per-suite log file, the verdict from the progress.jsonl section row; suites run sequentially, one at a time. Per-suite results are recorded incrementally (atomic write per suite to `<resumeDir>/batch-state.json`), so a resumed batch skips completed suites — a recorded failure is a completed suite, never re-run; retrying a failure is a new batchId. The report carries per-change results (change, suite, pass/fail, log path) plus the stack verdict: passed only when every suite of every change passed, failed naming the first failing change + suite. A failed change never rides a passing stack. The workflow does not edit the queue file; it returns per-change results for the caller (LBR) to apply. Cancel is check-then-act; dry-run plans and writes nothing. (The test file is `tests/test-bra263.ts`, run.sh section + suite-inventory.json entry `test-batching`.)

**Merge report carries the LBR authorization (merge.ts schema change).** The merge workflow's report now carries the LBR authorization in its schema: `MergeCopyInput` gains optional `authorization?: MergeAuthorization` (`authorizer`, `authorizedAt`, `channel`, `verificationSummary`, `expectedNewBaseline`, optional `note`), and `MergeReport` gains `authorization: MergeAuthorization | null`, carried verbatim from the input and null when absent — the field is present on every report, so a re-check reads it without guessing whether the workflow version knows about it. The record itself now proves the landing went through LBR first: the fallback and loop landings wrote the field post-hoc from the driver; the landing driver now passes the authorization as workflow input instead. A real merge without an authorization — or with a malformed one — refuses loudly before the diff step, before anything is written, with verdict `"failed"` and a note naming the missing or malformed authorization; a dry-run without one is fine, because LBR needs the dry-run plan to verify before authorizing. Validation is light: `authorizer` and `authorizedAt` must be non-empty strings, `channel` / `verificationSummary` / `expectedNewBaseline` must be strings (empty allowed), `note` when present must be a string; no date parsing — the field is a record, not a clock. No other merge behavior changes. (No Linear issue exists for this change while the workspace is at its free-plan issue limit; the record is the BACKLOG.md filing "merge record should carry the LBR authorization" at line 297. The test file is `tests/test-bra159.ts`, extended in place — no new test file, no new suite section, no run.sh or suite-inventory.json change.)

**Breakdown BACKLOG.md fallback.** When a Linear create is refused with the free-plan issue limit, the breakdown workflow now files the unfiled tasks to the goal's BACKLOG.md in the complete form (title, priority, estimate, code area, acceptance criteria, parent, source) and records the backlog md as the filing location in its report, instead of failing the acceptance on a platform limit. A non-limit refusal still fails loudly with nothing half-done. (Backlog-md fallback decision, Nov 21, 2026; filed in the goal's BACKLOG.md — no Linear issue exists for this change while the workspace is at its free-plan issue limit.)

**Workflow run ledger
([BRA-165](https://linear.app/brandf/issue/BRA-165/workflow-run-ledger-record-tokens-wall-clock-per-run-efficiency-measurement)).**
Every terminal run now leaves one record in
`<stateDir>/ledger/run-ledger.jsonl` with wall clock, trap/job
counts, and tokens as reported by workers — the per-run efficiency
numbers the dynamic scheduler and the audit build on. Tokens are
explicit unknown (`null`) when no trap reports any: the
complete-job payload carries no token counts and no adapter
reports them today, so the ledger never invents a number. The
scheduler can rank queued work by ledger cost
(`rankQueueByLedgerCost`); run ordering itself is unchanged.
Migration: none — the ledger is append-only and best-effort; a
ledger write failure never fails the run it measures.

**Workflow efficiency audit
([BRA-166](https://linear.app/brandf/issue/BRA-166/workflow-efficiency-audit-ratchet-per-workflow-baselines-tighten-only)).**
The bench's ratchet discipline now exists for workflows: `bun
src/workflow-audit.ts --state-dir <dir>` reads the run ledger and
checks each workflow's median active wall time and tokens per run
against its baseline, flags a confirmed regression with numbers, and
tightens baselines automatically on sustained improvement. Baselines
live with the ledger under `<stateDir>/ledger/` (wall time is
machine-dependent, so they are per state dir, not in the repo);
loosening needs a human decision with a recorded reason
(`workflow-audit.ts loosen <metric> <baseline> --reason "..."`).
Tokens stay explicit unknown until an adapter reports them — a
workflow with no token-reporting runs is reported UNKNOWN, never
scored as zero. Migration: none — the first audit seeds baselines
from the ledger's recorded runs.

**Merge workflow
([BRA-159](https://linear.app/brandf/issue/BRA-159/merge-workflow-encode-the-worker-per-copy-merge-as-a-workflow)).**
The worker-per-copy merge is now a workflow instead of a manual
procedure: given a worker copy and the claimed files, `mergeCopy`
(`workflows/library/merge.ts`) refuses loudly, writing nothing,
when a tier-1 is in flight, when the copy-time manifest
(`scripts/record-copy-manifest.sh`, recorded at copy time) is
missing, when the diff is not confined to the claimed files, when
any file conflicts three-way against the manifest base, or when
the baselines file differs; otherwise it applies the diff, verifies
the post-merge diff is empty except live-only files, typechecks,
and runs tier 1 with a fresh resume dir, reporting the counts
against the pre-merge baseline. Live-only files are preserved, the
baselines file is never merged from a copy, and host.ts conflicts
go to a human. A dry-run mode plans the merge without writing.
Migration: none — the manual merge procedure still works; the
workflow is the encoded form of it. The workflow applies the diff
but never decides acceptance: the PM reviews the merge report and
closes.

**Launch attribution + run visibility + run cancel
([BRA-211](https://linear.app/brandf/issue/BRA-211/launch-attribution-owner-and-progress-visibility)).**
A workflow run now records who launched it AND who owns it — two
fields, not one. `launchedBy` is provenance: the session that
submitted the run. `owner` is the session that executes and drives
it; only a job-looping session (a lead) can be an owner, and the
engine records the owner as given without validating lead-ness —
the launcher is responsible for naming a lead, and the Director
launches with owner set to the lead and never owns. `agentts run`
takes `--launched-by <session>` and `--owner <session>` (env
`$AGENTTS_LAUNCHED_BY` / `$AGENTTS_OWNER` as fallbacks; either
absent = legacy, nothing recorded), stored on the queue entry and
stamped on the run entry at start; run/call children and fork
branches inherit both from the parent. `agentts status <runId>`
shows both fields; `agentts runs [--owner <session>]
[--launched-by <session>] [--limit N] [--json]` lists runs
newest-first (default 50 rows, so the list stays under the ~60KB
exec-trap stdout cap even with hundreds of runs) — filtering by
owner is the primary query (the runs a lead drives), by launchedBy
the provenance query. Visibility is pull-only: no push path, no
long-poll progress watch. `agentts cancel <runId> [--reason R]
[--launched-by <session> | --owner <session>]` flips the queue
entry to `cancelled` and journals a `run-cancelled` event; the
driver never drives a cancelled run again. Cancel is
check-then-act: before advancing a run (each drive step), the
driver re-reads the run's cancelled flag from the live queue
(runQueue checks before the first slice, driveToCompletion checks
before each step); the run's state is the source of truth. A
cancel landing mid-drive wins over the drive's outcome, and a
cancelled run leaves no ledger entry. The owner OR the launcher
may cancel an attributed run; any other session is refused loudly,
naming both recorded sessions. A run with neither recorded takes
the legacy operator path. The CLI cancel also cancels the run's
queued/running worker server jobs best-effort; an unreachable
server is a warning, not a failure of the cancel. A
`run-cancelled` event makes `runStatusFromJournal` report
`cancelled`, sticky within its drive segment — a re-submitted
runId starts a fresh segment, so an old cancel does not stick to
the new run. Migration: none — existing runs have neither field
and behave exactly as before.
Scope line (BRA-211 comment 00830b48, BRA-160 comment 9801fe71):
this issue RECORDS the fields and resolves the pseudo-name; it
does NOT enforce routing — owner-routed dispatch (owner-preferred
job/exec, owner-only decide), owner failure/reassignment, and
dead-owner detection are the scheduler's job (BRA-160).
(`owner` dispatch resolution — a job targeting `owner` resolves to
the run's `owner` field, NOT `launchedBy`, and refuses loudly
when the run has no owner — is the second half of BRA-211 and
follows in the same issue, as tag + resolve only: no scheduler
filter, no worker-session presentation.)

**Breakdown workflow
([BRA-210](https://linear.app/brandf/issue/BRA-210/triage-breakdown-workflow-prioritize-backlog-sort-dependencies-break)).**
A feature issue now becomes filed, estimated tasks through a
workflow instead of a manual procedure: given a filed parent
issue and a split authored by the launcher (the PM lead, in
`run.plannedTasks` — the workflow files the split, it does not
invent estimates or code areas from prose), `breakdownIssue`
(`workflows/library/breakdown.ts`) validates the input purely,
reads the parent via the Linear CLI (a parent that is not filed
refuses as a wish), lists the parent's existing children for
idempotency, files each missing task in Linear with the parent's
full URL in the description and as a link attachment (never a
bare key), `parentId`, estimate, and priority, verifies every
filing by reading it back, rebuilds the parent's `## Breakdown`
section deterministically, and reports the filed task list with
Linear links. A dry-run plans without filing. A partial filing
is NOT rolled back — filed-so-far stays filed and a re-run picks
them up as already-filed. Owner is required in the run input
(launched by the Director with owner set to the PM lead; the
Director never owns); cancellation is check-then-act at the
driver level. Every Linear CLI output is bounded in-shell at
40KB, under the ~60KB exec-trap stdout cap. Migration: none —
the manual breakdown procedure still works; the workflow is
the encoded form of it. The workflow never closes an issue,
never merges, and never decides acceptance: the PM reviews the
report and closes.

**`owner` resolution at dispatch — tag + resolve only
([BRA-211](https://linear.app/brandf/issue/BRA-211/launch-attribution-owner-and-progress-visibility),
second half).** A job whose spec carries `target: "owner"` now
resolves at dispatch — in the Host's job-trap path, before the
adapter sees it — to the run's `owner` field (the session that
executes and drives the run, NOT `launchedBy`; there is no fallback
to `launchedBy`). The resolution is re-derived from the run on
every dispatch, journaled as `job-owner-resolved` (runId, trapId,
the resolved session), and rides the trap arg as `targetSession`,
so the enqueueing adapter stamps it on the Job record — the owner
tag on the shared queue, which BRA-160's enforcement reads. A run
with no `owner` recorded refuses an owner-targeted job loudly, and
any other target value is refused loudly (named targets belong to
BRA-50). An absent target means untargeted: today's behavior,
unchanged. `JobSpec` gains optional `target?: string` (the shape is
now `{ spec, input, target? }`); `Job` gains `target` (as requested)
and `targetSession` (resolved); `POST /enqueue` accepts both.
Dedup stays (trapId, spec). The direct adapter runs the job
in-process: the resolution is recorded in the journal, no dispatch
choice exists to enforce. Scope line (BRA-211 comment 00830b48,
BRA-160 comment 9801fe71): this issue RECORDS the fields and
resolves the pseudo-name; it does NOT enforce routing — owner-routed
dispatch (owner-preferred job/exec, owner-only decide), owner
failure/reassignment, and dead-owner detection are the scheduler's
job (BRA-160). Migration: none — jobs enqueued without a target
carry nulls and behave exactly as before.

**Triage workflow
([BRA-210](https://linear.app/brandf/issue/BRA-210/triage-breakdown-workflow-prioritize-backlog-sort-dependencies-break)).**
The backlog is now ranked by a workflow instead of by hand:
`triageBacklog` fetches the open list through the `linear` CLI
(`list_issues`), ranks it against the GOAL.md r2 order +
parallel-work map, and writes a dated ranked queue JSON + a stable
`ranked-queue.json` + a drift note for the PM (in the goal's hidden
files). The ranking is (bucket, GOAL.md position, Linear priority,
id): ready, gated-but-speculable (decision-gated — flagged, never
speculated), blocked (an open dependency), parked (won't-fix,
out-of-r2, or parallel-track). The drift note flags what the ranking
moved relative to GOAL.md — unslotted items, a higher-priority item
sitting below a lower-priority one, GOAL.md listing an item in flight
that Linear shows closed, and items with no code area in the
parallel-work map. The workflow proposes order; it never changes
order, never files to Linear, never closes an issue, never merges
code, and never decides acceptance — the PM decides. The run input
is two layers (`{ project, run, launchedBy?, owner }`); `owner` is
required and never assumed from the launcher. Cancellation is
check-then-act before the write step. Migration: none — the first
run writes the queue + drift note where dispatch reads them.

**Dependency mapping
([BRA-251](https://linear.app/brandf/issue/BRA-251/dependency-mapping-build-dependency-graph-from-the-triage-queue)).**
Triage's ranked queue is now persisted into the dependency graph the
scheduler reads, instead of being re-derived per run: `mapDependencies`
(`workflows/library/dependency-mapping.ts`) reads the queue JSON +
the GOAL.md release plan in a bun graph script
(`scripts/dependency-graph.ts`) and writes a dated dependency graph
JSON + a stable `dependency-graph.json` (in the goal's hidden files).
Nodes are the queue items with their rank; edges are `dependsOn` /
`blocks` from the items' lists plus derived `conflict` edges for
ready/gated items sharing a non-`unknown` codeArea (they cannot run
in parallel; `unknown` areas never conflict). The graph is a pure
function of the queue — `generatedAt` is the queue's `generatedAt`,
so the same queue yields the byte-identical graph — and a supplied
previous graph is diffed into edge-change counts in the report. The
graph itself never crosses a trap boundary (only a one-line summary
does). The workflow never touches Linear, never closes an issue,
never merges code, and never decides acceptance. Migration: none —
the first run writes the graph where the scheduler reads it.

**Daily queue feed workflow
([BRA-252](https://linear.app/brandf/issue/BRA-252/daily-queue-feed-publish-the-prioritized-queue-the-fleet-works-from-each-day)).**
The fleet's daily queue is now published by a workflow instead of
being re-derived by hand: `publishDailyFeed` reads the triage
ranked queue JSON + the dependency graph JSON + GOAL.md and writes
a dated daily feed JSON + a stable `daily-feed.json` (in the goal's
hidden files). The feed is the ready + gated-but-speculable queue
items in queue rank order, each carrying `conflictsWith` from the
graph's conflict edges; blocked and parked items are counted, never
fed. There is no cap — the scheduler applies quotas, not the feed.
A missing graph file refuses loudly, as does a graph from a
different triage run (triageId mismatch). Feed items whose GOAL.md
position disagrees with their rank carry a drift note, in triage's
categories, feed items only. The workflow never touches Linear, never
closes an issue, never merges code, and never decides acceptance —
the PM decides. The run input is two layers
(`{ project, run, launchedBy?, owner }`); `owner` is required and
never assumed from the launcher. Cancellation is check-then-act
before the write step. Migration: none — the first run writes the
feed where the scheduler reads it.

**Dynamic scheduler
([BRA-160](https://linear.app/brandf/issue/BRA-160/dynamic-scheduler)).**
The OS thread scheduler: `DispatchScheduler` now enforces the
owner tag on the shared queue — decide traps are owner-only (only
the owning lead's workers answer a decide for its run), job/exec
traps are owner-preferred (the owner claims them first; if the
owner is idle, other loopers may claim them — a slow owner never
stalls the pipeline), work-stealing takes from the deepest
other-owner queue (ties: oldest job's age, then owner id
lexically), and priority still dominates owner preference (an
Urgent job for a cold worker beats a Medium job for the warm
owner). A serial-commit lock makes jobs of a serial spec
(default `["merge"]`) takeable only while no job of that spec is
running. Dead-owner detection is exposed via GET `/owners` plus
the pure `detectDeadOwners` (lease expiry on the owner's claimed
jobs is the primary trigger, the Director's supervision check the
secondary; a missed daily report is a lagging signal, never the
trigger — the engine never reassigns by itself). Reassignment is
POST `/reassign-run` plus the `reassignRun` workflow
(`workflows/library/scheduler.ts`): it updates the run record in
the queue + registry and retags the run's queued + running jobs
in place, including any pending decide (named explicitly in the
response); a re-dispatch after reassignment adopts the deduped
job with the NEW tag even when the re-dispatching host still
carries the old one. The run input is two layers
(`{ project, run, launchedBy?, owner }`); `owner` is required and
never assumed from the launcher. Cancellation is check-then-act
before the reassign step. Known limit: reassignment is defined
for dead or unresponsive owners — a live Host that already loaded
the run's registry entry keeps resolving the old owner from its
in-memory copy until it reloads, while the server-side retag
still covers every already-enqueued job. Migration: none — a
queue with no owner tags selects exactly as v1 did.

**Long-lived workers
([BRA-213](https://linear.app/brandf/issue/BRA-213/long-lived-workers)).**
Workers are long-lived looping sub-agents owned by a lead: the
runner (`plugins/muse/worker-loop.ts`, script mode) presents a
stable worker id AND its owner session at every get-job (the
server records the owner — last presentation wins — and the
scheduler reads it for owner-routed dispatch; `get-job.ts` does
the same for the subagent leg, and `WORKER.md` carries the
long-lived standing instructions). Lifetime: idle timeout 30
minutes by default (`DEFAULT_WORKER_IDLE_TIMEOUT_MS`, overridable
per worker with `--idle-exit-ms`, explicit 0 disables it); clean
shutdown on lead close — the worker finishes its in-flight job,
completes it, then exits, and never claims another job
(get-job answers `{ job: null, closed: true }`, heartbeat answers
`{ closed: true }`, SIGTERM/SIGINT finish the job then exit).
The worker registry (`src/worker-registry.ts`, pure) derives
owner + spawned-at + last-seen + status (alive/idle/closed/dead;
dead is derived from silence, never self-reported) from the
server's worker store, exposed as GET `/workers` (optional
`?owner=` filter — the PM's unfiltered view), POST
`/register-worker` (a worker with no owner is refused, loudly),
and POST `/close-worker` (idempotent; wakes parked get-job
waiters). Closed records persist with status closed — removed
from the active pool, not deleted. The `manageWorkers` workflow
(`workflows/library/worker-lifecycle.ts`) is the lead-facing
surface over register/list/close (one entry, `run.operation`
selects). Workers are NOT persisted: no memory file, no chat
session, no durable identity; context dies with the worker. A
killed worker's leased job re-queues on lease expiry and
completes on another worker (maxAttempts 3, existing machinery).
The run input is two layers (`{ project, run, launchedBy?, owner
}`); `owner` is required and never assumed from the launcher.
Cancellation is check-then-act before the lifecycle step. Known
limits: the owner filter is a view, not a permission (the server
does not authenticate leads); registration is a record, not a
liveness proof; close does not cancel an in-flight job or release
its lease. Migration: none — existing worker-loop invocations
kill the process explicitly, so the new 30-minute idle default
changes nothing for them.

**Dispatch workflow
([BRA-176](https://linear.app/brandf/issue/BRA-176)).**
The router between the queue and the execution mechanism:
`dispatchTasks` (`workflows/library/dispatch.ts`) matches task
kinds to the workflows that run them. The switch key is the
task's triage tag (the bare workflow name, or admittance's
`workflow:<name>` label form); the switch is explicit, one case
per routable workflow (triage, breakdown, dependency-mapping,
daily-feed, scheduler, worker-lifecycle, merge, verify-fix, gc,
hello), and each case constructs that workflow's two-layer
run-input JSON from the task's fields. Dispatch MATCHES and HANDS
OFF: it writes the routing handoff JSON the scheduler consumes
(one entry per task naming the workflow + the run-input JSON +
the owner, atomic write + read-back) and never submits runs,
never calls sub-workflows in-run, never creates queue entries,
never enqueues jobs — the scheduler (BRA-160) owns
submission/assignment. Only READY tasks route; gated/blocked/
parked appear in `refused` with the reason named. Ownership
comes from the caller-supplied assignment only — a task with no
assignment refuses loudly, and an assignment naming a session
that is not in the project roster (not a looping session)
refuses loudly, never silently re-derived to the driving
session. Tasks process in input order, never re-sorted. The
handoff is written in base64 chunks (one small append trap per
chunk) so the routing table never crosses a trap boundary — the
trap cap is ~60KB, the single-argv cap ~128KB. The run input is
two layers (`{ project, run, launchedBy?, owner }`); `owner` is
required and never assumed from the launcher. Cancellation is
check-then-act before the write step, exactly as triage does.
Known limits: the case list covers only the workflows routable
from a task's fields (a workflow whose input cannot be
constructed refuses as needs-workflow); Linear backlog issues
are not routed (role-loop, unbuilt) — dispatch routes task kinds
only; kind is supplied per task by the caller (the ranked queue
carries no kind field — triage emitting one is a follow-up in
BACKLOG.md); the handoff names the workflow and dispatch does
not verify the workflow file exists (the scheduler refuses
loudly at submit time if it is absent). Migration: none — dispatch is a
new entry; nothing previously submitted runs through it.

**Garbage collection for finished runs
([BRA-178](https://linear.app/brandf/issue/BRA-178/garbage-collect-completed-workflows-after-30-days-unless-marked)).**
The `collectRuns` workflow (`workflows/library/gc.ts`) reclaims
finished runs after the retention window (`project.retentionDays`,
default 30 days from the ledger record's finishedAt — a cancelled
run, which leaves no ledger entry, is dated from its journal's
last wallTs): archive before delete to `<stateDir>/archive/<runId>/`
(the journal + run entry + a `run.json` with the queue entry +
ledger record + frozen hash), then delete the live queue entry +
journal + work dir (only when recorded in the run's input and
under the state dir) + per-run blobs, verify the paths are gone,
then append exactly one `collected` record to the append-only
ledger (the ledger itself is never deleted — the record names the
run, the archive path, and the reason; a second GC run appends no
duplicate). Only `done`, `failed`, and `cancelled` runs are
candidates; `queued`, `running`, and `held` are never collected,
at any age. A kept run (`agentts run --keep`, recorded as
`keep: true` on the queue entry, default false) is never
collected. Frozen closures are never deleted (shared,
content-addressed — two runs sharing one frozen hash prove it:
collect one, the other still resumes). A corrupt journal or queue
entry refuses the whole run, nothing deleted; a re-run over an
already-reclaimed run is a no-op. The run input is two layers
(`{ project, run, launchedBy?, owner }`); `owner` is required and
never assumed from the launcher. Cancellation is check-then-act
before any collection. Known limits: frozen closures are never
deleted; the human-mark verb (`queue keep`) is a follow-up; the
archive dir is the operator's to prune. Migration: none — a state
dir with no runs past retention collects nothing, and `agentts run`
without `--keep` submits exactly as before.

**Merge tier-1 resume ("Unfiled: merge tier-1 resume — a replacement-killed merge re-runs its full tier-1 instead of resuming from its journal (P0-leaning)").** A replacement-killed merge's re-drive now resumes its tier-1 from the journal instead of re-running it from section 1: the driver carries the resume dir AND the copy forward (input `carryForwardResume: true`), the workflow validates the carried-forward journal before the apply (a resumed section counts only when its `progress.jsonl` row + `.done` marker both exist), and the verified count is report data (`resumedSections`), never a note — a clean verified resumed run merges like a fresh one. The verdict rule is otherwise untouched (any note → "failed"); an unverified resume still fails exactly as before. Reconciliation is resumed + fresh == total, checked three ways (the summary line, the log aggregation, the journal). A missing/corrupt carried-forward journal, or a run.sh fingerprint refusal, falls back to a fresh tier-1, recorded as fresh in `resumeFallback` — data, never a note. A run that did not ask to carry a resume forward refuses a non-fresh resume dir loudly before anything is written. run.sh itself is untouched. A failed section in a resumed run is named in the report note with the run kind. Replay-robustness (fix round): the pre-check count and the first invocation's summary are pinned durably at the resume dir's top level (`resume-pre.json`, `resume-tier1-summary.json`, each with the journal lineage by sha256), so a re-executed workflow reports the counts from the invocation that did the work, not the replayed invocation's. (The test file is `tests/test-bra159.ts`, run.sh section + suite-inventory.json entry `bra159` — the merge workflow's suite, §C + §D; no new suite section.)

**Direct handler tests for the driver endpoints ([BRA-153](https://linear.app/brandf/issue/BRA-153/add-direct-handler-tests-for-the-driver-endpoints)).** The driver HTTP endpoints had e2e coverage (test-bra116.ts) but no unit-level handler tests — this is the unit layer: the six handler methods on `WorkerServer` (`driveQueue`, `deliverResult`, `queueList`, `deliveries`, `escalate`, `deliverGate`) are called directly, in-process, no HTTP, no mocks of the handlers themselves. Measured by branch-exercise count over the six handlers' 20 decision points (no coverage tooling exists in the repo, and file-level coverage of the 2,100-line `worker-server.ts` would drown the six handlers' ~200 lines of signal in noise): BEFORE 0/20, AFTER 20/20. The suite covers the 409 lock refusal, the 500s (child cannot write its repair report; invalid workers-config, which proves the child actually loads the config), the workers-config arg, the failed/done/idempotent deliveries (explicit and default `deliveredBy`, the non-terminal 400), the escalate validation branches including the host-throw branch (an empty kind passes the handler's check and the host throws), and the fork-suspended `deliverGate` 400 — a parent suspended at a fork, not a gate — which goes beyond test-bra116.ts's stated limitation that no deterministic workflow produces it. Two behaviors the suite pins down: `queue run` exits 1 whenever any queue entry is failed, so a child drive's exit code is not a run outcome; and `driveQueue`'s `failed` flag means "any queue entry failed", not "this drive failed". No production change was needed — `WorkerServer` is already exported and the six methods are called through a cast — so the diff is the test + inventory + run.sh + this entry. (The test file is `tests/test-bra153.ts`, run.sh section + suite-inventory.json entry `bra153`.)

**Shared merge-driver shape check (`apps/agentts/scripts/merge-driver-shape.ts`, defect 19).** The 211 re-drive driver inlined its own shape check and got it wrong: it required `applied == claimed`, so a carryForwardResume re-drive whose merge correctly reported applied == [] and alreadyApplied == [the 1 file] exited rc=1 on a merged run — a wrong check crying failure on a success, which would cause a needless re-drive next time. Future merge drivers import `checkMergeDriverShape(report, claimed, expectedSuite)` from this module instead of inlining their own check. The rule is a partition rule, not a two-shape whitelist: every claimed file appears exactly once across `applied` and `alreadyApplied`, regardless of drive mode — it accepts the fresh drive, the carryForwardResume re-drive, and the mix (some files applied fresh, some already applied), and it must not key on the drive mode (the 134 (b) fresh run proved a fresh drive can legitimately report alreadyApplied). The module also checks the verdict is "merged", the plan is clean (no conflicts, nothing refused, confinement confined), and the suite matches the driver's expected values (passed in as an argument, never hardcoded). The probe (`apps/agentts/scripts/probe-merge-driver-shape.ts`) runs six fixtures — the real 211 merge report as the re-drive fixture, a synthetic fresh drive, the mix, and three negatives (missing, overlap, extra file) — and exits 0 only if all hold. The fleet-ops skill's merge procedure now points drivers at the module. No tier-1 run is required for this task: the module is driver-side verification code, imported by no workflow or test, so it cannot affect the suite; the probe is the acceptance, and the next real merge's tier-1 is the integration proof. (No new suite section.)

**verify-fix aggregation counts section logs, and names failed sections (defect 6).** A failed tier-1 section leaves a log but no `.done` marker (run.sh exits 1 before the marker write and the progress row), so the old aggregation — `sectionsRan` from the marker count, per-section lines from the logs — threw ("aggregation lists N section logs but sectionsRan is M") instead of reporting the failure, and the merge aborted with no report (four observed instances: the first 247/248 merge, the resume acceptance run, the 260/256 completion drive, the 214 acceptance run). The aggregation now counts section logs for `sectionsRan` (a log exists for every section that ran, pass or fail; a marker exists only for a passing section), and verify-fix reads the tier-1 run's `failedSlugs` — from `report-tier1.json` in full mode, from the scoped runs' exit codes in scoped mode — and names them in a report note ("suite failed sections: <slugs>") with the verdict failed. The per-section count check stays as an internal-consistency guard; the marker/log correspondence is verified by the tier-1 journal recount, not the aggregation. For a failed tier-1, `summaryMatchesIndependent` is false as expected (the summary counts passing sections, the aggregation counts ran sections) — a symptom of the failure, not a new error. run.sh, run-tests.ts, and merge.ts are untouched (merge.ts already names failed sections via its own path, and the aggregation change flows to it through the shared `tier1AggregationScript` / `parseTier1Aggregation`). (The test file is `tests/test-bra-defect6.ts`, run directly with bun; the live probe drove verify-fix through the CLI against a copy with one deliberately failing section — the report named it and the verdict was failed, and a passing scoped run verified unchanged. No new suite section.)

**A fresh-dir merge run repaired by the engine no longer fails as an unverified resume (defect 7, M3).** The resume-pre pin is written only in the `carryForwardResume` branch of the step-5b pre-check, so a fresh-dir run sets `resumedPre = 0` and writes no pin. If that run is killed mid-tier-1, the engine repairs it by resuming from the snapshot blob — the workflow resumes at the tier-1 step with `resumedPre` still 0 (the pre-check does not re-run) — and the tier-1 completes clean, but the report carried `resumedSections: 0` with `skippedViaResume: 64`, so the verdict rule and the reconciliation both fired and the run failed as an unverified resume (observed in the 134 real run: 64 skipped via resume, 8 ran fresh, verdict "failed" on shape). When the full tier-1 ran, the report's `resumedSections` is now `max(resumedPre, skippedViaResume)` — the pin (`resumedPre`) when a pin exists (carryForwardResume), else the tier-1 summary's `skippedViaResume` (engine repair of a fresh-dir run, the M3 case); and the reconciliation's `skippedViaResume !== 0 && resumedPre === 0` line is removed (the post-run journal validation + the sectionsRan+skipped check already prove the skips are verified). The two numbers measure different things: `skippedViaResume` is the chunk-level count (chunks reused via their report.json), the pin is the journal-level count (sections the carried-forward journal already has, verified pre-run) — defect 6's re-drive is the proof (its tier-1 ran all 73 sections fresh, skippedViaResume 0, while the pin said 26), and max() does not double-count (when a pin exists, the skipped sections are a subset of the pinned sections). The pin, the pre-check, and `reconcileResumeCounts` are untouched; run.sh and the tier-1 are untouched. The post-run reconciliation is extracted into the pure helper `reconcileTier1Summary` (merge.ts). (The test file is `tests/test-bra-defect7.ts`, run directly with bun; the live probe drove a real fresh-dir merge, killed it mid-tier-1, and let the engine repair it — the repaired run's report carries verdict "merged" with `resumedSections` equal to the skipped count. No new suite section.)
**A failed chunk report no longer poisons the resume dir (defect 8, M4).** run.sh’s workflow driver reused a chunk’s report.json if the file existed, never reading whether it recorded a failure — a failed chunk was reused as "done" and the failed section was never re-executed (observed in the bra166 case, Nov 23: chunk-1’s report recorded ran 32 / passed 31 / failed 1, failedSlugs [‘bra166’], and every re-drive reused it and failed the same way). When the driver finds a chunk report that records a failure (failed > 0 or failedSlugs non-empty, or unparseable), it now logs the failed report (chunk index, ran/passed/failed, failedSlugs), removes the chunk’s report + sub-run state dir, and falls through to the fresh-drive branch (re-submit + re-execute). Deleting the report alone is not enough — the sub-run state (state/slices/, state/journals/, the queue.json "done" entry) replays the stored result without executing any leaf (re-drive 2, Nov 23) — so the whole chunk state goes. A report that records no failure is still reused; the passing path is unchanged. This is the code fix, not the manual resume-dir repair (deleting a chunk directory by hand still needs Landing’s authorization). (The test file is `tests/test-bra-defect8.ts`, run directly with bun; the leg drives the real run.sh workflow driver on a scoped tier-1 with a deliberately failing section, re-driven — the section is re-executed and the tier-1 completes; a passing chunk is still reused; an unparseable report is discarded and re-driven. No new suite section.)
**Load tolerance for bra166/bra178 as tier-1 sections (defect 21).** bra166 and bra178 kept failing tier-1s under load, and the recovery was a manual --only re-run — bra166 killed two merge tier-1s on the same wall-clock assertion (the Nov 23 resume acceptance run and the Nov 25 defect-7 merge, the ONLY failure bra166). bra166: the §B recovery window (last 5 ledger entries) still holds 2 slow runs, so its median is the LARGEST fast run — a single stalled fast run (~1s, observed twice in tier-1s under load) flips it above the threshold, and the audit fails the recovery. The fix accepts "confirmed-pass" as a valid recovery in the §B test: the audit's confirm-before-fail is the designed recovery detector — when the last 3 runs (all fast) are green, the breach was stale and the check passes as confirmed-pass. The assertion still discriminates (a genuinely slow recovery still fails: 2+ of the 3 fast runs slow makes the confirm median breach). Raising the latency multiple cannot fix this — measured: slow runs are ~1035ms in every case (quiet, CPU-loaded, and the failing tier-1; the 1000ms sleep dominates and the ~1s stall is a single event, not additive overhead), so the threshold would have to exceed a stalled fast run (~1036ms) and stay below a slow run (~1035ms) at once; the multiple stays 3.0 and the regression case (three slow runs fail the audit) is unchanged. bra178: the test-server startup deadline in `startServer()` is raised from 10s to 60s — the server typically comes up in ~0.4–1s (measured quiet: 356/361/1030ms; under CPU load: 799/894/901ms), but the 10s deadline expired once in a tier-1 (the 211 resumed run, Nov 24); the deadline is a liveness bound, so 60s buys 6x headroom over the observed failure at no cost when the server comes up fast, and a server that never comes up still fails. (The leg is a scoped tier-1 run under load — `run.sh --only bra166,bra178` — passing both sections with no manual re-run; the merge's tier-1 is the integration proof. No new suite section.)

### Fixed

**verify-fix no longer captures run.sh's full stdout through the
exec trap
([BRA-217](https://linear.app/brandf/issue/BRA-217/verify-fixts-captures-runsh-full-stdout-uncapped-trap-cap-risk-on-real)).**
The suite step carried run.sh's whole stdout as the summary line
(`summaryLine = r.stdout`). A full tier-1's stdout is megabytes —
far over the ~60KB exec-trap cap — so the workflow crashed the C
host on resume instead of verifying. The suite run now goes through
`suiteRunScript` / `scopedSuiteRunScript`, which redirect run.sh's
stdout to a file in-shell and return only the PASS summary line
(full runs) or a one-line exit marker (scoped runs): the merge
workflow's `tier1RunScript` pattern, applied in place in
verify-fix (merge already imports from verify-fix, so importing
its transport back would cycle). The bulk output stays on disk
under the work dir. The report's `summaryLine` is now actually the
driver's printed PASS line, as its contract always said.
Migration: none — the report shape is unchanged; a run with no
PASS line still fails loudly via the null summary.

**Large trap results no longer crash the C host on resume
([BRA-214](https://linear.app/brandf/issue/BRA-214/exec-trap-stdout-cap-60kb-crashes-the-c-host-on-large-outputs)).**
A trap result at or above the 64KB inline threshold is delivered to
the C host through a scratch file (the `agentts-file:<path>` marker,
BRA-171) — but a binary built before that support tried to
JSON-parse the marker itself and crashed on resume with
`SyntaxError: unexpected token: 'agentts'`, three retries, then
failure (QA's probe: 59,561 B passes, 64,111 B crashes). The C host
now prints its source hash (`durablets version` prints
`{"sourceHash": "<sha256(durablets.c + durablets.h)>",
"features": ["result-file"]}`, baked in by the Makefile), and the TS
host verifies it — lazily, once per Host, only before the first
file-backed delivery — failing loudly with a named BRA-214 error on
any mismatch, including "unknown" (a binary built without the flag).
Small results keep working on an old binary (they travel inline).
The 64KB inline threshold is intentional (half Linux's 128KB
MAX_ARG_STRLEN) and unchanged; a new explicit bound caps file-backed
results at 16MB, above which the delivery fails loudly naming the
limit before any file is written or resume spawned. The regression
test drives a large exec trap at 59,561 B and 64,111 B (QA's sizes),
66,000 B, 162,000 B (the real-tree manifest size) and 1,000,000 B,
plus a hostile stale-binary case and a cross-shift kill-and-resume
case. (The test file is `tests/test-bra214.ts`, run.sh section +
suite-inventory.json entry `bra214`.)
Migration: none — but after this lands, the checked-in binary in
`packages/durablets/out/durablets` is still the pre-fix build: a
large trap result on it now fails loudly instead of crashing, and
only starts working once the binary is rebuilt (`make -C
packages/durablets durablets`).

**Big arXiv list pages fetch over curl again
([BRA-174](https://linear.app/brandf/issue/BRA-174/bun-spawnsync-caps-stdout-at-1-mb-enobufs-big-arxiv-list-pages-always)).**
Bun's `spawnSync` caps captured stdout at ~1MB by default, so the
three big arXiv list pages (~1.58–1.7MB) always failed the
curl-first fetch with `ENOBUFS` and every discover relied on the Bun
fetch fallback — no redundancy on those pages, and two failed curl
attempts of latency each time. The spawn sites that can realistically
exceed the cap now pass `maxBuffer` 16MB: the briefing fetcher, the
host's run loop (workflow output plus fork-branch outcomes), both
exec adapters, the worker-queue sync client, the worker CLI spawn,
and the Linear client. The audit also recorded the sites that stay
uncapped because their output is bounded by construction (the engine
probe, the bundle build, the direct adapter's one-line worker
result, the bugfix worker's small command output).
Migration: none — discover's curl-first path works again for the
three biggest categories.

**Mock-mode briefing runs no longer need a judgments file
([BRA-162](https://linear.app/brandf/issue/BRA-162/mock-mode-briefing-run-without-judgmentspath-fails-at-the-judge-step)).**
The workflow passed `judgmentsPath` into the judge job even when no
verdicts file existed, and the trap JSON boundary rejects
`undefined` — so a mock run with no judgments file died at the judge
step. The judge job now omits the key when there is no path (the
conditional spread, as in the trial runner), and the mock adapter's
neutral-5 fixture carries the run. The direct-adapter path is
unchanged: with no verdicts at all the judge still fails loudly, and
a trial run that supplies recorded verdicts still uses them.
Migration: none — mock runs drop the fabricated judgments file;
trial runs are unaffected.

## r1

Work landed since r0 (2026-11-17), shipping in the r1 release. The r1 blockers tracked in
Linear carry the `r1-blocker` label.

### Breaking changes

**`host.result()` now derives status from durable state
([BRA-131](https://linear.app/brandf/issue/BRA-131/hostresult-reports-running-for-a-stepwise-driven-run-whose-journal)).**
`result()` used to derive status from the registry/finished map and
never consulted the journal, so a cancelled run — whose journal
carries a lifecycle `failed` event — still reported `running`. It now
consults the journal for a lifecycle `failed` event (and `cancelRun`
records `finished` on terminal rc), so a cancelled run reports
`failed` with the journal's real error.
Migration: if your automation polls `result` / `status` and treats
"running" after a cancel as "still going", it will now see `failed`.
No workflow source change is needed.

**A throw after an `all()` join now fails the run cleanly
([BRA-121](https://linear.app/brandf/issue/BRA-121/throwing-after-an-all-join-crashes-the-join-slice-instead-of-failing)).**
A workflow that collected `all()` outcomes and threw after inspecting
them used to crash the join slice — `C host crashed joining <runId>
3 times` — with no lifecycle `failed` event. The four join handlers
now print the exception and emit the lifecycle `failed` event, so the
run fails with the real error.
Migration: none needed — the same code now produces a clean failure.
If you added a `sleep(0)` after a join to work around the crash, you
can remove it.

**A cancelled run's lifecycle `failed` event now carries the error
([BRA-125](https://linear.app/brandf/issue/BRA-125/cancelled-run-journals-a-lifecycle-failed-event-with-no-error-emit)).**
The cancel handler emitted the `failed` event before printing the
exception, so the event had no `error` key at all. The order is
reversed: print first, then emit.
Migration: none. Consumers that read the failed event's `error`
field now get a value instead of nothing.

**Journals load lazily; `queue list` no longer reports a corrupt
journal ([BRA-98](https://linear.app/brandf/issue/BRA-98/host-eagerly-loads-all-journals-into-ram-at-construction-load-lazily)).**
The Host no longer parses every `.journal` file at construction; a
run's journal is parsed from disk on first access to that runId.
Corruption is still quarantined and warned about — but the discovery
moves from construction to first access.
Migration for operators: if you grepped `queue list` output for
`CORRUPT JOURNAL`, switch to `status <runId>` — corruption is
reported there, on first access. Run behavior is unchanged.

**Gate auto-answers are now loud
([BRA-119](https://linear.app/brandf/issue/BRA-119/gates-auto-answered-yes-by-default-silently-human-checkpoint-never-holds-without-gates)).**
Under the mock adapter (the default outside the production state
dir), a gate is still auto-answered `"yes"` by default — the default
is unchanged, because it is right for tests and unattended runs. But
an auto-answer is no longer silent: the drive logs
`GATE AUTO-ANSWERED` naming the run and trap, and the journal events
are marked `auto: true`.
Migration: for any run where the gate is a real human checkpoint,
pass `--gates hold` to BOTH `run` (submit) and `queue run` (drive) —
the two commands build separate Hosts, so a flag on only one does
nothing. The direct and muse adapters always hold.

**`JudgeFixLoopResult` gained `lastVerdicts`
([BRA-128](https://linear.app/brandf/issue/BRA-128/adding-a-field-to-judgefixloopresult-breaks-consumers-with-strict)).**
The shared result type now carries `lastVerdicts: JudgeVerdict[]` —
the final round's verdicts, including the open-ended feedback. If
you declared your own output type mirroring the loop result, add the
field: the C host writes the full runtime result and
`readResultFile` validates it against your declared schema with
`additionalProperties: false`, so a missing field rejects the result
with `must NOT have additional properties` and the CLI prints
`undefined` — even though the run itself converged.
Migration: add `lastVerdicts: JudgeVerdict[]` to your declared
output type. No run behavior changes.

**Engine upgrades and old snapshots
([BRA-115](https://linear.app/brandf/issue/BRA-115/snapshot-engine-migration-investigate-converter-support-strip-and),
[BRA-132](https://linear.app/brandf/issue/BRA-132/assertengineversion-refuses-resume-on-any-durabletsc-change-even-when)).**
Two different upgrades, two different answers. Upgrading AgentTS
alone — same dquickts engine — does not make old snapshots
unloadable: the snapshot format (SNAP_FORMAT_VERSION, BC_VERSION,
class table) and the registered native set are unchanged, so the
snapshot bytes still load. Before r1, `assertEngineVersion`
compared the full `dquickts-<pin>+durablets-<hash>` string, so a
release that changed durablets.c — r1 did, twice (BRA-121, BRA-125)
— still refused to resume a parked run, loudly, with an
`engine-version-mismatch` journal event. That refusal was the gate
being conservative, not snapshot incompatibility. Since r1 (BRA-132,
below) the gate compares the snapshot format identity instead — the
build signature read from the snapshot blob's header, the dquickts
pin, and the ordered host native names — so a release that changed
only durablets.c logic resumes parked runs; a dquickts pin change,
a native add, or a native rename still refuses loudly.
Upgrading to a release with a new dquickts engine is the case that
can actually break parked runs: if the new engine moves the
snapshot format, old snapshots won't load. Migration options:
- **Drain (works today):** keep the old host+engine pair alive
  until parked runs finish. This assumes the old engine can still
  run safely — it is the interim, not the migration.
- **Converter (proven by prototype, not yet shipped):** the
  strip-and-recompile converter reads the snapshot as data, never
  executes the old engine, and was proven end to end — a converted
  snapshot resumed on a BC_VERSION 8 engine and completed with the
  identical result (`{"verdict":"RIGHT","total":7}`). But there is
  no `agentts snapshot convert` command in the repo yet; the
  prototype lives outside the tree. Do not upgrade the engine with
  parked runs until the converter ships.
- **Start fresh:** lose the run.
If the upgrade is a security fix in the old engine, drain is not an
option — the converter is then the only migration, and it is not
yet available. A stopgap is backporting the fix to the old pin and
draining on the patched old build. Full write-up:
`docs/audits/snapshot-engine-migration.md`.

### Added

**Plan-driven-work template
([BRA-117](https://linear.app/brandf/issue/BRA-117/plan-driven-work-template-reusable-workflow-for-plan-review-execute),
[BRA-126](https://linear.app/brandf/issue/BRA-126/plan-driven-work-phase-review-should-diagnose-root-cause-level-work)).**
Brandon's 6-step loop (plan, review, execute, review, commit, push)
codified as a reusable workflow: a plan draft improved through a
JudgeFixLoop, a `gate` trap between plan and execution (the approved
plan is frozen, so the executed plan is byte-identical to the
approved one), dependency-wave execution, a per-phase review via the
phase-review child workflow, and — on any failing phase review — a
root-cause diagnosis naming the level(s): work, workflow, rubric,
each with a reason and a fix routing. The template asks the question
every time instead of depending on anyone remembering to.

**Rubric chain: `rubricReview`, the meta-rubric, and the
morning-report rubric file.** `rubricReview` judges a rubric against
the checked-in meta-rubric (`workflows/rubrics/meta-rubric.md` — 14
criteria with 0/5/10 anchors under four perspectives:
discrimination, clarity, usefulness, robustness) and improves it
through a JudgeFixLoop, with open-ended judge feedback (including
the adversarial probe: construct a bad artifact that would PASS this
rubric). The daily briefing now reads its rubric from
`workflows/rubrics/morning-report-rubric.md` at step 0 — edits take
effect the next morning with no code change. Note the honest limit:
round-1 scores are the measure; final convergence to 1.0 is not
evidence of quality (the v0 judges score by stem coverage).

**Driver HTTP endpoints
([BRA-116](https://linear.app/brandf/issue/BRA-116/driver-endpoints-on-the-worker-server-tick-agent-calls-http-instead-of)).**
The worker server now serves `queue run`, `deliver-result`,
`queue list`, `deliveries`, `escalate`, and `deliver-gate`, so the
tick agent drives over HTTP instead of spawning a fresh Bun process
per action. End to end per unit of work: ~2.3 s → ~0.7 s. Submit
stays CLI by design (~530 ms spawn is the floor).

**Production deliver proof
([BRA-110](https://linear.app/brandf/issue/BRA-110/production-deliver-half-prove-drivedeliver-end-to-end-bra-52-q3-prose)).**
Drive+deliver proven end to end: a real production run driven
through the queue delivers its result to the outbox exactly once
(double-delivery guard), including failed-run delivery and the
refusal contract.

**Journal retention monitor
([BRA-97](https://linear.app/brandf/issue/BRA-97/long-running-workflows-journal-grows-unboundedly-per-trap-no-retention)).**
A bench metric (`host_construct_ms.journals1m`) now watches host
construction against a 1M-event journal, and the retention design is
measured: a run writes ~188.9 B/event and ~6.0 events/trap, so a
100k-trap run writes ~113 MB for trivial payloads (~390 MB at 1 KB
payloads, ~3.1 GB at 10 KB). No retention or compaction is
implemented yet — that needs a decision first (see Known
limitations).

### Changed

**Tiered test runner with resume
([BRA-137](https://linear.app/brandf/issue/BRA-137/long-runsh-suite-runs-keep-getting-sigterm-killed-mid-flight)).**
`./run.sh` is now tier 1 by default (16 sections, measured 223–228 s)
instead of the full ~30 min suite: targeted tests for what changed
plus a sampled quick tier. `--tier 2` runs broader integration and
more e2e; `--full` / `--tier 3` runs everything including the bench.
A run survives being killed: each section writes a completion marker,
and re-invoking resumes the uncompleted tail (a kill costs the tail,
not the whole run). A tree-fingerprint guard refuses a resume across
a tree change. Per-attempt logs are written under a per-run resume
directory, and the PASS line names the tier and what was skipped, so
a tier-1 PASS can never read as a full PASS. Full suite, verified
both paths: 2678 OK, 94–95 ^PASS, bench ALL GREEN on 53 metrics.
See the usage skill (§10) for the tier table and the targeted-test
rules. No workflow change is needed; run `./run.sh --list` to see the
section inventory.

**Mock exec results are now marked as canned
([BRA-120](https://linear.app/brandf/issue/BRA-120/mock-adapter-silently-fakes-exec-success-warn-loudly-when-an-exec)).**
Under `--adapter mock`, any exec except `cat` (reads for real) and
`echo hi` still returns the canned `{stdout: "", exitCode: 0}` — but
now it logs `[mock] CANNED EXEC: command "..." was NOT run ...`
naming the command, and the journal marks the trap's dispatched and
result events `canned: true`, so a mock run can no longer pass
vacuously without saying so. Queued exec answers are delivered
as-is, unmarked. The mock still never runs a command.

**The tick agent ignores events for runs that aren't here
([BRA-133](https://linear.app/brandf/issue/BRA-133/tick-agent-receives-events-for-runs-that-do-not-exist-in-the)).**
A foreign host posting to the worker server could wake the tick
loop with events for runs that don't exist in the production
state dir. `ingestEvent` now runs the same run-existence check
deliver-result already does (queue entry, registry entry, or
journal) and a foreign runId gets the same 404 — the poster is
fire-and-forget, so the 404 can't break it, and it is the
diagnosable signal. One shared check, so the two sites cannot
drift.

**Briefing htmlPath now names the week file that exists
([BRA-123](https://linear.app/brandf/issue/BRA-123/daily-ai-briefing-returned-htmlpath-does-not-match-the-week-file-the)).**
The workflow returned `ai-briefings-week-<edition date>.html`, but
the builder names the weekly page by the Monday of the edition's
week — so for a Tuesday edition the returned path pointed at a file
that does not exist. The workflow now computes the week Monday
itself (UTC, so local time can't shift the weekday) and the print
and the returned path share one value, so they cannot disagree.

**Failed plan phases now show the command's stdout
([BRA-122](https://linear.app/brandf/issue/BRA-122/plan-driven-work-failed-command-phase-hides-stdout-only-stderr-is)).**
A command phase that failed used to report only its stderr, so a
command that explains its failure on stdout left no trace of why it
failed. The phase-failure error (and the commit step's) now carries
the stdout tail (last 2 KB, `...` when truncated) alongside the
stderr head, each labeled. The full streams were already in the run's
journal as the exec trap's events.

**Traps inside native-builtin callbacks are refused at extraction time
([BRA-129](https://linear.app/brandf/issue/BRA-129/traps-cant-suspend-inside-native-builtin-callbacks)).**
A trap called inside `Array.map`, `forEach`, `filter`, and twelve other
native-builtin callbacks used to fail mid-run with `TypeError: this call
cannot be suspended`, because the callback runs from C and dquickts
cannot suspend from it. The extractor now refuses the workflow at
first run, naming the callback and the fix (use a plain `for` loop or a
direct call instead). A thunk merely created inside a callback and
invoked later by `all()` still runs. Supporting suspension from inside
a native callback would need snapshot-format changes and is an engine
redesign, not a fix — this refusal is the behavior.

**Bundle validator no longer refuses import/export inside strings
([BRA-118](https://linear.app/brandf/issue/BRA-118/bundle-validator-false-positives-on-importexport-inside-string)).**
The check that refuses a bundle the C host would eval as a module
used to test the bundle text with line regexes, so a workflow
embedding a script, code sample, or doc text with `import` or
`export` at a line start was un-runnable. The check is now a real
parse (`Bun.Transpiler.scan`): only static import statements and
any exports refuse, with the refusal message unchanged. Dynamic
`import()` and `import.meta` were never refused and still aren't;
an unscannable bundle is refused loudly, never run.

**Driver bundle cache
([BRA-94](https://linear.app/brandf/issue/BRA-94/cache-the-driver-bundle-by-frozenhash-instead-of-rebuilding-per-run)).**
Bundles are cached on disk under `stateDir/bundles/<key>/`, keyed by
the frozen hash PLUS the input JSON baked into the driver PLUS the
engine and bundler versions (`bra94-v1`). `bundle_ms` 5.59 → 0.09 ms
(−98%); warm trivial end-to-end 62.7 → 52.5 ms. A driver with no key
(live-path or hand-written) is never cached and builds every time.
No action needed.

**Lazy journal loading
([BRA-98](https://linear.app/brandf/issue/BRA-98/host-eagerly-loads-all-journals-into-ram-at-construction-load-lazily)).**
Construction with a 1M-event journal: 374 ms → 6.5 ms (58×); +143 MB
RSS → +0.5 MB. First access to a run still pays the parse (~290 ms).
See also Breaking changes, above, for the `queue list` behavior
change.

**`notifyEvent` without curl
([BRA-96](https://linear.app/brandf/issue/BRA-96/notifyevent-spawns-a-curl-per-event-105ms)).**
Event notification is now a fire-and-forget in-process fetch instead
of a curl spawn per event. `notify_ms` 13.35 → 0.04 ms (−99.7%).
Same endpoint, payload, and 2 s bound; the submit CLI flushes
in-flight notifications before exiting, so delivery is preserved.

**Blob recipe audit
([BRA-95](https://linear.app/brandf/issue/BRA-95/blob-recipe-audit-which-of-the-3x-sha256-hashes-is-redundant)).**
The G4 blob copy now hashes the source once and reuses it in both
integrity checks (both checks stay — each is load-bearing for a
different half). ~0.85 ms saved per 500 KB copy. No behavior change.

**Parked runs now resume across AgentTS-only upgrades
([BRA-132](https://linear.app/brandf/issue/BRA-132/assertengineversion-refuses-resume-on-any-durabletsc-change-even-when)).**
The resume gate used to compare the full engine version
(`dquickts-<pin>+durablets-<hash>`), so any change to durablets.c —
even a logic-only bug fix that leaves the snapshot format untouched
— refused every parked run. It now compares the snapshot format
identity: the build signature read from the snapshot blob's header,
the dquickts pin, and the ordered host native names. A release that
changed only durablets.c logic resumes parked runs; a dquickts pin
change, a native add, or a native rename still refuses loudly with
an `engine-version-mismatch` journal event and the blob left on
disk. The full engine version is still recorded on every run for
provenance. Two limits to know: runs recorded before this change
carry no format identity, so they are gated on the blob-header
signature plus the recorded pin (a native rename in that window is
not caught); and durablets.c logic itself is not in the identity —
resuming under a native-behavior fix means the run continues under
the fixed behavior.

### Fixed

**Large trap results now deliver instead of failing the spawn
([BRA-171](https://linear.app/brandf/issue/BRA-171/engine-cannot-deliver-an-exec-trap-result-larger-than-128kb-e2big-on-resume)).**
A trap result whose JSON exceeded ~128KB failed the resume spawn with
`E2BIG: argument list too long`, so the run could not be resumed — the
bench section's result (~230KB from 217,671 bytes of stdout) was
undeliverable this way, which blocked a green tier-3 run through the
workflow driver. Results at or above 64KB now travel through a
scratch file (`agentts-file:<path>` on argv) that the C host reads;
small results still go inline, and the file is unlinked after the
resume. A missing or unreadable file fails loudly (named on stderr,
lifecycle `failed`) instead of resuming with a wrong result.
Migration: none — the same workflows now complete.

**Large job inputs now run instead of failing the spawn
([BRA-179](https://linear.app/brandf/issue/BRA-179/direct-adapter-cannot-spawn-a-worker-for-a-job-whose-input-exceeds)).**
A job whose input JSON exceeded ~128KB failed the worker spawn with
`E2BIG: argument list too long`, so the job could not run at all —
the first rubricReview run hit this with two full-page reference
examples (74KB + 71KB). Inputs at or above 64KB now travel through
a scratch file (`agentts-file:<path>` on argv) that the worker
script reads; small inputs still go inline, and the file is unlinked
after the spawn. The same cap applied at the two other sites on the
job-input path: the pool worker-loop's spawn and the muse adapter's
sync curl `--data` (large bodies now travel as `--data-binary
@<file>`). A missing or unreadable file fails loudly (named on
stderr) instead of running with an empty input.
Migration: none — the same workflows now run.

### Known limitations (not yet fixed)

**Traps cannot suspend inside native-builtin callbacks
([BRA-129](https://linear.app/brandf/issue/BRA-129/traps-cannot-suspend-from-inside-a-native-builtin-callback-arraymap)).**
A trap called from inside `Array.map` — and presumably `forEach` /
`filter` / `reduce` and any other C-implemented builtin that invokes
a JS callback — throws `TypeError: this call cannot be suspended`.
The workflow-side workaround is in-tree (`resolveReferences` uses a
plain `for` loop); the engine/extractor fix is still open.
Migration for workflow authors: use a plain `for` loop when the
callback calls a trap.

**Briefing parity not reached
([BRA-124](https://linear.app/brandf/issue/BRA-124/briefing-discovery-keyword-topic-scoring-misses-consequential-papers),
[BRA-111](https://linear.app/brandf/issue/BRA-111/briefing-live-cutover-run-daily-ai-briefing-in-parallel-on-the)).**
The Nov 18 trial vs the cron edition: 0/14 overlap. Keyword topic
scoring measures topic coverage; consequence is not visible to it,
so parity needs a semantic consequence signal — a design decision,
not a keyword tweak. The live briefing stays on the cron until
parity is shown and Brandon decides the switch. (Significance topic
+ arXiv API query fix kept; abstract enrichment reverted.)

**Journal growth is unbounded ([BRA-97](https://linear.app/brandf/issue/BRA-97/long-running-workflows-journal-grows-unboundedly-per-trap-no-retention)).**
No retention, compaction, or rotation exists yet. The monitor and
the measured design are in place; the policy decision is pending.

## r0 (MVP) — 2026-11-17

Public release: the repo flipped public under the MIT license
([BRA-91](https://linear.app/brandf/issue/BRA-91/mvp-release-license-public-repo-release-checklist)),
17/17 MVP blockers done. Suite at release: 1745 OK, bench gate
ALL GREEN on 43 metrics.

**What shipped.** The three layers (DurableTS core in C, AgentTS
host in TypeScript, one adapter per environment); a workflow is an
ordinary TypeScript function — one JSON-capable input in, one
JSON-capable output out. The first-run gate (type-check with pinned
TypeScript 5.9.3, JSON Schema extraction from trap contracts, M2
checker). Seven trap types — `job`, `exec`, `gate`, `sleep`, `cron`,
`decide`, `run` — plus the `all` / `any` / `race` combinators with
fail-fast and cancellation. Freeze by content hash
([BRA-71](https://linear.app/brandf/issue/BRA-71/g9-g10-run-integrity-across-time-frozen-workflow-copy-and-snapshot)):
a run executes and validates against the frozen copy, never the live
file; snapshots are same-engine-only. The worker pool (get-job /
complete-job loop, leases, heartbeats, idempotent re-queue) and the
queue + tick driver. Incremental snapshots
([BRA-90](https://linear.app/brandf/issue/BRA-90/investigate-incremental-snapshots-js-snapshot-basedelta-for-large-heap)):
a delta chain with periodic keyframes, cutting bytes written per
suspension. Sub-workflows as child runs
([BRA-105](https://linear.app/brandf/issue/BRA-105/sub-workflows-as-child-runs-agentts-runcall-on-top-of-trap-bra-52-q2)):
`run` / `call` on top of trap, own runId and journal per child. The
workflow library ([BRA-52](https://linear.app/brandf/issue/BRA-52/workflow-library)):
JudgeFixLoop, improve-loop, presentations
([BRA-109](https://linear.app/brandf/issue/BRA-109/presentations-library-workflow-bra-52-q1-google-slides-judgefixloop)),
decisionCascade, plus the daily-briefing and bug-fix dogfood
workflows. Inline one-shot workflows
([BRA-112](https://linear.app/brandf/issue/BRA-112/inline-one-shot-workflows-agentts-run-reads-the-workflow-from-stdin)):
`agentts run -` reads the workflow from stdin, materialized
content-addressed under `.agentts-scratch/inline/` in the cwd.
The robustness wave: atomic queue writes, torn-entry recovery,
corrupt-journal quarantine, journal check before re-dispatch. The
bench harness with a regression gate and a tighten-only ratchet.

**Honest limits at release.** No versioned release, no published
package, no hosted service. No long-lived C-host daemon: the host
spawns the C binary once per run-slice. No general reasoning in the
`decide` trap: the in-engine decision model is a narrow,
deterministic parser of the question text — a full agent is a `job`
trap, not a `decide` trap.
