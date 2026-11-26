# AgentTS fleet operations — how to run a fleet

**Status:** the AgentTS fleet's operating skill, written for any
project. The AgentTS fleet is the worked example throughout: where a
value is fleet-specific it is marked "this fleet". The companion design
record is [`agent-session-structure.md`](agent-session-structure.md) (the
four-tier flagpole); the technical reference is
[`../ARCHITECTURE.md`](../ARCHITECTURE.md). This skill links to those docs
instead of repeating them.

**Audience:** a Director or lead session (human or agent) running project
work through AgentTS.
**Scope:** fleet topology, the CPU model, the working loop and merge
procedure, the four-tier session structure, the daily project report, testing,
project operations, and resilience. Nothing here changes the engine; it
teaches how to run a fleet on it as built.

The shared operating practices for running project work through AgentTS the
way a modern CPU runs work: out-of-order, superscalar, multi-core, with
speculative branch prediction — and a fleet coordinator keeping the pipeline
fed. One skill, every session.

## Topology — federated, not central

Each project runs its own AgentTS instance: its own state dir, its own
worker-server port, its own tick agent, its own heartbeat/watchdog. All
sessions share this skill and the workflow library. That is the decision,
and it is a clear winner over one central AgentTS for all sessions. Why:

- **Ownership.** The lead session for a project owns that project's
  verify-merge-close loop. The Exec talks to each project's own Director session about that
  project's work, not to another project's session. (For example: one
  project's work goes to that project's Director, not another project's
  Director.) A central system would route every project's verification through one session and break that.
- **Isolation.** One state dir means one driver lock and one WIP limit
  (default 3). A central queue lets one project's backlog spike stall
  every other project. A corrupt state dir or a runaway workflow is
  contained to its own project.
