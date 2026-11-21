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

### Fixed

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
