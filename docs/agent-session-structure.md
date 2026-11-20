# Agent Session Structure: Three Tiers, One Pipeline

**Status: flagpole.** This is the direction we are moving toward, not a
description of today. Today is ~1.5 tiers: Meroki (the PM) wears every
lead hat himself — verifying, merging, closing, writing briefs, running
tier-1 suites — while worker subagents do the implementation work in
per-copy trees. The closest thing to a lead session today is the tick
agent: an operator session with its own instruction file, but it is
maintenance, not a domain lead. Discussion record: the design note
"Agent Session Structure" (Nov 20, 2026, in the r2 goal's files).

Numbering follows Brandon's: Tier 1 is the PM, Tier 2 the leads,
Tier 3 the workers.

## The shape

| Tier | Who | What they do |
| --- | --- | --- |
| 1 — PM (Meroki) | One session, the only one Brandon talks to | Fetches Brandon's intent, decodes it into lead assignments, handles interrupts (Brandon's messages) synchronously. Owns two things that never pipeline: cross-project priority, and the trust/verification bar. Does almost no implementation work directly. |
| 2 — Leads | Persistent sessions (side chats), one per area, each with a written brief, a defined scope, and a memory file | Run workflows, plan, delegate, verify, report. They are not workers: they do not do the agent jobs of the workflows. |
| 3 — Workers | Ephemeral subagents in a common pool | Do the agent jobs. Most jobs executed by agents in a workflow land here, from any lead's workflow. |

## The pipeline

The org is a modern CPU. One lead per pipeline stage; the PM is the
control unit.

| Pipeline stage | Lead | What it does |
| --- | --- | --- |
| Control unit | PM (Meroki) | Fetch intent, decode into assignments, handle interrupts, own architectural state. |
| Fetch + decode | Program Manager | Pulls the next items off the backlog, breaks features into tasks, sorts the dependency graph. The backlog is the instruction stream; the dependency graph is the reservation stations. |
| Rename + issue | Implementation | Hands each task a private copy — register renaming, no false dependencies on the shared tree — and issues it to the pool. |
| Execute | Worker pool | Superscalar, out of order by readiness. Context-aware issue means picking the unit whose operands are already in registers: the worker with that spec's notes already loaded. |
| Validate before commit | QA | A failing test is a branch mispredict: flush, don't retire. Separate from implementation on purpose — a check-and-balance. |
| Retire / commit | LBR (land, branch, release) | The reorder buffer. Work executes out of order and lands in order. The one serial stage, and deliberately narrow. |
| Performance monitor + power | Fleet Ops | IPC, latency, queue depth, server health. Files P0s when the machine itself is the bottleneck. |
| Cache + branch predictor | Knowledge (candidate) | The briefing prefetches tomorrow's instruction stream; the predictor record is the branch history table; the audit ratchet is the feedback loop tightening timings. |
| ISA manual | Docs (candidate) | The spec the other stages execute against. Ephemeral per effort. |
| Trace + post-mortem | Historian (proposed) | Reads the execution trace (ledger, journal, issue history), explains how the machine got here — recurring patterns, the sequence of changes behind a problem — and feeds the predictor (Knowledge) and the ISA manual (Docs). The one backwards-looking stage. |

`owner` is the return-address stack: it resolves to whichever session
called, no name stored.

**The point of the shape:** everything before retire is parallel and out
of order, and retire is small. That is what kills the Amdahl limit —
Meroki's serial verify-and-merge today becomes a narrow commit stage fed
by parallel verification. The feedback loop (ledger → audit → scheduler)
is what makes the machine faster over time instead of just busier.

## The leads

### Standing five — the fixed set most projects want