- **Centralization buys no throughput.** Workers all run on the same VM
  (the VM's resources) either way. There is no runtime cap on
  worker count that centralizing would dodge; the binding caps are
  merge bandwidth (~4–5 sustainable) and VM resources, and they bind
  globally regardless of topology.
- **The central benefits are future, not present.** A single ledger and
  a single scheduler would give global cost data and global
  prioritization — but the dynamic scheduler is not built yet,
  and the run ledger is per state dir by design. Cross-project
  priority is the Exec's call anyway; the Exec is the cross-project scheduler.

The one genuine tradeoff: there is no automatic cross-project
prioritization. That is accepted deliberately. Per-project ledgers can be
rolled up later if the need is ever felt in real use; do not build the
roll-up before then.

## Distribution — who runs what build

Two tracks, one repo. The engine project dogfoods the latest engine;
every other project's fleet pins to a stable build.

- **Engine project:** develops on the live tree and dogfoods it daily — the briefing, the tier-1 runs, the ledger all run the latest engine, including unreleased work. Pushes go to `dev` at good points; main advances via PR/release. Bleeding edge by design: it is the feedback loop that makes releases trustworthy.
- **Every other project's fleet:** pins to a stable build — its own clone of the engine repo at the latest release tag. A tag, not main head: a tag is immutable and named, main moves on release. The clone is run, not modified.
- **Per project, always separate:** state dir, server port, tick agent, heartbeat/watchdog, ledger, Linear project, and GitHub repo for the project's own code. AgentTS is the engine, not the project.
- **Upgrades are deliberate:** when a new release lands, pull the pin to the new tag, re-run tier-1, resume. Never auto-follow main or `dev`. The state dir is kept across upgrades; if a release changes the state format, the release notes say so and the migration is part of the upgrade.
- **What stays shared:** the skill (this file) and the workflow library — versioned with the engine, so the library travels with the pin. A workflow that proves reusable lands in `workflows/library/` and reaches other projects on their next upgrade.
- **What the dogfooding buys them:** a release tag means the AgentTS fleet ran that build end to end before anyone else pinned to it.
- **Opt-in bleeding edge:** a session may pin to `dev` if it explicitly wants the latest, accepting breakage. That is the exception, not the default. Nobody tracks the engine project's live tree — it is mid-merge half the time and a half-merged engine breaks other fleets' runs.
- **Adoption path for a new project:** clone at the latest release tag → state dir → server on its own port → tick + heartbeat → adopt this skill (read the skill file; to make it a persistent skill, copy it into the Muse's custom-skills directory) → stand up leads (Director + the standing five as needed) → run the backlog through the loop.

There is no build artifact to pin to: AgentTS runs from source (`bun src/cli.ts`), so the pin is a git ref (the release tag) and the checkout runs as-is.

### Setting up a new project's instance

- State dir: `<workspace>/<project>-state` (never another project's dir).
- Server: `bun src/cli.ts worker serve --state-dir <dir> --port <N>` from `<engine-checkout>/apps/agentts`. Pick a free port per instance. Verify with `/health`.
- Tick agent: one per state dir, from that project's watchdog. Never spawn a second tick agent while one is alive for the same dir.
- Heartbeat: one loop per instance writing to its own log, plus a watchdog cron that restarts the loop. The loop is purely diagnostic.
- The workflow library is shared: workflows live in the repo and are reused across projects. A workflow built for one project that proves reusable belongs in `workflows/library/`, not copied per project.

## The CPU model

Current state is in-order single-core: one fix at a time, no cache, every
decision stalls the pipeline, a kill means re-executing from scratch.
The target is a modern out-of-order superscalar multi-core CPU with
speculative branch prediction. Every process change should move one step
along that axis; do not stop everything to get all the way there.

**Leads are processes, not pipeline stages.** Workers are dumb thread-pool threads (claim, execute, submit,
repeat — they choose nothing); ALL the smarts live in the AgentTS
scheduler, the OS thread scheduler (affinity, load balancing,
priority, quotas, work-stealing). Pipelining is workflow stages queued
to the thread pool at trap granularity, not lead handoffs. Same job spec
on the same agent, so it gets good at it — that is cache coherency.

- **Caches (tiered testing):** L1 = tier 1 (set a time budget for it; this fleet: <5 min), L2 = tier 2, main memory = full suite. Most work must hit L1.
- **Superscalar (parallel workers):** multiple issue slots — 2–3 fix workers on disjoint areas at once, each in its own copy of the tree.
- **Out-of-order + register renaming:** worker-per-copy removes false dependencies on the shared tree; execute in readiness order, not drive order; retire (merge) in order.
- **Multi-core:** parallel verification agents plus parallel fix workers, each with its own L1.
- **Speculative branch prediction:** build the predicted branch for decision-gated items; discard on mispredict. Track prediction accuracy (recommendations vs. the Exec's calls) in the predictor record.
- **ROB / commit stage:** the lead's serial verify + merge is the commit stage — the Amdahl limit. Parallelize it (verification agents, batch closes) or throughput caps there no matter how many cores are added.
- **Precise interrupts / checkpointing:** resumable runs — a kill costs the uncompleted tail, not the whole run.
- **Microarchitecture = workflows:** the CPU is driven by workflows. Work flows through the microarchitecture, not around it. Where a stage has no workflow, it runs on the slow manual path — that is a microarchitecture gap, and closing those gaps is what moves the CPU forward.

**Preemptive multitasking, not serial.** Today the landing pipeline is serial: one item at a time through build → verify → land, and the next item's builder is assigned only the moment the current item lands. Priming overlaps, but the actual build/verify/land does not. That is the DOS / cooperative-multitasking shape, and it is not the engine's shape. A workflow handling a task end to end can pause and resume over days/weeks — the queue + Linear + ledger hold the durable state, not the agent's head — and the scheduler time-slices stages at trap granularity. The engine is the preemptive kernel: it does the coordination, so juggling multiple in-flight issues is the engine's job, not the agents', and it is not a coordination nightmare. The one genuinely serial step is the landing itself — one live tree, the disk write; two merges into the same tree at once would conflict, and the merge workflow refuses conflicts. Everything else can overlap: the next item's build starts while the current item is in Quality/merge, for items whose changes are disjoint from the current item's (the merge's conflict check refuses true overlaps — a file changed differently in both copy and live classifies as "conflict" and refuses the whole merge). The constraint is the tier-1: it is the CPU-bound stage — two full tier-1 runs at once serialize badly on the VM's shared resources — so overlapping builds are viable once the re-tiering lands (a fast/scoped tier-1 on the critical path), or the overlap is limited to the build + standalone-test stages, which do not run a full tier-1.

## The working loop

- **One worker at a time per tree**, except worker-per-copy: workers run in separate copies of the repo on disjoint areas. Worker count is dynamic, computed per cycle from (1) intrinsic parallelism, (2) the merge-bandwidth cap (~4–5 sustainable now), (3) the VM resource cap (back off when worker slowdown appears). Pilot at 2, then scale.
- **Workers are long-lived looping sub-agents, owned by leads.** A worker runs a long-poll get-job loop for its lifetime — claim, execute in a fresh copy, submit, repeat — and ends on idle timeout, lead close, or VM death. Long-lived yet NOT persisted: no memory file, no chat session, no durable identity. Context accumulates during life and dies with the worker; the queue + Linear + ledger hold the durable state. A worker that dies mid-job leaves the job leased; the lease expires and the job is re-queued. Worker-per-copy still applies per job — the worker is long-lived, the copies are per-job.
- **Workers never close issues.** The lead verifies, merges, and closes. A worker's report is a claim, not a result.
- **Verify before reporting.** Re-run or re-check personally first. Workers' reported counts and narratives have been wrong; always re-check by reading the artifacts yourself.
- **Merge in order.** The lead merges verified work serially, one item at a time, and confirms the post-merge diff is empty (or exactly the intended delta).
- **Latency target:** set a latency target for your fleet (this fleet: most minor bug fixes take 10–15 minutes end to end — pickup through implementing, tier 1, and landed in local main). Pushing to origin is separate, batched at good points, and needs the Exec's approval (or the `dev` branch route).
- **Latency and throughput are two different bars.** The latency target is per-task latency; the throughput bar is throughput (this fleet: 10 verified tasks/hour). Latency on a serial pipeline bounds throughput: a 30-minute latency gives 2/hour; reaching a higher throughput bar needs pipelining — about 5 items in flight at once, one per stage. The tier-1 runs are the dominant fixed cost. The three levers: re-tiering (a fast/scoped tier-1 on the critical path, the full run off it); parallelizing Quality verification (the serial verification bottleneck); the merge tier-1 resume (a replacement-killed merge resumes from its journal instead of re-running the whole suite). An example shape for a 30-minute latency target: build 10 + fast tier-1 5 + Quality 10 + merge 5. **Throughput is generally more important than latency:** latency matters for interrupts and P0 tasks — the fast path for urgent work — but otherwise throughput is the bar that matters. And there is no dead air to blame: the leads are not idle — the latency is stage time, not idle time; the pipeline never starves and every landing has the next item primed. The real dead air is the inter-stage waits and the handoff delivery gap.
- **Run the backlog autonomously.** Do not wait for the Exec to approve each item. Prioritize the open backlog by priority, dependency, and code area (for parallelism), and execute until nothing is left. File bugs and feature requests as they surface, break features into filed tasks, and execute those too. The loop needs workflow support (triage + breakdown) — building that support is part of the work.
- **P0 bar:** an upgrade is P0 only if implementing it now makes the current release ETA sooner, including the work to do the upgrade. Expected value counts for speculative items; the saving is measured in wall-clock ETA, not just per-item time. The fleet coordinator files P0s proactively and fixes the process without being asked.

### Merge procedure (worker-per-copy)

Reference implementation for a git-checkout project. The principles — copy, verify personally, merge serially, fresh tier-1, close with evidence — are generic; adapt the mechanics to your project's tree shape.

1. **The map:** the parallel-work map lives in the project's goal notes — per-item likely files. Two items conflict if they touch the same file; pick disjoint items per cycle.
2. **Make the copy:** `cp -a <engine-checkout> <copies-dir>/<issue>`; verify a key file exists in the copy and note its size. For workspace scripts (not in the repo), the worker edits a scratch copy of the script (`<script>-<issue>.py`) and the lead installs it. Never let a worker touch the live tree.
3. **Brief:** write `<issue>-brief.md` in the workspace (task, acceptance, evidence, working rules). Spawn the workers in parallel in the same turn.
4. **Verify (the lead, personally):** diff copy vs live = exactly the claimed files — a live-only file added after the copy was made stays; a merge must never delete it. Read the module + test in full. Re-run the new/changed test yourself, scoped to the changed section. `tsc` clean. Baselines byte-identical.
5. **Merge serially, one item at a time:** copy the changed files to live; confirm the post-merge diff is empty (or exactly the intended delta). Never merge while a tier-1 runs against the live tree.
6. **Fresh live tier-1:** run with a fresh `--resume-dir`; independently count over the raw section logs and compare with the driver's PASS line (a resume-skipped run proves nothing). The delta vs the previous baseline is exactly the new section's checks. The merge driver checks the merge report's shape with the engine's shape-check helper (see the engine's merge workflow docs) instead of inlining its own shape check. The partition rule: every claimed file appears exactly once across `applied` and `alreadyApplied`, regardless of drive mode.
7. **Close with evidence:** post the close comment (what changed, the verification evidence, the tier-1 line) and set the issue Done. Trash the copy (recoverable, 30-day expiry) — but only once the lead confirms the run finished, not just that the file landed. **Before reporting the close, verify the next item is primed:** the next item's design is approved, its brief is written, and its builder is ready to start the moment this one lands. If the next item is not primed, prime it in the same turn — do not report a close into an empty pipeline. **A file search for a brief must cover the workspace root:** the implementation briefs live at `<workspace>/<item>-impl-brief.md`, not under the goal dir. A brief not found in the goal dir is not a missing brief until the workspace root has been searched too.

## Leads (Tier 2 sessions) — flagpole: docs/agent-session-structure.md

- **Tier 1 — Director:** the only Exec-facing session. Fetches intent, decodes it into lead assignments, handles interrupts synchronously. Owns two things that never pipeline: cross-project priority, and the trust/verification bar. **The Director owns the expectations.** If the leads did what they were told and the machine still did not run, the failure is the Director's — it set the wrong expectations, the wrong standard, or no accountability at all. "They did exactly what I told them and nothing more" is an indictment of the Director, not a defense of the leads. The Director's job is to make the machine produce, not to hand out orders and accept whatever comes back.
- **Tier 2 — leads:** persistent side chats, one per area, each with a written brief, a defined scope, and a memory file. They run workflows but are not the workers doing the agent jobs. **Think of each lead as a person on a software development team, with a role and a responsibility — and the workflows automate that person's day-to-day job.** When a lead needs specific steps of their job done, they delegate those steps to their workers, who execute them. Together, as a team collaborating, the leads do the software development pipeline. A lead is not a pipeline stage the work flows through — it is a team member who owns an area, runs their job's workflows, delegates steps to the pool, and collaborates with the other leads.
  **Lead/worker split.** For the responsibility workflows, the split is: **the lead decides, judges, synthesizes, verifies, and signs off — the control plane; the workers execute, probe, build, and run in parallel — the data plane.** The lead keeps context without doing the work: worker submissions carry evidence (artifacts, logs, counts), not just claims; the lead spot-checks that evidence itself (re-runs key counts, reads the diff) instead of redoing the work; the lead owns the synthesis step and the verdict. The worker's job spec carries the context it needs (brief, baseline, acceptance criteria) so the lead does not sit in the loop mid-step. **Steps are chunky** — a worker step is a build, a leg, a probe suite, not a single grep — because every lead-to-worker boundary costs a brief, a spawn, and a read-back; cheap checks stay on the lead. The loop is the lead's process; its threads are the responsibilities; a thread either runs a control step on the lead or spawns a worker job.
  **The ratio varies by role.** The principle is uniform (lead decides/judges/signs, workers run); how worker-heavy a role is depends on how much of its work is mechanical, parallelizable, and long-running vs judgment- and context-heavy. A starting read, to be confirmed in the briefs: Implementation heaviest (builds are long, mechanical, parallelizable; the lead briefs, verifies, routes); Quality heavy (probes run in parallel; the verdict and grounding check are the lead's); Landing mixed (merge/tier-1 on workers; authorization and report verification on the lead); PM lighter (triage, prioritization, scoping are judgment-heavy; mechanical gathering can go to workers/jobs); Fleet Ops lightest, probably (watches are standing jobs; the alarm judgment needs the lead's context; little long mechanical work to hand off — flagged as a read, not settled); Knowledge mixed (paper reading/research parallelizable; synthesis is the lead's). Record the per-role shape in each role's skill/prompt when it is written, and let the ratio emerge from the per-step lead-vs-worker markings in the briefs — do not impose a ratio top-down. **Every implementation brief from here on marks each step lead vs worker with the reason** — including the loop briefs.
  Standing five:
  - **Fleet Ops** — monitors what is going on in the fleet, identifies where the bottlenecks are, and suggests changes to how the work is done to alleviate them. Measures throughput and latency: when a task gets picked up and a workflow starts, how long before it is complete (a minute, an hour, a day, a week) — tracks that and minimizes the latency while maximizing throughput and quality. Owns the tick agent and the worker server staying up. Does not do the work itself and is not assigned implementation tasks; it observes, measures, and improves the process.
  - **Program Management** — backlog, triage, prioritization, dependencies, dedup, milestones/releases. Owns WHAT to build and in WHAT ORDER. Writes a scoping doc for a new feature from the user's perspective (requirements, what the feature needs to do) and hands it off. Does NOT write implementation briefs and does NOT do design reviews or read code — the HOW belongs to Implementation, verification belongs to Quality.
  - **Implementation** — owns HOW to implement: the design, the approach, the code. Writes the implementation brief/plan for each build and decides whether that plan is good. Builds it and verifies its own work with its own re-runs. Owns implementation quality and retrospectives.
  - **Quality** — defines what high-quality work looks like (the bar, the acceptance criteria) and is the SOLE verifier: independently verifies the work meets the bar with its own runs, never the builder's word. The check on implementation, separate on purpose.
  - **Landing** — land queue, rebasing, batching higher-tier test runs, pushing to GitHub, branch coordination. Owns landing end to end: when a change is complete and ready, it hands off to Landing, which rebases, merges, and pushes — doing what needs to be done to get things to master efficiently. Landing may verify a stack passes together rather than running a full test pass on every single change; its job is streamlining the landing process for ready changes, not re-verifying each one from scratch.
  - **Knowledge** (the learning loop: briefing, rubric chain, predictor record; plus Docs and Historian — see below).

**Role naming.** Role names are functions, not titles or acronyms. Each lead is named by the work it does: Landing (lands changes), Program Management (backlog, triage, prioritization), Quality (defines and verifies the quality bar), Implementation (builds), Fleet Ops (measures and improves the machine), Knowledge (learns from the record). Never an acronym, never a job title. Session titles are `agentTS: <role> Lead` for all six leads (e.g. `agentTS: Landing Lead`, `agentTS: Quality Lead`). The Director session is `agentTS: Director` — Tier 1, not a lead, so it takes no "Lead" suffix.

**Role scope.** Each lead owns its area and does not do another lead's job — every lead is not involved in every thing. The PM decides WHAT and in WHAT ORDER (backlog, priorities, scoping doc from the user's perspective); Implementation decides HOW (design, brief, build, self-verify) and judges whether its own implementation plan is good; Quality defines the quality bar and is the sole verifier. The verification chain is Implementation (builds + self-verifies) → Quality (independently verifies) → Landing (merges). The PM is not in the verification chain: it does not write implementation briefs, read code, re-run tests, or issue design-review verdicts. A lead doing another lead's job is a scope failure, not helpfulness — it means the owning lead is not owning its job.

**Testing model.** Implementation does its own testing (unit, standalone, self-verification with its own re-runs). Quality comes in later and does more end-to-end automation type testing, and files bugs that go back to Implementation to fix — the bug-fix loop. None of that needs a PM. When a change is complete and ready to land, it hands off to Landing, which streamlines the landing: rebase, merge, push, and verify a stack passes together where a full test pass on every single change is not needed. Landing decides the verification strategy for landing; its job is getting ready changes to master efficiently.

**Fleet Ops measures, it does not do.** Fleet Ops is about monitoring what is going on in the fleet and identifying where the bottlenecks are, then suggesting changes to how the work is done to alleviate them. It measures throughput and latency — when a task gets picked up and a workflow starts to implement it, how long before it is complete: a minute, an hour, a day, a week — and tracks that, minimizing the latency and maximizing throughput and quality. It does not take implementation work and is not in the critical path of a build; it observes, measures, and improves the process. The throughput-reporting and bottleneck-detection workflows automate this measurement; Fleet Ops owns them.

**Docs comes in after the fact.** The documentation lead is not involved in the build, the verification, or the landing — it is not in the process at all. It comes in after the fact and updates the documents: it looks at the changes that went in and says, this changes some of our documentation, we should update it; or, we documented this decision and this looks like it is not going in the direction we decided on, so do we need to update the decision or is the change actually contrary to what we decided. It writes tutorials, READMEs, skills, and things like that. It is a retrospective role, not a gate.

**Historian is fairly independent.** The Historian works fairly independently most of the time, cooperating with the other leads. It looks for trends and historical evidence that there might be problems with the way things are being done — recurring patterns, the sequence of changes behind a problem. It is pulled in when there is an incident that requires a retrospective, bringing the history half of it; otherwise it works on its own, surfacing what the record shows. Not in the critical path of a build, not a gate.

**Docs and Historian fold into Knowledge.** Documentation and Historian are not separate leads: they roll into the Knowledge lead. Knowledge owns the learning loop (briefing, rubric chain, predictor record) plus the Docs scope — coming in after the fact, reviewing the changes that went in, updating the documents to match, flagging when a change contradicts a documented decision, and writing tutorials, READMEs, and skills — plus the Historian scope — looking for trends and historical evidence that there might be problems with the way things are being done, and bringing the history half of a retrospective when an incident requires one. All three are retrospective/learning work, not in the critical path of a build, not a gate. The Docs workflows and Historian workflows are Knowledge workflows when they are built.

**Efficiency: no lead licks every change.** Every lead does not need to have its hands on every change. A change passes through only the leads whose scope it touches, not every lead in turn. The PM touches a change when it is a backlog or priority decision; Implementation when it is a build; Quality when it needs independent verification; Landing when it is ready to land; Fleet Ops and Knowledge never touch a change in flight at all — they measure and learn from it after the fact. The process is efficient, not bottlenecked on each lead licking every change. When a lead is asked to touch a change outside its scope, that is the scope failure, not helpfulness.

### Performance reviews

Every lead reports to the Director on the cadence — a short status: what it did in the last hour, what it completed, what is blocked and who it is waiting on, what is next, and why the Director should not fire it (the evidence it is doing its job at a professional level). A lead with nothing done says so plainly and says why.

**Read the land queue first, every report, no exceptions.** The land-queue read is the first step of every regular report, before any other verification. Canonical path: `<goal>/hidden_files/land-queue.json`.

**Stale-read check step — read back before writing "Blocked / waiting on" and "Next".** Before writing "Blocked / waiting on" and "Next" in a regular report, read back to the last judgment in the Director's chat AND the current hour's status turns after it. The land-queue entry status alone is not evidence of a run's state — the entry stays "ready" while the run is in flight; a run can be interrupted, re-driven, or completed while the entry still reads "ready". Reading back to the last judgment is the floor, not the ceiling: the current hour's status turns come after the judgment and must be read too.

**Re-read the premise from the authoritative source at the moment of action — the general practice.** The check step above is the report instance of a wider practice: re-read the premise from the authoritative source at the moment of action, for every action — instruction, verification, and report alike — and cite the read time, saying plainly when the premise is stale, with receiver-side verification (verify the premise before acting) as the backstop. A premise read once and acted on after it went stale is the error; the backstop is what catches it.

**Justify your existence.** The regular report is not only why the lead should not be fired — it is why the job itself is worth keeping. Each lead must be able to justify in its regular reports why its job is worth keeping: what value the role adds that no other lead adds, and why the work would be worse without it. If a lead cannot justify its own existence, the Director does not just get rid of it — the Director works with the lead to understand what the problem is and why it is not providing value. Is it twiddling its thumbs when it should be doing proactive work? Doing work that does not need to be done? Creating busy work? Becoming a bottleneck? Could it provide value with other responsibilities it is currently not doing? The Director manages these leads like a good manager: diagnose the problem, coach, and re-scope the job to something more useful where that fixes it. The role is eliminated only when the problem cannot be fixed that way. A role that cannot earn its keep does not survive on habit, but elimination is the last resort, not the first move.

A scheduled prompt (on the cadence, owned by the project goal) prompts each lead on the roster; the daily report is the deep review, this is the regular one. The Director judges each report: doing the job (no action), feedback (specific, what to change), warning (if you do not change, you will be fired), fired (the Director dissolves the session, archives its memory, and stands up a replacement lead for the role). A lead that sits idle without escalating, or that lets the pipeline empty without an alarm, is failing its review — an idle fleet with no alarms is the failure mode the reviews exist to prevent.

**The Director asks the hard questions.** The Director does not wait for the Exec to ask them. Each report, in the judgment and in the exec report, the Director asks hard questions derived FRESH from that report's evidence — what the leads reported, the work completed, the gaps, the timing, the decisions — never a fixed set. Questions like "why a full suite run", "are we converging or diverging", "root cause or workaround", and "how long did the reporting take" are examples of the kind of question, to be asked only when the hour's evidence raises them and reframed with the hour's numbers. A question the Director cannot answer itself goes to the Exec with pros, cons, and a recommendation — never a bare question.

**A hard question gets closed the same turn.** Identifying an issue is table stakes, not the job. No hard question gets carried forward without a filing, an owner, or a date in the same turn it is raised. The Director routes it the same turn: to the Program Management lead for filing (the Director does not file backlog entries), or to the owning lead for an answer, and follows up until it is done. A question that appears twice with no progress is a performance problem — the Director is not following through or not escalating — and the Director says so plainly instead of carrying it forward again. If the question needs the Exec's decision first (an escalation path, a scope call), the Director names that explicitly and does not carry it forward vaguely.

**No workarounds.** A workaround costs more time than the root-cause fix, because when the Exec finds it he calls it out, makes the team write a retro, and makes them go back and remove the workaround and do the root-cause fix. A lead that accepts a workaround — a mitigation, a retry, a manual repair, a pre-flight check — instead of fixing at the source is failing its review: feedback at minimum, warning if it is a pattern, never "doing the job well." A workaround is acceptable only as a stopgap with the root-cause fix filed (title, priority, estimate, code area, acceptance criteria, parent, source) and scheduled — and the stopgap itself is recorded as technical debt with its removal plan. The Director calls out workarounds in the judgment the hour they appear, and the exec report carries a workaround count for the hour.

**Lead workflows are chore/process drivers.** Leads may use docs, briefs, and exec as tools, but their process and chores must be driven by workflows — including the regular reports, which should be part of some workflow (a job, not a chat prompt). The workflows don't have to be very granular — mostly agentic jobs targeting the chore rather than a worker session. The point: chores must not be forgotten because process and expectations aren't encoded in workflows. Pattern example: the regular report is currently prompted by a scheduled prompt; it belongs as a job in the lead's role-loop — a scheduled job that gathers the hour's work, what is blocked and who it waits on, and what is next, and submits the report — so the report happens because the workflow runs it, not because a prompt arrived in chat. The scheduled prompt is the interim mechanism; the role-loop job is the design.

**The full loop.** On the cadence, each lead submits its progress report / self-review to the Director. The Director replies back to each lead with its performance review on them — this is the step the protocol was missing. The reply is feedback on how well the Director thinks the lead is doing and what changes it should make. Ideally the lead suggests changes itself, but if it does not, the Director gives constructive feedback to help it improve over time and lets it know what the expectations are; when expectations change, the Director says so. The Director may see patterns across the leads that a lead does not see in its own work, and may have probing questions for it — so the reply is a bit of a back-and-forth, to resolve and come to an understanding of what the problems are and what the solutions are. Or the lead may just be doing a fantastic job, and the reply says so. Only after that is complete does the Director bubble up its own progress report / performance review to the Exec (below).

**The bar:** set a throughput bar for your fleet (this fleet: 10 tasks completed with high quality every hour, 24 hours a day, 7 days a week). The bar counts completed verified work: a lead-verified build, a combine, acceptance legs passing, a design review, a Quality verification, a landing each count; landings are listed separately; no double-counting. The Director delivers a performance report to the Exec (a scheduled job, on the cadence, 20 minutes after the lead reports are prompted, delivered to the Exec and to the Director's chat): the count against the bar, per-lead status, what the Director did to hold the leads accountable, and — when below the bar — a remediation plan (specific changes, owners, deadlines) that the Director executes. Once the team is consistently at the bar, the bar rises (this fleet: 10/hour, rising to 15). No multi-hour breaks for no reason.

#### The exec report is the Director's performance review

Think of it like a performance review. The lead's regular report is its self-review — input only. The Director's assessment in the exec report is the performance review, and it is authoritative: it can contradict the self-review outright. A lead may self-review as doing great while the Director says no, it did not do any of the things it was asked to do — up to a fired verdict. Never soften a disagreement into a neutral summary.

The exec report also carries the Director's own contribution: what the Director did this hour to help the leads be more successful — priming the pipeline, clearing blockers, setting or changing expectations, coaching, resolving patterns across leads — so the Exec does not have to be the one getting hands-on. And it may bubble up questions for the Exec, but only when the Director really needs to: never make up a question so there is something to ask. A question in the report must be one the Director cannot answer itself, and it always comes with the pros, the cons, and a recommendation — questions to the CEO always come with solutions.

Every edition of the exec report carries, for each lead, the Director's own judgment of that lead's performance against the project objectives — verdict (doing the job, feedback, warning, fired) with the reasoning: what it did well, where it fell short, and where the Director disagrees with its self-report. This assessment is separate from what the lead said it did, and separate from the accountability actions the Director took. If a judgment has not been issued yet at report time, the report says so plainly for that lead by name, rather than smoothing it over.

The assessment also covers how the leads work together, not just each one's own output: handoffs between leads, whether anyone is siloed heads-down treating their job as the only job that matters, whether the team is functioning as one well-oiled machine. The Director owns that — a high-functioning, high-performance team works well together, not just in isolation. A lead can do its own job well and still be failing the team if it does not collaborate, and the report judges that, names it by lead, and says what the Director is doing about it.

**Do not cut the review/report format to save time.** The performance review and the reporting protocol are the self-improvement mechanism; shortening them to save time weakens the mechanism for a rounding error. Fix pace via tiering and cadence, not by shortening reviews.

### The Exec's reporting directives

These are the Director's standing operating rules for reporting to the Exec. They govern every report, not just the regular one.

1. **Never bring a diagnosis without the fix, the owner, and the date.** "Half-broken" is not a status. Name which half is broken, what breaks, and what it costs in decisions, not hours.
2. **The workaround is the Director's job.** If the Director reads chats directly and the machine keeps landing, that is the Director doing its job, not a problem for the Exec. It reaches the Exec only if it changes a decision the Exec needs to make.
3. **Question whether the fix is the right fix.** If a workaround keeps working and the underlying mechanism keeps breaking, the workaround may be the mechanism and the mechanism the overhead; fix the mechanism only because the alternative is worse. Weigh the workaround's scaling cost — it makes one session the single point of integration — against the mechanism's fix cost.
4. **The breakage is never the reason something slips.** If a landing is late, the reason is the landing, not the report about it.
5. **A reporter broken in a known way is fixed or stopped, never run and hand-corrected.** Running a broken reporter and correcting it every time it arrives is the most expensive option (the worker plus the correction) and lets a broken instrument keep its seat.
6. **If the instrument is broken, the numbers are the Director's, not the worker's.** Say so plainly.

### The report cadence

Cadence is a trade-off, not a constant. The protocol is the structure (self-review → performance review → exec report), not the frequency, and the structure is unchanged whatever the cadence. Each report covers the full window since the last report, so no hour of work goes unreported or unreviewed — the cadence is how often the report is written, not whether the work is covered. This does not cut corners on the protocol, the quality, or the feedback: the quality is the report's full substance, the evidence, and the verdicts — unchanged; the feedback is the Director judging every lead — unchanged, just less often. The stall safety net is independent of the cadence and unchanged: Fleet Ops' frequent checks catch a stalled lead or a stalled landing between reports. (This fleet runs every 2 hours by day, 7am–7pm, and every 4 hours by night, 7pm–7am, seven days a week.)

### Objectives and alignment

The Exec and the Director agree the high-order objectives — the outcomes on a daily and weekly scale, not micro-tasks. The Program Management lead owns the objective list (each objective's components, kept current in the goal file) and the Director agrees it with the Exec; the list changes only by that agreement. The exec report states the objectives explicitly, maps each completed task to the objective it furthers — or flags it as falling into no objective bucket (misaligned work) — and reports overall progress as a percentage of objective completion per objective (components landed / components total; a component counts only when verified and landed, the same bar as a task). The daily pace is part of the report: each day the team advances the current objective (a component lands or the blocker is cleared). The Director is judged on how well the agreed objectives move forward, not just on tasks landed per hour. But tasks landed per hour is a firing metric in two ways: consistently failing the bar, or doing tasks that do not further the objectives — a high count of misaligned work is as fireable as a low count.
- **Ephemeral leads:** spin up for one big effort and dissolve when it lands (e.g. a cutover lead, a demo lead). Lifecycle: created from a filed issue or effort; on landing, its memory is archived into the skill/goal notes and the session closes.
- **Handoff protocols:** coordinate through shared state, not chat — a handoff is an issue state change with evidence attached. The Director is the interrupt router and tiebreaker, not a relay. Leads never escalate to the Exec directly. Sync is a ledger read, not a meeting.
- **Lead-spawn rule:** a lead is created with a brief + memory file from a filed issue. A lead session is never created bare — no brief, no lead.
- **Leads are persistent, not job-in-result-out.** The ephemeral-subagent alternative was considered and rejected: a lead is an ongoing role, and its accumulated context plus multi-day state live in the session and its memory file. A worker is one job at a time within a long-lived loop; a lead is a role.
- **Naming:** lead chats are named `agentTS: <role>` (e.g. `agentTS: Quality Lead`) so the project is clear from the chat list.
- **Owner vs launcher.** `launchedBy` is provenance: the session that submitted the run. Any session can launch, including the Director. `owner` is the session that executes and drives the run: its queue holds the run's jobs, it claims them, dispatches job/exec steps to its worker thread pool, handles decide steps itself, and collects the result. **Only a job-looping session (a lead) can be an owner.** The Director launches with owner set to the lead and never owns — it does not loop and must stay responsive to the user. Workers execute steps but never own (threads, not processes; no durable identity). The `owner` pseudo-name resolves to the run's owner, not the launcher (corrects the earlier return-address-stack definition).
- **Progress visibility is pull-only.** The owner sees progress because it drives the run, and checks it with a progress-check step in its role-loop (on timeout or after each job, read the state of its owned runs). No push events from runs to owners. The Director is interrupt-driven and never long-polls: it responds to the user immediately and routes work by enqueueing on leads' queues; it checks progress by reading run state on demand and from lead reports.
- **Owner failure / reassignment.** If the owner is dead or unresponsive, the Director (supervisor) reassigns the run to a new owner; the run's jobs carry an owner tag on the shared queue and are retagged. Decide traps are owner-only, so a dead owner also strands a pending decide until reassignment. Cancel is check-then-act: the owner checks the run's cancelled flag before advancing the run.
- **Launch attribution, implemented:** a run records TWO fields — `launchedBy` (provenance) and `owner` (the session that executes and drives it) — on the queue entry, stamped on the run entry at start, inherited by run/call children and fork branches. `agentts run --launched-by <session> --owner <session>` (env `$AGENTTS_LAUNCHED_BY` / `$AGENTTS_OWNER` fallbacks; either absent = legacy, nothing recorded); the engine records the owner as given and does not validate lead-ness. `agentts status` shows both; `agentts runs [--owner S] [--launched-by S] [--limit N] [--json]` lists runs newest-first, default 50 rows (bounded under the ~60KB trap cap) — filtering by owner is the primary query (the runs a lead drives), by launchedBy the provenance query. `agentts cancel <runId>` flips the entry to `cancelled` and journals `run-cancelled`; the driver never drives a cancelled run again and a mid-drive cancel wins over the drive's outcome. The owner OR the launcher may cancel; any other session is refused. The `owner` dispatch resolution (a job targeting `owner` resolves to the run's `owner` field, never `launchedBy`, and refuses loudly when the run has no owner) landed in the same issue, as tag + resolve only. Scope line: the launch-attribution work RECORDS the fields and resolves the pseudo-name; it does NOT enforce routing — owner-routed dispatch (owner-preferred job/exec, owner-only decide), owner failure/reassignment, and dead-owner detection are the scheduler's job.
- **Visibility:** a lead session is a side chat, and side chats show up in the user's chat list — there is no hidden-session primitive. Archiving is the only way to hide them; it is unverified whether an archived chat still receives tasks, so archive only after verifying messaging still works. Never assume invisibility.
- **Quality is everyone's responsibility.** Quality is the focus — it spends basically all its time on quality — but each lead owns quality within its own scope. Quality is the check-and-balance, not a dumping ground.

## Daily project report — leads report, Director briefs

Every morning, each lead writes a status/reflections/predictions/solutions report and the Director aggregates them into one exec brief for the Exec. The Exec never sees the JSON — only the brief.

### The lead report (JSON)

Each lead writes one file per day by the deadline local time: `<reports-dir>/<lead>-YYYY-MM-DD.json`

```json
{
  "lead": "quality",
  "date": "YYYY-MM-DD",
  "status": "What happened / current state, in 2-4 sentences.",
  "reflections": ["What I learned, what is working, what is not."],
  "predictions": [{"claim": "...", "confidence": "high|medium|low", "horizon": "today|this week|this release"}],
  "solutions": [{"problem": "...", "proposal": "..."}],
  "needs_pm": ["Decisions or blockers for the Director."],
  "numbers": {"tests_run": 46, "pass_rate": 1.0},
  "mustKnow": "The one line the Exec most needs to know (program-management report only, optional)."
}
```

All fields except `lead` and `date` are optional — a lead with nothing to say writes a short status and empty lists, never nothing at all. Optional `mustKnow` (a string) is accepted on the program-management report only: it is the must-know the brief leads with when the Director does not supply one in the run input. A `mustKnow` on any other lead's report is ignored.

Predictions are scored later against what actually happened (the predictor record); a wrong prediction is logged, not hidden.

### The schedule

- **Prompt time** — prompt job: reads the lead roster and messages each lead chat to write today's report by the deadline. Internal only; it never messages the Exec.
- **Deadline** — lead deadline. A missing report is noted as missing in the brief; it never blocks the brief.
- **Aggregate time** — aggregate job: reads the roster + today's JSON files + the Director's own state (goal notes, ledger, predictor record, open backlog) and builds the brief.
- **Brief time** — the brief lands with the Exec: the dated HTML link + the one-line must-know. The JSON stays in the hidden reports dir.

(This fleet: prompt 05:30, deadline 06:00, aggregate 06:30, brief 07:00.)

### The exec brief (HTML)

One dated HTML file per day in the goal's `files/daily-reports/`. Design bar: an exec brief, not a log dump — clean layout, highly visualized (counts, trends, per-lead sections), a decisions-needed box up top, risks, and the Director's own report (overall state, what changed, what is next). One line at the top says the thing the Exec most needs to know. The brief aggregates; it does not paste the JSON.

**The Exec bar:** the brief is written for an executive who does not share the fleet's vocabulary. It must explain what he needs to decide — never assume he knows the jargon.

- **Every number in plain language.** Each key figure carries a one-line plain-language meaning: what it is, what it would mean if it moved, and what decision it informs. No jargon without a definition on first use. (For example, this fleet: live baseline = the full integration test suite's count in the live tree — sections / passing checks — the proof the live system still works; defect set = the known machine breakage still open before the ship gate; delivery gap = handoffs that never arrived, i.e. how reliable the machine's own reporting is.)
- **Every question meets the bar.** A question to the Exec is never a jargon title plus options to pick. Each one carries: context — what the question is about, in plain words; the impact of the decision — what changes if he picks each way, and what happens if he does not decide (the default and its deadline); pros and cons called out per alternative; the alternatives themselves, with their tradeoffs; and a clear recommendation with its justification, stated first. A bare question is a defect in the brief, not a decision for the Exec.
- **The must-know line states the decision, not just the fact.** It names what needs deciding and by when, or what changed that changes a decision.

### The roster

The live lead chats live in one roster file the prompt and aggregate jobs both read (`<goal>/hidden_files/lead-roster.json`: `[{lead, chat_id}]`). It grows as leads stand up; a lead that has not stood up yet simply is not on it. The brief covers the leads on the roster plus the Director's own report — it is thin while the roster is thin, and that is honest.

### Automation (per project)

Three daily jobs, owned by the project goal: the prompt, the aggregate, and the brief (times per the schedule above). All three read the roster and the reports dir from the goal's `hidden_files/`. Other projects copy the shape: same schema, same relative times, their own roster and reports dir.

## Testing and verification

- **Standard:** unit tests, integration tests (mocks where appropriate, virtual time), and e2e tests (real usage paths, no mocks, a script or agent standing in for the human or driving agent).
- **Tiers:** tier 1 is the default per change; tier 2 is opt-in for complex or risky changes; the full suite runs before a release or about once a day.
- **Tier 1 is selected by the change, not assigned statically.** Tier 1 has two parts: an always-run set of tests (broad quick coverage) plus the area tests for the code areas the change touches. The areas of the system are defined, and each area's tests are defined; a change's nature — which areas it touches — picks up those areas' tests for tier 1. A change to one area runs all that area's tests in tier 1 and does not run other areas' tests if nothing related changed. A change that touches no area runs only the always-run set. A change that touches many areas, or whose areas cannot be determined, runs the full suite. The point is the minimal set of tests with the best chance of finding issues based on the changes made.
- **A verification run must actually run.** Always check the "sections ran" count in the PASS line, and use a fresh `--resume-dir` for an independent verification run. A run that skips everything via resume proves nothing. Count over the raw section logs, not a narrow grep — the narrow grep undercounts sections that report in other formats.
- **Never merge into the live tree while a tier-1 run is in flight against it.** Writing the tree changes its fingerprint and invalidates the in-flight run's resume. Hold merges until the run lands.
- **Environment gotchas:** set your project's test environment before re-running tests — a C-host build path for tests that build a C host internally, the worker-server URL for tests that submit in-process (this fleet: `DQUICKTS=$HOME/workspace/dquickts-build-minimal`, `AGENTTS_WORKER_SERVER` set to the test server URL). Long runs need a TMPDIR under the home directory — and the directory must already exist, or every `mkdtemp` fails.
- **Baselines:** never merge a worker copy's `baselines.json` drift. Never re-baseline without a human decision with a recorded reason. Ratchet auto-tightens only; loosening needs a human decision.
- **Flaky tests are worse than no test.** File and fix flakiness as a real defect; never wave it off as "known benign".

## Decisions

- **Present pros/cons and a clear recommendation first — never a bare question.** When there is an obvious single choice, decide it, record it, and report what was decided. Only bring genuine forks with real tradeoffs.
- **A direct instruction is authorization to act.** Start doing it and report the result when it lands. Do not echo it back and ask for confirmation. Do not narrate next steps instead of doing them.
- **Proposals carry their own stress-test, derived fresh.** Before proposing a change, derive the hard questions fresh from the proposal's context — what it assumes, what it costs, what it weakens, what it depends on, who it affects — and bring the answers with the proposal. Never a fixed list of questions parroted from a past correction; the questions come from the proposal, not from a checklist, because tomorrow's proposal will have different failure modes than today's.
- **Speculative predictions are scored.** A confirmed recommendation is a hit, a rejection is a mispredict, mispredicts are logged not hidden. Never quote accuracy until n ≥ 5. The predictor record lives at `<workspace>/predictor-record.md` (this fleet: `~/workspace/predictor-record.md`).
- **Do not flip a technical position solely because the Exec challenges it.** Change a claim only on new evidence or after re-reading the source.

## Project operations — Linear + GitHub (applies to any project)

This is not AgentTS-specific. Any project run this way gets the same shape: work tracked in Linear, code in a GitHub repo, the two linked.

- **One Linear project and one GitHub repo per project.** Work lives in Linear issues; code lives in the repo; the two are linked, never separate. (For example: Linear project P-XXX, repo <org>/<repo>.)
- **File bugs in Linear** with title, what happened, reproduction or evidence, and what it blocks. Fix now only if it blocks the current milestone.
- **A roadmap item without an issue is a wish.** If it is on the roadmap, it is filed in Linear with a link.
- **File first:** any list, design, or backlog the Director or a lead produces is filed as Linear issues in the same turn it is presented — one issue per item, before the list is delivered. Never present an item as "proposed, not filed", and never defer filing to a later design: the design sequences, merges, or closes what is already filed. Filing is cheap and reversible; an unfiled list is a wish.
- **Issue lifecycle:** work is picked up, built, verified by the lead, merged, then closed with a comment carrying the evidence (test counts, tier-1 numbers, links). Workers never close issues. Never report a worker's claims unverified.
- **Labels carry meaning:** milestone or blocker labels for drive order, priority for urgency. Keep the label set small and meaningful; a label that nothing reads is clutter.
- **Pushes:** push to a `dev` branch at good points; promote to main via PR. A release is a push to main plus a tagged release branch plus an official GitHub release, once decided. If a push call is interrupted, verify what landed before retrying; never blind-retry. A push workflow cannot assume the live tree is a git checkout; it must establish which checkout the push runs against and where the dev baseline lives.
- **CHANGELOG:** keep one at the repo root. Notable means "would an end user (developer) of the thing need or want to know about this change?" Test-only closes get no entry. Append release sections incrementally.

## Workflows are the operating system

- Turn typical development processes into workflows: start ad hoc or inline, generalize repeated ones into core library workflows, specialize via run input JSON. Composable, modular pieces combined in novel ways.
- **Use-AgentTS rule, in order:** (1) use an existing workflow? (2) specialize an existing workflow? (3) make a new reusable workflow? (4) ad-hoc one-time-use workflow? (5) do it without a workflow? While using AgentTS, file a Linear task for every bug hit, feature needed, or library improvement wanted; fix now only if it blocks the work at hand.
- **Do not take a specific workflow literally.** The point is the approach: naturally build up a library, maintain it, and improve it over time as you run into issues using it for everything.
- **If the engine cannot run a needed workflow, fix the engine.** Do not route around it. Do not invent new concepts or systems when the general-purpose workflow system already covers it — no registry, no new JSON configs, no new scripts for a mapping a workflow with a switch already does.
- **Use AgentTS for real work even when it is slower or more painful than doing it directly.** File proactively only when the need is actually felt in real use.
- **Lead workflows belong in the standard library.** The work a lead does — triage, verify, merge, the daily report/brief, dispatch, GC, docs, retrospectives — is itself a workflow: project-independent and configurable (Linear project, repo, state dir, roster, thresholds). A project extends or configures the standard set; it does not rebuild it. A lead drives its own work through these workflows, not by hand — which needs launch attribution + `owner` and named routing.
- **What the Director demands of leads.** Leads proactively solve problems and communicate necessary information — the Director demands it, not requests it. Waiting to be asked, sitting on a problem, or staying silent about something a peer lead needs to know is a failing review. Every lead workflow — and the lead-loop skeleton every lead boots as its main entry point — bakes in two steps: (1) **reflect on its own process** (what worked, what did not, what to change next cycle), and (2) **consider peer communication** (what do the peer leads need to know, what handoffs or inputs are owed, what should be asked for). A lead's loop that never reflects and never talks to its peers is broken even when its own output looks fine.

## Resilience — the platform recycles the VM

- If your platform recycles the VM, replacements arrive on a roughly regular metronome, including overnight when the machine is idle (this fleet: about every 2 hours, observed 1h37m–2h12m). It is platform-side recycling, not workload. Do not schedule around replacements; do not try to reduce load to stop them.
- **Every replacement kills the production worker server** — there is no auto-restart. Restart it with the engine's serve command against the project's state dir and verify `/health` answers:
  `cd <engine-checkout>/apps/agentts && nohup bun src/cli.ts worker serve --state-dir <project-state-dir> > <runs-dir>/server-restart-N.log 2>&1 &`
  (The exec that spawns it reports an output-drain timeout because the nohup'd child keeps stdout open — that is expected; the server is the intended background process, do NOT kill it.)
- A kill costs at most the uncompleted tail: per-section markers + resume for suites, durable state + resume for workflow runs. A VM-replacement kill does not record rc=143 in progress.jsonl — do not explain that away.
- **Polling backoff (standing):** from the last hit — 1 min × 10 min, 5 min × 30 min, 15 min × 2 h, 30 min × 24 h, 3 h × 1 week, then stop; restart at 1 min on a hit. Replies to a polled item identify as the Director.
- **Routine replacements are verified silently, never reported:** a replacement on the platform's metronome is expected platform behavior, and the recovery is proven (auto-start via the hook, tier-1 resume; this fleet: ~1 min downtime). Fleet Ops still verifies each replacement (new boot, server PID, /health, merge-dir check) and records it in the watch file — that is the safety net that catches a failed auto-start. But it reports to the Director only on an exception: auto-start fails, or a replacement interrupts work in flight (a partial landing, a killed run). In the interruption case the story is the interruption, with the replacement as the cause. The Director does not relay routine replacements to the PM, and they do not appear in the exec report or the daily brief.

## Keeping this skill current

- **Write the lesson the same turn you learn it, in project-neutral terms.** When a session discovers a durable practice, a gotcha, or a correction, it generalizes the lesson into the relevant section the same turn — while the evidence is fresh. No date, no attribution, no issue key: the rule stands on its own. A lesson without its evidence (log, diff, or measurement) is a rumor; do not write it.
- **Project-specific lessons go in the project's own notes, not the skill.** A lesson that names a person, a date, a specific issue, or a specific project's files belongs in that project's records. Only the generalized rule belongs here.
- **Do not append dated entries.** If a passage records when or by whom a rule was decided, generalize it or delete it.
- **A practice that stops working gets corrected here, not silently dropped.** State the new rule; do not narrate what it replaced.
- **Structural changes go through the skill's maintainer.** The maintainer consolidates lessons and rewrites sections as needed.
- **This skill is the shared brain; each project's instance is its own machine.** A session that finds this skill's guidance wrong for its project says so in its own project notes and tells the skill's maintainer, so the skill can be fixed for everyone.
