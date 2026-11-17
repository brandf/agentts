# Journal / profiler audit — 2026-11-16

**Question:** does the journal as written today support the future profiler —
(a) a timeline with parallel lanes for each worker job or exec,
(b) spans (start→end) per lane, and
(c) clicking a span shows the exact workflow code it came from and the specific
inputs and outputs to that span?

**Verdict in one line:** lanes per run/branch and spans work (v2 journals only);
click-to-data works at the journal layer; click-to-code does **not** work —
no journal event carries a call site, and no journal event records which
workflow version ran. Two small journal additions plus one adapter change
close the gaps. The current profiler (`apps/agentts/src/profiler.ts`) is
counters + an event-order timeline, not a wall-time lane timeline — that is
display work on top of a mostly-ready journal.

**Method (read-only; no code changed):** read the journal writer
(`apps/agentts/src/host.ts` `journalEvent`, the C event emitters in
`packages/durablets/src/durablets.c`, `apps/agentts/src/profiler.ts`,
`apps/agentts/src/extract.ts`, `apps/agentts/src/gate.ts`,
`apps/agentts/src/cost-model.ts`, `apps/agentts/src/scheduler.ts`,
`apps/agentts/src/worker-server.ts`), and read two real journals: a **fresh
v2 journal generated live for this audit** (`bun src/cli.ts run
tests/workflows/workflow-judges.ts --adapter mock`, state dir
`/tmp/audit-state`, run `audit-judges`, 2026-11-16 14:23 PST) and the
checked-in **v1 briefing fixture**
(`apps/agentts/tests/fixtures/profiler/briefing-proof3-2026-11-16*.journal`).

**Mid-flip caveat (BRA-59 in progress by another worker during this audit):**
`apps/agentts/src/cli.ts` was modified 14:19 PST while I worked — `run` already
submits and returns a run ID (`RUN audit-judges`, run queued in `queue.json`,
driven by `queue run`), and `packages/durablets/src/durablets.c` already
contains the `g_in_workflow` entry guard. The journal writer, core events,
extraction cache, and profiler are stable parts; findings below are on those.
The CLI/run-path behavior may still be changing — I did not audit it.

## The journal as written today

Events (core emits one JSON object per line on stderr, prefixed
`[durablets] `; the host ingests them in `host.ts` `ingestLog` and journals
each via `journalEvent`, which stamps `wallTs` — ISO wall clock, ms
precision — on every event, `host.ts:596-606`):

| Event | Fields (as emitted) | Where |
|---|---|---|
| `lifecycle` | `lifecycle: started\|suspended\|resumed\|completed\|failed`, `runId`, `kind: 2\|3` on suspend | `durablets.c` `emit_lifecycle` (~1066) |
| `trap` | `runId`, `trapId` (`<runId>/trap-<ordinal>`), `ordinal`, `type`, `arg` (full) | `durablets.c:1213-1221` |
| `trap-result` / `trap-error` | `runId`, `trapId`, `ordinal`, `result` / `error` (full); host-enriched at ingest with `adapter`, `worker` (if the adapter named one), `wallMs`, `tokens` (if known) | `durablets.c` + `host.ts:792-806` |
| `fork` | `runId`, `forkId`, `kind: all\|any\|race`, `branches`, `failFast?`, `childRuns: [...]` | `durablets.c` header (~60) |
| `join` | `runId`, `forkId`, outcome array / winner / failedBranch+error / aggregate | `durablets.c` header (~62) |
| `branch-start` / `branch-done` | `runId`, `parentForkId`, `branch`, `outcome` (on done) | `durablets.c:1560-1571` |
| `cancel` | `runId`, `what: trap\|fork`, `ordinal?`, `forkId?`, `trigger`, `reason`, `when` (epoch), `cancelled[]?`, `parentForkId?`, `branch?` | `durablets.c` header (~64) |
| `gate-held` | `runId`, `trapId`, `question` | `host.ts:1357-1363` (dispatchTrap) |
| `validation-error` | trap + validation detail | `host.ts:1307` |
| `clock-advance` | `runId`, `from`, `to` (ISO, virtual clock), `reason` | `host.ts:494-502` |
| `queue-started` | `runId` (run level only) | `host.ts:449` |