| Lead | Scope | Consumes | Produces |
| --- | --- | --- | --- |
| Fleet Ops | Fleet health, throughput, latency; owns the tick agent and the worker server staying up | Run ledger, heartbeat/watchdog signals | Throughput/latency numbers, P0 process filings |
| Program Manager | Backlog, triage, prioritization, dependencies, dedup, milestones/releases | Open backlog | Prioritized, dependency-sorted queue the fleet works from |
| Implementation | High-quality work, efficiently; breaks big tasks into plans and subtasks; researches implementation questions; owns implementation quality and retrospectives | Prioritized queue | Verified work |
| QA | Tests (implementing them and running tier 1); finds issues, files bugs with quality repro steps | Implemented work | Verdicts, filed bugs |
| LBR | Land queue, rebasing, batching higher-tier test runs, pushing to GitHub, coordinating branches | Verified work | Releases |

### Candidates — Knowledge and Docs planned (Brandon, Nov 20), Historian proposed

- **Knowledge lead (standing, planned):** owns the learning loop — the daily AI
  research briefing pipeline, the rubric chain, the seen lists, the
  predictor record. A standing function that fits none of the five; today
  the PM does it directly. Piloted second, after QA.
- **Docs lead (ephemeral-or-standing, planned):** owns the doc-production
  workflow — architecture docs, presentations, vision docs. Often
  ephemeral per big doc effort; stands while a project is
  documentation-heavy. Also owns the retrospective quality bar: a
  retrospective meets the bar before it counts, and the Docs lead
  archives it in the appropriate place so it can be found and learned
  from later.
- **Historian lead (proposed addition):** the backwards-looking lead.
  The Docs lead keeps the balance of the documentation up to date and
  accurate against the *current* state of things; the Historian keeps the
  *history* — a ledger/notes of what happened and why, investigations
  into recurring patterns, and the sequence of changes that led up to a
  problem. It synthesizes those learnings and hands them off: to the
  Docs lead (into current docs), to the Implementation lead (into how
  work is done), or to the PM (into decisions). The point is the
  direction: the PM and the other leads are forward-looking; the
  Historian is the one looking backwards. When something goes wrong, the
  Historian contributes heavily to the retrospective — the
  what-happened, the sequence, the pattern behind it — while the other
  leads contribute the forward-looking half: what to change so that class
  of problems doesn't happen again. The Implementation lead still owns
  the retrospective as a process; the Historian supplies its
  backwards-looking half. And the Docs lead is responsible for the
  retrospective meeting the quality bar and archiving it in the
  appropriate place, so it can be found and learned from later.

### Not added

- No separate Research lead: research is usually in service of an
  implementation question — fold into Implementation or Knowledge.
- No Security/Trust lead: the trust bar stays with the PM. It is the one
  thing that cannot be delegated away from the Brandon-facing session,
  because it is what makes the PM's word credible.

### Ephemeral leads — microcode patches

Special-purpose leads spin up for one big effort and dissolve when it
lands: e.g. a Briefing Cutover lead (BRA-111), a Demo lead (BRA-168), a
Migration lead (snapshot converter). Lifecycle rule: created from a filed
issue or effort, exists while that effort has open work, and on landing
its memory is archived into the skill/goal notes and the session closes.
Ephemeral leads are how the org scales without permanent overhead.

## Coordination — the part the model lives or dies on

- **Through shared state, not chat.** Leads coordinate via Linear
  (backlog and issue states), the run ledger (cost and throughput), the
  land queue, and the shared skill. A handoff is an issue state change
  with evidence attached, not a DM.
- **The PM is the interrupt router and tiebreaker, not a relay.** If
  every lead-to-lead message routes through the PM, the serial bottleneck
  is recreated one level up. Leads read shared state directly; the PM
  gets involved only for decisions, conflicts, or Brandon-facing
  questions. **Leads never escalate to Brandon directly.**
- **Sync is a ledger read, not a meeting.** No standups. Each lead's
  state is readable from shared state; the PM reads it.
