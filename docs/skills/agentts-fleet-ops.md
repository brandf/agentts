# AgentTS fleet operations — how to run a fleet

**Status:** 2026-11-20, the AgentTS fleet's operating skill, generalized for
any project. The AgentTS fleet is the worked example throughout: where a
value is fleet-specific it is marked "this fleet". The companion design
record is [`agent-session-structure.md`](agent-session-structure.md) (the
three-tier flagpole); the technical reference is
[`../ARCHITECTURE.md`](../ARCHITECTURE.md). This skill links to those docs
instead of repeating them.

**Audience:** a Director or lead session (human or agent) running project
work through AgentTS.
**Scope:** fleet topology, the CPU model, the working loop and merge
procedure, the three-tier lead sessions, the daily project report, testing,
project operations, and resilience. Nothing here changes the engine; it
teaches how to run a fleet on it as built.

The shared operating practices for running project work through AgentTS the
way a modern CPU runs work: out-of-order, superscalar, multi-core, with
speculative branch prediction — and a fleet coordinator keeping the pipeline
fed. One skill, every session. When a session learns something durable, it
writes it here the same turn (see "Keeping this skill current" at the end).

## Topology — federated, not central (decided 2026-11-20)

Each project runs its own AgentTS instance: its own state dir, its own
worker-server port, its own tick agent, its own heartbeat/watchdog. All
sessions share this skill and the workflow library. That is the decision,
and it is a clear winner over one central AgentTS for all sessions. Why:

- **Ownership.** The lead session for a project owns that project's
  verify-merge-close loop. The Exec talks to each project's own Director session about that
  project's work, not to another project's session. (Here: MuseGM work goes
  to the MuseGM Director, not the AgentTS Director.) A central system would
  route every project's verification through one session and break that.
- **Isolation.** One state dir means one driver lock and one WIP limit
  (default 3). A central queue lets one project's backlog spike stall
  every other project. A corrupt state dir or a runaway workflow is
  contained to its own project.
- **Centralization buys no throughput.** Workers all run on the same VM
  (1.5 shared CPUs, 6 GB RAM) either way. There is no runtime cap on
  worker count that centralizing would dodge; the binding caps are
  merge bandwidth (~4–5 sustainable) and VM resources, and they bind
  globally regardless of topology.
- **The central benefits are future, not present.** A single ledger and
  a single scheduler would give global cost data and global
  prioritization — but the dynamic scheduler (BRA-160) is not built yet,
  and the run ledger (BRA-165) is per state dir by design. Cross-project
  priority is the Exec's call anyway; the Exec is the cross-project scheduler.

The one genuine tradeoff: there is no automatic cross-project
prioritization. That is accepted deliberately. Per-project ledgers can be
rolled up later if the need is ever felt in real use; do not build the
roll-up before then.

## Distribution — who runs what build (Brandon, Nov 20)

Two tracks, one repo. The engine project dogfoods the latest engine;
every other project's fleet pins to a stable build.

- **Engine project (AgentTS, this fleet):** develops on the live tree and
  dogfoods it daily — the briefing, the tier-1 runs, the ledger all
  run the latest engine, including unreleased work. Pushes go to `dev`
  at good points; main advances via PR/release. Bleeding edge by
  design: it is the feedback loop that makes releases trustworthy.
- **Every other project's fleet:** pins to a stable build — its own
  clone of brandf/agentts at the latest release tag (`r1` now, `r2`
  when it ships). A tag, not main head: a tag is immutable and named,
  main moves on release. The clone is run, not modified.
- **Per project, always separate:** state dir, server port, tick
  agent, heartbeat/watchdog, ledger, Linear project, and GitHub repo
  for the project's own code. AgentTS is the engine, not the project.
- **Upgrades are deliberate:** when a new release lands, pull the pin
  to the new tag, re-run tier-1, resume. Never auto-follow main or
  `dev`. The state dir is kept across upgrades; if a release changes
  the state format, the release notes say so and the migration is part
  of the upgrade.