No truncation anywhere in the emit path: `durablets_emit_event`
(`durablets.c:1060`) is `fprintf(stderr, "[durablets] %s\n", json)` over a
growing buffer — the full arg/result is emitted. Verified: a ~6 KB paper
abstract in full in the fixture branch journal, and the full verdicts array
in the fresh journal's aggregate `trap` arg.

## Requirements → evidence

| # | Requirement | Journal evidence | Verdict |
|---|---|---|---|
| 1 | Lanes — a lane per execution unit (run, branch, worker, exec) | Every event carries `runId`; branch runIds encode the fork path (`root/fork-0/branch-1`); `fork` carries `forkId` + `childRuns`; `branch-start`/`branch-done` carry `parentForkId` + `branch`. **But** `worker` on `trap-result` exists only when the answering adapter names one — verified absent on mock (fresh journal: `adapter: mock`, no `worker`) and on direct (returns `{value}` only, `direct-adapter.ts:110`); pool `workerId` lives in `worker-jobs/jobs.log` + the pool store, not in the journal. Exec traps have no process identity — a lane per exec is just the trap's own span. | **PARTIAL** — run/branch lanes OK; worker lanes GAP |
| 2 | Spans — start AND end per unit; queue-wait vs execution split | `trap` (wallTs) → `trap-result` (wallTs) gives a span; the result's `wallMs` gives host-measured dispatch time. Fresh journal verified: branch job `wallMs: 43`, mock aggregate `wallMs: 0`; total run wall 77 ms (profiler: `totalWallMs`). Run spans via `lifecycle` started → completed. Gate hold via `gate-held` → `trap-result` wallTs diff (profiler does this; the gate trap's own `wallMs` is only the final ~0 ms dispatch and must never be read as the hold). Virtual time via `clock-advance` from/to. **But** there is no per-trap enqueue or dispatch-start journal event — the queue-wait vs execution split is only derivable as `(result.wallTs − trap.wallTs) − wallMs`, which is approximate (wallTs is host-ingest time, not the instant the trap was called; the residual includes C-spawn + ingest overhead). The run's submit→start wait is not in the journal at all: `queue.json` persists `enqueuedAt` (verified: `2026-11-16T14:23:42.349Z`, run started 14:23:49.958 — 7.6 s invisible in the journal), and `RunEntry` has no timestamp fields. The scheduler's `enqueuedAt` (`scheduler.ts:50`) is in-memory only. | **PARTIAL** — trap/run spans OK in v2; queue split approximate; submit→start wait GAP |
| 3 | Click-to-code — file + line of the exact code, and the frozen workflow version that ran | **No journal event carries a call site.** The `trap` event is exactly `{event, runId, trapId, ordinal, type, arg}` (`durablets.c:1213`). No `file`, `line`, or site key. The static info exists elsewhere but is not linked: `extract.ts` `SiteEntry.callSites` gives line/column per runtime key, and the extraction cache (`<stateDir>/cache/<sourceHash>.json`) pins the full `source` + `sourceHash` + `moduleHash` + `depHash` + `gate` — but the journal never records the `sourceHash`, and `RunEntry` carries `workflowPath` only, so a profiler cannot find the cache entry for a run (hashing the *current* file is only correct if the file never changed). And the runtime key cannot identify the call site anyway: `siteKeyFor` returns the bare type for every non-job trap (`extract.ts:183`), so all `exec` traps share the key `exec` — proven with `workflows/daily-ai-briefing.ts`, which has 2 exec call sites (lines 234, 441) producing 2 exec traps in the fixture journal (`trap-0` prep, `trap-8` HTML rebuild), indistinguishable by key. Job keys are per-spec but two call sites with the same spec share a key. `ordinal` is execution order, not source order — loops break any ordinal→call-site mapping. | **GAP** |
| 4 | Click-to-data — the trap's input (arg) and output (result) per span | The journal records the **full** arg on `trap` and the **full** result on `trap-result`/`trap-error` (no truncation — see above; both are JSON-clean by the boundary rule, so renderable). **But** the current profiler only carries summaries: `TrapSpan.argSummary`/`resultSummary` truncate at 120 chars (`profiler.ts` `summarizeArg`/`summarizeResult`) — the full data is in the raw events, the profiler just doesn't surface it. For job traps the worker's internal steps are not in the journal, only the job's input/output. No size budget exists on results — a multi-MB result would bloat the journal (robustness note, not a gap today). | **OK at the journal layer; profiler display GAP** — the click UI must read the raw event, not the `TrapSpan` |
| 5 | Ordering/causality — nested/attributed spans (fork → branch → trap) | `fork` + `join` (matched by `forkId`), `branch-start`/`branch-done` (matched by `parentForkId` + `branch`), runId path encoding, `lifecycle` events, `cancel` (with `trigger`/`reason`/`parentForkId`/`branch`), `gate-held` and `validation-error` linked by `trapId`, unmatched traps reported. The profiler already reconstructs the tree (`profiler.ts` `loadJournalTree`/`orderTree`/`renderTreeText`) — verified on the fresh journal: 43 events across 4 journals, branches nested under the fork, join matched, 6/6 traps matched to results. Caveats: journal reload keying is lossy (`host.ts:620` — `/` → `_` is lossy for ids containing `_`; the profiler uses the same `_fork-` filename convention, so a root runId containing `_fork-` would confuse it); branch journals are separate files assembled by filename convention, not a manifest (an unreferenced branch journal renders as "orphan"). | **OK** |