- **Quality is everyone's responsibility.** The QA lead is focused on
  it — it spends basically all of its time on quality — but that doesn't
  make the other leads exempt. Each lead owns quality within its own
  scope: Implementation owns the quality of the work it produces, LBR
  owns the quality of what lands, the Program Manager owns the quality
  of the queue. QA is the check-and-balance, not a dumping ground.
- **The skill is the shared source of truth across sessions.** That is
  what prevents five sessions from drifting into five different
  understandings.

## The worker pool

- **Common but weighted, not flat.** The pool is shared across leads, but
  scheduling weighs the Program Manager's priorities — a big QA tier-1
  run must not starve implementation work. Per-lead weighting/quotas
  belong in the dynamic scheduler.
- **Dedicated channels:** a small number of pinned lanes for
  latency-sensitive work (e.g. tick-adjacent work, a "hot" lane for the
  current release). The engine's affinity already does warm-specialist
  preference; dedication is affinity with a longer hold and a reserved
  slot.
- **Context-aware dispatch (advanced version):** the scheduler scores
  workers by context — has this worker done this spec before, does it
  have the relevant notes. Honest limit today: the matching surface is
  the spec and `notes/<spec>.md` files, not worker memory; the advanced
  version needs named workers with memory.

## Engine capabilities it needs

| Capability | Issue | Notes |
| --- | --- | --- |
| Launch attribution + `owner` | [BRA-211](https://linear.app/brandf/issue/BRA-211) | Record `launchedBy` on the run; give that session progress visibility and cancel; resolve `owner` at dispatch. Without it, leads are just chats the PM talks to. |
| Named agent jobs | [BRA-50](https://linear.app/brandf/issue/BRA-50) | Full version: a `job` trap takes a target (a named lead), per-worker memory, routing. Leads are its first customer. Phase 3 — after BRA-211. |
| Dynamic scheduler | [BRA-160](https://linear.app/brandf/issue/BRA-160) | Context-aware pool scheduling + per-lead weighting, fed by the BRA-165 ledger. Phase 4. |
| Progress visibility | part of BRA-211 | Mostly solvable today via shared files (journal tail, queue.json, run status); the missing piece is attribution plus a clean API, not the data. |
| Lead sessions as chats | no engine change | Available today via side chats with a brief and a memory file — no engine change needed to pilot. |

## Sequencing — release slotting

r2 is "the OS release" — this structure is its org chart.

- **Phase 1 (now, no engine change):** [BRA-212](https://linear.app/brandf/issue/BRA-212) — stand up the QA lead session as the pilot (crisp scope: tests + tier-1 + bug filing; the check on implementation). Add the Leads section to the fleet-ops skill: standing five, ephemeral lifecycle, handoff protocols, lead-spawn rule.
- **Phase 2:** [BRA-211](https://linear.app/brandf/issue/BRA-211) — launch attribution + `owner`. Small engine work; unblocks leads owning their workflows.
- **Phase 3:** [BRA-50](https://linear.app/brandf/issue/BRA-50) — named-agent routing for leads by name.
- **Phase 4:** [BRA-160](https://linear.app/brandf/issue/BRA-160) — dynamic scheduler for the context-aware pool.
- **Lead pilots after QA:** Knowledge second; Docs and Historian as needed — all three need no engine change, so they slot in whenever the PM has a session to spare.
- **Dependency, stated plainly:** without Phase 2, leads are just chats the PM talks to — the workflows they "launch" are still the PM's.

Other projects will use the same workflow, so the sooner the model lands,
the sooner it compounds: every project gets the same three tiers, the same
skill, the same engine capabilities.

## Open questions

- **Lead names:** named personas (like Meroki) or functional titles?
  Brandon's call.
- **Knowledge lead:** resolved — standing, planned (Brandon, Nov 20).
  Piloted second, after QA.
- **Historian lead:** proposed addition, not yet planned. Candidate for a
  later pilot once the QA lead is running.
- **Numbering:** resolved here as Tier 1 = PM, Tier 2 = leads,
  Tier 3 = workers. Overrule if it reads wrong.