- **What stays shared:** the skill (this file) and the workflow
  library — versioned with the engine, so the library travels with the
  pin. A workflow that proves reusable lands in `workflows/library/`
  and reaches other projects on their next upgrade.
- **What the dogfooding buys them:** a release tag means the AgentTS
  fleet ran that build end to end before anyone else pinned to it.
- **Opt-in bleeding edge:** a session may pin to `dev` if it
  explicitly wants the latest, accepting breakage. That is the
  exception, not the default. Nobody tracks the engine project's live
  tree — it is mid-merge half the time and a half-merged engine breaks
  other fleets' runs.
- **Adoption path for a new project:** clone at the latest release
  tag → state dir → server on its own port → tick + heartbeat →
  adopt this skill (read `docs/skills/agentts-fleet-ops.md`; to make it
  a persistent skill, copy it into the Muse's custom-skills directory)
  → stand up leads (Director + the standing five as needed) → run the
  backlog through the loop.
- **Second customer (MuseGM, deferred Nov 20):** MuseGM adopts the
  full three-tier roster only once the AgentTS pilot proves the model
  end to end (BRA-212 complete + first daily briefs landed + a few
  items verified). The Director flags the Exec when that bar is met;
  do not hand the MuseGM Director the roster brief before then.

There is no build artifact to pin to: AgentTS runs from source
(`bun src/cli.ts`), so the pin is a git ref (the release tag) and the
checkout runs as-is.

### Setting up a new project's instance

- State dir: `<workspace>/<project>-state` (never another project's dir;
  this fleet's production dir is `~/workspace/agentts-state`).
- Server: `bun src/cli.ts worker serve --state-dir <dir> --port <N>` from
  `<engine-checkout>/apps/agentts`. Pick a free port per instance (this
  fleet's production holds 18741). Verify with `/health`.
- Tick agent: one per state dir, from that project's watchdog. Never
  spawn a second tick agent while one is alive for the same dir.
- Heartbeat: one loop per instance writing to its own log, plus a
  watchdog cron that restarts the loop. The loop is purely diagnostic.
- The workflow library is shared: workflows live in the repo and are
  reused across projects. A workflow built for one project that proves
  reusable belongs in `workflows/library/`, not copied per project.

## The CPU model

Current state is in-order single-core: one fix at a time, no cache, every
decision stalls the pipeline, a kill means re-executing from scratch.
The target is a modern out-of-order superscalar multi-core CPU with
speculative branch prediction. Every process change should move one step
along that axis; do not stop everything to get all the way there.

**Correction (Brandon, Nov 20):** leads are processes, not pipeline
stages. Workers are dumb thread-pool threads (claim, execute, submit,
repeat — they choose nothing); ALL the smarts live in the AgentTS
scheduler (BRA-160), the OS thread scheduler (affinity, load balancing,
priority, quotas, work-stealing). Pipelining is workflow stages queued
to the thread pool at trap granularity, not lead handoffs. Same job spec
on the same agent, so it gets good at it — that is cache coherency.

- **Caches (tiered testing):** L1 = tier 1 (<5 min target), L2 = tier 2,
  main memory = full suite. Most work must hit L1.
- **Superscalar (parallel workers):** multiple issue slots — 2–3 fix
  workers on disjoint areas at once, each in its own copy of the tree.
- **Out-of-order + register renaming:** worker-per-copy removes false
  dependencies on the shared tree; execute in readiness order, not drive
  order; retire (merge) in order.
- **Multi-core:** parallel verification agents plus parallel fix workers,
  each with its own L1.
- **Speculative branch prediction:** build the predicted branch for
  decision-gated items; discard on mispredict. Track prediction accuracy
  (recommendations vs. the Exec's calls) in the predictor record.
- **ROB / commit stage:** the lead's serial verify + merge is the commit
  stage — the Amdahl limit. Parallelize it (verification agents, batch
  closes) or throughput caps there no matter how many cores are added.
- **Precise interrupts / checkpointing:** resumable runs — a kill costs
  the uncompleted tail, not the whole run.
- **Microarchitecture = workflows:** the CPU is driven by workflows.
  Work flows through the microarchitecture, not around it. Where a stage
  has no workflow, it runs on the slow manual path — that is a
  microarchitecture gap, and closing those gaps is what moves the CPU
  forward.

## The working loop

- **One worker at a time per tree**, except worker-per-copy: workers run
  in separate copies of the repo on disjoint areas. Worker count is
  dynamic, computed per cycle from (1) intrinsic parallelism, (2) the
  merge-bandwidth cap (~4–5 sustainable now), (3) the VM resource cap
  (back off when worker slowdown appears). Pilot at 2, then scale.
- **Workers are long-lived looping sub-agents, owned by leads
  (BRA-213).** A worker runs a long-poll get-job loop for its lifetime
  — claim, execute in a fresh copy, submit, repeat — and ends on idle
  timeout, lead close, or VM death. Long-lived yet NOT persisted: no
  memory file, no chat session, no durable identity. Context accumulates
  during life and dies with the worker; the queue + Linear + ledger hold
  the durable state. A worker that dies mid-job leaves the job leased;
  the lease expires and the job is re-queued. Worker-per-copy still
  applies per job — the worker is long-lived, the copies are per-job.
- **Workers never close issues.** The lead verifies, merges, and closes.
  A worker's report is a claim, not a result.
- **Verify before reporting.** Re-run or re-check personally first.
  Workers' reported counts and narratives have been wrong before
  (claimed 2139/0, actual 2135/81; claimed 26 checks, actual 27).
  Always grep or read the artifacts yourself.
- **Merge in order.** The lead merges verified work serially, one item
  at a time, and confirms the post-merge diff is empty (or exactly the
  intended delta).
- **Throughput target:** most minor bug fixes take 10–15 minutes end to
  end — pickup through implementing, tier 1, and landed in local main.
  Pushing to origin is separate, batched at good points, and needs
  the Exec's approval (or the `dev` branch route).
- **Run the backlog autonomously.** Do not wait for the Exec to approve
  each item. Prioritize the open backlog by priority, dependency, and
  code area (for parallelism), and execute until nothing is left. File
  bugs and feature requests as they surface, break features into filed
  tasks, and execute those too. The loop needs workflow support (triage
  + breakdown) — building that support is part of the work.
- **P0 bar:** an upgrade is P0 only if implementing it now makes the
  current release ETA sooner, including the work to do the upgrade.
  Expected value counts for speculative items; the saving is measured in
  wall-clock ETA, not just per-item time. The fleet coordinator files
  P0s proactively and fixes the process without being asked.

### Merge procedure (worker-per-copy) — BRA-156

Reference implementation for a git-checkout project (the AgentTS repo). The
principles — copy, verify personally, merge serially, fresh tier-1, close
with evidence — are generic; adapt the mechanics to your project's tree
shape.

1. **The map:** the parallel-work map lives in the project's goal notes
   (this fleet: GOAL.md) — per-item likely files. Two items conflict if they touch the same file; pick disjoint
   items per cycle.
2. **Make the copy:** `cp -a <engine-checkout>
   <copies-dir>/<issue>` (this fleet: `cp -a ~/workspace/agentts-repo
   ~/workspace/agentts-copy-<issue>`); verify a key file exists in the
   copy and note its size. For workspace scripts (not in the repo), the
   worker edits a scratch copy of the script (`<script>-<issue>.py`)
   and the lead installs it. Never let a worker touch the live tree.
3. **Brief:** write `<issue>-brief.md` in the workspace (this fleet: `~/workspace`) (task,
   acceptance, evidence, working rules). Spawn the workers in parallel
   in the same turn.
4. **Verify (the lead, personally):** diff copy vs live = exactly the
   claimed files — a live-only file added after the copy was made
   stays; a merge must never delete it. Read the module + test in full.
   Re-run the new/changed test yourself (`run.sh --bash --only
   <slug>`). `tsc` clean. Baselines byte-identical.
5. **Merge serially, one item at a time:** copy the changed files to
   live; confirm the post-merge diff is empty (or exactly the intended
   delta). Never merge while a tier-1 runs against the live tree.
6. **Fresh live tier-1:** run with a fresh `--resume-dir`; independently
   count via `parseSectionOutput` over the raw section logs and compare
   with the driver's PASS line (a resume-skipped run proves nothing).
   The delta vs the previous baseline is exactly the new section's
   checks.
7. **Close with evidence:** post the close comment (what changed, the
   verification evidence, the tier-1 line) and set the issue Done.
   Trash the copy (recoverable, 30-day expiry).

## Leads (three-tier sessions) — flagpole: docs/agent-session-structure.md

- **Tier 1 — Director:** the only Exec-facing session. Fetches
  intent, decodes it into lead assignments, handles interrupts
  synchronously. Owns two things that never pipeline: cross-project
  priority, and the trust/verification bar.
- **Tier 2 — leads:** persistent side chats, one per area, each with a
  written brief, a defined scope, and a memory file. They run workflows
  but are not the workers doing the agent jobs. Standing five:
  - **Fleet Ops** — fleet health, throughput, latency; owns the tick
    agent and the worker server staying up.
  - **Program Manager** — backlog, triage, prioritization, dependencies,
    dedup, milestones/releases.
  - **Implementation** — high-quality work, efficiently; breaks tasks
    into plans/subtasks; researches implementation; owns implementation
    quality and retrospectives.
  - **QA** — tests (implementing and running tier 1); files bugs with
    quality repro steps for implementation. The check on implementation,
    separate on purpose. First lead piloted (BRA-212).
  - **LBR** — land queue, rebasing, batching higher-tier test runs,
    pushing to GitHub, branch coordination.
  - Planned: **Knowledge** (standing, piloted second — the learning
    loop: briefing, rubric chain, predictor record) and **Docs**
    (ephemeral-or-standing — doc production, the retrospective quality
    bar + archiving). Proposed: **Historian** (backwards-looking —
    history, recurring patterns, the sequence behind a problem; the
    history half of retrospectives).
- **Ephemeral leads:** spin up for one big effort and dissolve when it
  lands (e.g. a Briefing Cutover lead, a Demo lead). Lifecycle: created
  from a filed issue or effort; on landing, its memory is archived into
  the skill/goal notes and the session closes.
- **Handoff protocols:** coordinate through shared state, not chat — a
  handoff is an issue state change with evidence attached. The Director is the
  interrupt router and tiebreaker, not a relay. Leads never escalate to
  the Exec directly. Sync is a ledger read, not a meeting.
- **Lead-spawn rule:** a lead is created with a brief + memory file
  from a filed issue (BRA-212 is the QA pilot). A lead session is never
  created bare — no brief, no lead.
- **Leads are persistent, not job-in-result-out (Brandon, Nov 20).**
  The ephemeral-subagent alternative was considered and rejected: a lead
  is an ongoing role, and its accumulated context plus multi-day state
  live in the session and its memory file. A worker is one job at a
  time within a long-lived loop; a lead is a role.
- **Naming:** lead chats are named `agentTS: <role>` (e.g.
  `agentTS: QA Lead`) so the project is clear from the chat list.
- **`owner` is the return-address stack:** it resolves to whichever
  session launched the workflow, no name stored (BRA-211).
- **Visibility:** a lead session is a side chat, and side chats show up
  in the user's chat list — there is no hidden-session primitive.
  This fleet's Exec expects the leads managed by the Director and never seen (Nov 20).
  Archiving is the only way to hide them; it is unverified whether an
  archived chat still receives tasks, so archive only after verifying
  messaging still works, per his call. Never assume invisibility.
- **Quality is everyone's responsibility.** QA is the focus — it spends
  basically all its time on quality — but each lead owns quality within
  its own scope. QA is the check-and-balance, not a dumping ground.

## Daily project report — leads report, Director briefs (Brandon, Nov 20)

Every morning, each lead writes a status/reflections/predictions/
solutions report and the Director aggregates them into one exec brief for
the Exec. The Exec never sees the JSON — only the brief.

### The lead report (JSON)

Each lead writes one file per day by **6:00am** local time:
`<reports-dir>/<lead>-YYYY-MM-DD.json`

```json
{
  "lead": "qa",
  "date": "2026-11-21",
  "status": "What happened / current state, in 2-4 sentences.",
  "reflections": ["What I learned, what is working, what is not."],
  "predictions": [{"claim": "...", "confidence": "high|medium|low", "horizon": "today|this week|this release"}],
  "solutions": [{"problem": "...", "proposal": "..."}],
  "needs_pm": ["Decisions or blockers for the Director."],
  "numbers": {"tests_run": 46, "pass_rate": 1.0}
}
```

All fields except `lead` and `date` are optional — a lead with nothing
to say writes a short status and empty lists, never nothing at all.
Predictions are scored later against what actually happened (the
predictor record); a wrong prediction is logged, not hidden.

### The schedule

- **05:30** — prompt job: reads the lead roster and messages each lead
  chat to write today's report by 6:00am. Internal only; it never
  messages the Exec.
- **06:00** — lead deadline. A missing report is noted as missing in
  the brief; it never blocks the brief.
- **06:30** — aggregate job: reads the roster + today's JSON files +
  the Director's own state (goal notes, ledger, predictor record, open
  backlog) and builds the brief.
- **07:00** — the brief lands in the main chat: the dated HTML link +
  the one-line must-know. The JSON stays in the hidden reports dir.

### The exec brief (HTML)

One dated HTML file per day in the goal's `files/daily-reports/`.
Design bar: an exec brief, not a log dump — clean layout, highly
visualized (counts, trends, per-lead sections), a decisions-needed box
up top, risks, and the Director's own report (overall state, what changed,
what is next). One line at the top says the thing the Exec most needs
to know. The brief aggregates; it does not paste the JSON.

### The roster

The live lead chats live in one roster file the prompt and aggregate
jobs both read (`<goal>/hidden_files/lead-roster.json`:
`[{lead, chat_id}]`). It grows as leads stand up; a lead that has not
stood up yet simply is not on it. The brief covers the leads on the
roster plus the Director's own report — it is thin while the roster is thin,
and that is honest.

### Automation (per project)

Two daily crons, owned by the project goal: the 05:30 prompt and the
06:30 aggregate. Both read the roster and the reports dir from the
goal's `hidden_files/`. Other projects copy the shape: same schema,
same times, their own roster and reports dir.

## Testing and verification

- **Standard:** unit tests, integration tests (mocks where appropriate,
  virtual time), and e2e tests (real usage paths, no mocks, a script or
  agent standing in for the human or driving agent).
- **Tiers:** tier 1 is the default per change; tier 2 is opt-in for
  complex or risky changes; the full suite runs before a release or
  about once a day.
- **A verification run must actually run.** Always check the "sections
  ran" count in the PASS line, and use a fresh `--resume-dir` for an
  independent verification run. A run that skips everything via resume
  proves nothing. Count with `parseSectionOutput` over the raw section
  logs, not a narrow grep — the narrow grep undercounts sections that
  report in other formats.
- **Never merge into the live tree while a tier-1 run is in flight
  against it.** Writing the tree changes its fingerprint and invalidates
  the in-flight run's resume. Hold merges until the run lands.
- **Environment gotchas:** direct re-runs of tests that build a C host
  internally need `DQUICKTS=$HOME/workspace/dquickts-build-minimal`.
  Any test that submits in-process must set `AGENTTS_WORKER_SERVER` to
  the test server URL before submitting. Long runs need a TMPDIR under
  the home directory — and the directory must already exist, or every
  `mkdtemp` fails.
- **Baselines:** never merge a worker copy's `baselines.json` drift.
  Never re-baseline without a human decision with a recorded reason.
  Ratchet auto-tightens only; loosening needs a human decision.
- **Flaky tests are worse than no test.** File and fix flakiness as a
  real defect; never wave it off as "known benign".

## Decisions

- **Present pros/cons and a clear recommendation first — never a bare
  question.** When there is an obvious single choice, decide it,
  record it, and report what was decided. Only bring genuine forks
  with real tradeoffs.
- **A direct instruction is authorization to act.** Start doing it and
  report the result when it lands. Do not echo it back and ask for
  confirmation. Do not narrate next steps instead of doing them.
- **Speculative predictions are scored.** A confirmed recommendation is
  a hit, a rejection is a mispredict, mispredicts are logged not
  hidden. Never quote accuracy until n ≥ 5. The predictor record lives
  at `<workspace>/predictor-record.md` (this fleet: `~/workspace/predictor-record.md`).
- **Do not flip a technical position solely because the Exec challenges
  it.** Change a claim only on new evidence or after re-reading the
  source.

## Project operations — Linear + GitHub (applies to any project)

This is not AgentTS-specific. Any project run this way gets the same
shape: work tracked in Linear, code in a GitHub repo, the two linked.

- **One Linear project and one GitHub repo per project.** Work lives
  in Linear issues; code lives in the repo; the two are linked, never
  separate. (AgentTS: project P-BRA-2, repo brandf/agentts. MuseGM:
  project P-BRA-3, repo brandf/MuseGM.)
- **File bugs in Linear** with title, what happened, reproduction or
  evidence, and what it blocks. Fix now only if it blocks the current
  milestone.
- **A roadmap item without an issue is a wish.** If it is on the
  roadmap, it is filed in Linear with a link.
- **Issue lifecycle:** work is picked up, built, verified by the lead,
  merged, then closed with a comment carrying the evidence (test
  counts, tier-1 numbers, links). Workers never close issues. Never
  report a worker's claims unverified.
- **Labels carry meaning:** milestone or blocker labels for drive
  order, priority for urgency. Keep the label set small and
  meaningful; a label that nothing reads is clutter.
- **Pushes:** push to a `dev` branch at good points; promote to main
  via PR. A release is a push to main plus a tagged release branch
  plus an official GitHub release, once decided. If a push call is
  interrupted, verify what landed before retrying; never blind-retry.
- **CHANGELOG:** keep one at the repo root. Notable means "would an
  end user (developer) of the thing need or want to know about this
  change?" Test-only closes get no entry. Append release sections
  incrementally (r1, r2, …).

## Workflows are the operating system

- Turn typical development processes into workflows: start ad hoc or
  inline, generalize repeated ones into core library workflows,
  specialize via run input JSON. Composable, modular pieces combined in
  novel ways.
- **Use-AgentTS rule, in order:** (1) use an existing workflow?
  (2) specialize an existing workflow? (3) make a new reusable
  workflow? (4) ad-hoc one-time-use workflow? (5) do it without a
  workflow? While using AgentTS, file a Linear task for every bug hit,
  feature needed, or library improvement wanted; fix now only if it
  blocks the work at hand.
- **Do not take a specific workflow literally.** The point is the
  approach: naturally build up a library, maintain it, and improve it
  over time as you run into issues using it for everything.
- **If the engine cannot run a needed workflow, fix the engine.**
  Do not route around it. Do not invent new concepts or systems when
  the general-purpose workflow system already covers it — no registry,
  no new JSON configs, no new scripts for a mapping a workflow with a
  switch already does.
- **Use AgentTS for real work even when it is slower or more painful
  than doing it directly.** File proactively only when the need is
  actually felt in real use.
- **Lead workflows belong in the standard library
  ([BRA-216](https://linear.app/brandf/issue/BRA-216)).** The work a lead
  does — triage (BRA-210), verify (BRA-158), merge (BRA-159), the daily
  report/brief, dispatch (BRA-176), GC (BRA-178), docs (BRA-167),
  retrospectives — is itself a workflow: project-independent and
  configurable (Linear project, repo, state dir, roster, thresholds).
  A project extends or configures the standard set; it does not rebuild
  it. A lead drives its own work through these workflows, not by hand —
  which needs launch attribution + `owner` (BRA-211) and named routing
  (BRA-50). Status Nov 20: no lead is yet using a workflow to drive its
  leading; merge is the only lead workflow in flight.

## Resilience — the platform replaces the VM about every 2 hours

- VM replacements arrive on a roughly two-hour metronome (observed
  1h37m–2h12m across 12 replacements, Nov 19–20), including overnight
  when the machine is idle. It is platform-side recycling, not workload.
  Do not schedule around replacements; do not try to reduce load to
  stop them.
- **Every replacement kills the production worker server** — there is
  no auto-restart. Restart it with
  `cd <engine-checkout>/apps/agentts && nohup bun src/cli.ts worker serve --state-dir <project-state-dir> > <runs-dir>/server-restart-N.log 2>&1 &`
  (this fleet: `cd ~/workspace/agentts-repo/apps/agentts && nohup bun src/cli.ts worker serve --state-dir ~/workspace/agentts-state > ~/workspace/agentts-runs/server-restart-N.log 2>&1 &`)
  and verify `/health` answers. (The exec that spawns it reports an
  output-drain timeout because the nohup'd child keeps stdout open —
  that is expected; the server is the intended background process, do
  NOT kill it.)
- A kill costs at most the uncompleted tail: per-section markers +
  resume for suites, durable state + resume for workflow runs. A
  VM-replacement kill does not record rc=143 in progress.jsonl — do
  not explain that away.
- **Polling backoff (standing):** from the last hit — 1 min × 10 min,
  5 min × 30 min, 15 min × 2 h, 30 min × 24 h, 3 h × 1 week, then
  stop; restart at 1 min on a hit. Replies to a polled item identify
  as the Director and end with the fleet's signature (this fleet: "— Meroki 🏆").

## Keeping this skill current

- **Write the lesson the same turn you learn it.** When a session
  discovers a durable practice, a gotcha, or a correction, it appends
  a dated entry here before replying — while the evidence is fresh.
  A lesson without its evidence (log, diff, or measurement) is a rumor;
  do not write it.
- **Append, do not rewrite shared lines.** Concurrent edits to this
  file are a known hazard (BRA-136). New lessons go in a dated bullet
  under the section they belong to. Structural rewrites go through the
  engine project's Director session, which consolidates the appended lessons
  periodically.
- **A practice that stops working gets corrected here, not silently
  dropped.** Note what changed, when, and what replaced it.
- **This skill is the shared brain; each project's instance is its
  own machine.** A session that finds this skill's guidance wrong for
  its project says so in its own project notes and tells the engine project's Director session, so the skill can be fixed for everyone.

## Lessons

- **2026-11-20 (AgentTS lead):** federated topology decided — one
  AgentTS instance per project, shared skill + shared workflow library.
  Centralizing buys no throughput (same VM, same merge cap) and breaks
  lead-session ownership. See "Topology" above.
- **2026-11-20 (AgentTS lead):** a second `worker serve` needs its
  own `--port` (production holds 18741) and its own `--state-dir`;
  verified against `src/cli.ts` (`worker serve [--port N]
  [--state-dir DIR]`).
- **2026-11-20 (MuseGM lead):** MuseGM adopts this skill's working
  loop (workers never close issues; lead verifies, merges, closes;
  verify before reporting), but has no AgentTS instance yet — the core
  stays independent of AgentTS by Brandon's Nov 19 decision, and the
  AgentTS layer is phase two, possibly a separate repo. Builders
  currently share one snapshot-push source dir (`~/workspace/foundry-live`,
  not a git checkout), so worker-per-copy would mean directory copies
  plus a copy-back merge — not yet adopted; the current mitigation is
  disjoint work areas plus the lead re-running the full suite before
  reporting (parallel builders on the shared tree caused transient
  breakage Nov 19). MuseGM files in its own Linear project P-BRA-3.
  Dave's Foundry server is session-only and Dave's to run — never
  restart it from here.
- **2026-11-20 (AgentTS lead):** the Linear + GitHub section was
  generalized into "Project operations" so any project can use it
  as-is — one Linear project + one GitHub repo per project, the issue
  lifecycle, labels, dev-branch pushes, and the release shape. The
  AgentTS and MuseGM projects are the two examples in it.