Also verified: **v1 journals have no timestamps at all.** The checked-in
briefing fixture (50 events root + 8–12 per branch) carries no `wallTs` on
any event — it predates BRA-57. The writer now stamps `wallTs` on every
event (verified 11/11 root, 12/12 branch-0 in the fresh journal) and the
suite asserts it (`tests/run-host-suite.ts:1621-1622`: "every event carries a
parseable wallTs"). The profiler treats missing fields as unknown, never
invented — so v1 journals profile as event-order only. Any profiler must
keep that rule.

Also verified: **the profiler already works end-to-end on a v2 journal.**
Running `loadJournalTree` + `profileTree` + `renderTreeText` over
`/tmp/audit-state/journals` (`audit-judges`): status completed, 43 events,
4 journals, 6 traps, 6 results, 0 errors, `totalWallMs: 77`, per-trap
`wallMs` + `adapter` shown, branches nested under the fork. What it is
today: counters + an event-order timeline (text + static HTML). What it is
not: wall-time lanes, clickable spans, or code/data drill-down.

## Minimal journal-schema changes

Exact event + field to add. Nothing else in this list is needed for the
profiler; everything else is display work or adapter work.

1. **`trap` event: add `site`** — the per-occurrence call-site identifier.
   Recommended shape: `site: {file, line, column}` captured at the call
   site in the `agentts` module wrappers via `new Error().stack` — verified
   live on the vendored engine (`~/workspace/dquickts-build-minimal/qjs`):
   `at f (/tmp/stack-test.js:1:34)` gives file:line:column. Two
   consequences to handle: (a) the stack's first frames are the wrapper's
   own — skip frames inside `agentts.ts` and take the first frame outside
   it; (b) the coordinates refer to the **bundle** (the workflow is bundled
   before the C host evals it), so the bundle + its source map must be
   pinned with the run for the profiler to translate bundle line → source
   line. Alternative: a bundle-time injection of the extractor's static
   site ID as a hidden trap-arg field (stripped by the host before schema
   validation) — same information, no stack parsing, but a bundler
   transform. Pick one; do not do both.
   - NOT sufficient alone: adding only `siteKey` (`siteKeyFor` output) to
     the `trap` event. It is many-to-one by construction (all `exec` traps
     share `exec`; proven above). It is useful as a supplement (cheap
     grouping by job kind), not as the click-to-code key.
2. **Run start: record the frozen version + submit time.** Add to the
   `lifecycle: started` event (or a new `run-started` event):
   `workflowHash` (the extraction `sourceHash`), `workflowPath`, and
   `submittedAt` (from `queue.json`'s `enqueuedAt`). The cache entry
   already holds `source`/`moduleHash`/`depHash`/`gate`; the journal only
   needs the pointer (`workflowHash`) to find it. This also fixes the
   submit→start wait (requirement 2): `started.wallTs − submittedAt`.
3. **Per-trap dispatch marker.** Add a `trap-dispatch` event
   (`{event: "trap-dispatch", runId, trapId}` — `wallTs` is stamped
   automatically), written at the top of `driveStepOnce` before
   `dispatchTrap` (`host.ts` ~1770). Then queue-wait =
   `dispatch.wallTs − trap.wallTs` and execution =
   `result.wallTs − dispatch.wallTs`, with the result's `wallMs` as the
   cross-check. One event, no other change.
4. **Worker lane: no journal schema change — an adapter change.**
   `worker` on `trap-result` is already plumbed (`host.ts:1798`) but no
   adapter sets it today (mock: never; direct: never — it spawns a process
   per job and returns `{value}` only). The pool path must return the pool
   `workerId` in the job answer so it lands on `trap-result.worker`. For
   lease/re-queue/attempt history per worker job, do **not** duplicate the
   pool log into the journal — the profiler should join
   `<stateDir>/worker-jobs/jobs.log` (`job-timeout-requeue`, `job-failed`,
   `assignedAt`/`completedAt` per attempt) and `scheduler.log` alongside
   `journals/`. Note: the pool already has a lease sweep
   (`worker-server.ts` `sweepLeases`, ~330) — the stuck-worker recovery
   exists at the pool layer; its events just don't reach the journal.
5. **No change needed:** full arg/result on `trap`/`trap-result` (already
   recorded); fork/join/branch linkage (already complete); `wallTs` on
   every event (already written in v2); virtual time via `clock-advance`
   (already recorded). `tokens` on `trap-result` exists as a field but no
   adapter reports it — an adapter gap, not a journal gap.

## Notes for the profiler build (not journal changes)

- **Three timing sources exist; the journal is the one to trust.**
  Journal `wallTs`/`wallMs` (profiler input); `cost-actuals.jsonl`
  (`CostActual {site, ms, tokens?, runId?, trapId?, ts?}` — scheduler
  input, keyed by the coarse `siteKeyFor` key, written by
  `host.ts:1784`); `worker-jobs/cost-model.json` (pool `assignedAt →
  completedAt` per spec). They measure different things (ingest-time
  spans vs dispatch time vs pool assignment time) — do not merge them
  into one number; the journal is the profiler's source of truth.
- **Display gaps in the current profiler** (code, not journal): the
  timeline axis is event order, not wall time; `TrapSpan` carries only
  120-char summaries (click-to-data needs the raw event); no call-site
  or workflow-version fields exist on `TrapSpan` (they can't — the
  journal doesn't have them — see items 1–2 above); the HTML output is
  static text rows, not an interactive timeline.
- **Do not invent timestamps for v1 journals.** The profiler's
  missing-field rule (unknown, never invented) is correct and must stay:
  the checked-in briefing fixture has no `wallTs` anywhere, and any
  lane rendering over it would be fiction.

## Real journal excerpts (evidence)

Fresh v2 journal, `/tmp/audit-state/journals/audit-judges.journal`
(run `audit-judges`, mock adapter, 2026-11-16 14:23 PST — 11 events):

```json
{"event":"lifecycle","lifecycle":"started","runId":"audit-judges","wallTs":"2026-11-16T14:23:49.958Z"}
{"event":"fork","runId":"audit-judges","forkId":"audit-judges/fork-0","kind":"all","branches":3,"failFast":false,"childRuns":["audit-judges/fork-0/branch-0","audit-judges/fork-0/branch-1","audit-judges/fork-0/branch-2"],"wallTs":"2026-11-16T14:23:49.958Z"}
{"event":"trap","runId":"audit-judges","trapId":"audit-judges/trap-0","ordinal":0,"type":"job","arg":{"op":"aggregate","verdicts":[{"ok":true,"value":"approved/verified"},{"ok":true,"value":"weak/retried"},{"ok":false,"error":{"name":"Error","message":"judge crashed"}}]},"wallTs":"2026-11-16T14:23:50.032Z"}
{"event":"trap-result","runId":"audit-judges","trapId":"audit-judges/trap-0","ordinal":0,"result":{"approved":2,"failed":1,"summary":"2 approved, 1 failed"},"adapter":"mock","wallMs":0,"wallTs":"2026-11-16T14:23:50.035Z"}
{"event":"lifecycle","lifecycle":"completed","runId":"audit-judges","wallTs":"2026-11-16T14:23:50.035Z"}
```

Branch journal, `audit-judges_fork-0_branch-0.journal` (trap-result with
dispatch time; no `worker` — mock answers carry none):

```json
{"event":"branch-start","runId":"audit-judges/fork-0/branch-0","parentForkId":"audit-judges/fork-0","branch":0,"wallTs":"2026-11-16T14:23:49.9…Z"}
{"event":"trap","runId":"audit-judges/fork-0/branch-0","trapId":"audit-judges/fork-0/branch-0/trap-0","ordinal":0,"type":"job","arg":{"op":"score","value":7},"wallTs":"2026-11-16T14:23:49.9…Z"}
{"event":"trap-result","runId":"audit-judges/fork-0/branch-0","trapId":"audit-judges/fork-0/branch-0/trap-0","ordinal":0,"result":{"score":0.92,"label":"approved"},"adapter":"mock","wallMs":43,"wallTs":"2026-11-16T14:23:50.0…Z"}
```

V1 fixture, `tests/fixtures/profiler/briefing-proof3-2026-11-16.journal`
(no `wallTs` on any of its 50 events; full arg/result, no truncation):

```json
{"event":"trap","runId":"briefing-proof3-2026-11-16","trapId":"briefing-proof3-2026-11-16/trap-0","ordinal":0,"type":"exec","arg":{"cmd":"bun","args":["workflows/briefing-prep.ts",".agentts-scratch/briefing-test-2026-11-16"]}}
{"event":"trap-result","runId":"briefing-proof3-2026-11-16","trapId":"briefing-proof3-2026-11-16/trap-0","ordinal":0,"result":{"stdout":"{\"scratch\":\".agentts-scratch/briefing-test-2026-11-16\",\"seenIds\":361,\"copied\":3}\n","stderr":"","exitCode":0}}
```

Call-site ambiguity, proven: `workflows/daily-ai-briefing.ts` has two
`exec` call sites (lines 234, 441) under the single site key `exec`, and
the fixture journal holds two `exec` traps (`trap-0` prep,
`trap-8` HTML rebuild) that no key can tell apart.

## Files cited

- `apps/agentts/src/host.ts` — `journalEvent` (596), `ingestLog` (773,
  BRA-57 enrichment 792–806), `driveStepOnce` (1740+, `wallMs` measured
  ~1770–1780, `pendingTrapMeta` 1796), `dispatchTrap` (1340+, site lookup
  1346), `prepareRun`/extraction cache (894–960), `RunEntry` (194–211,
  no hash/timestamp), `queue-started` (449), `cacheDir` (278)
- `packages/durablets/src/durablets.c` — event shapes in header (55–67),
  `durablets_emit_event` (1060, no truncation), `trap` emit (1213),
  `branch-done` emit (1560), `g_in_workflow` guard (BRA-59, in progress)
- `apps/agentts/src/profiler.ts` — time model + `TrapSpan` (1–140),
  `loadJournalTree` (orderTree, filename convention),
  `summarizeArg`/`summarizeResult` (120-char truncation),
  `profileTree` (wallMs fallback chain, gate holdMs)
- `apps/agentts/src/extract.ts` — `siteKeyFor` (178–184, bare-type
  fallback), `SiteEntry.callSites` (92–110), `extractWorkflow` cache
  (`cacheDir/<sourceHash>.json`, 687–760), `WorkflowEntry` (entry
  function, bra29.3)
- `apps/agentts/src/gate.ts` — `CHECKER_VERSION bra29.3`, cache trust
  rules
- `apps/agentts/src/cost-model.ts` — `CostActual` (42–51, separate
  `cost-actuals.jsonl`, not the journal), `site` is the coarse runtime key
- `apps/agentts/src/scheduler.ts` — `enqueuedAt` in-memory only (50)
- `apps/agentts/src/worker-server.ts` — `sweepLeases` (~330),
  `worker-jobs/jobs.log` + `scheduler.log` (20–40), cost-model.json (179)
- `apps/agentts/src/adapters/direct-adapter.ts` — job answer is
  `{value}` only, no `worker` (110)
- `apps/agentts/tests/run-host-suite.ts:1621-1622` — suite asserts every
  disk-journal event carries a parseable `wallTs`
