# Agent Session Structure: Three Tiers, One Pipeline

**Status: flagpole.** This is the direction we are moving toward, not a
description of today. Today is ~1.5 tiers: Meroki (the Director) wears every
lead hat himself — verifying, merging, closing, writing briefs, running
tier-1 suites — while worker subagents do the implementation work in
per-copy trees. The closest thing to a lead session today is the tick
agent: an operator session with its own instruction file, but it is
maintenance, not a domain lead. Discussion record: the design note
"Agent Session Structure" (Nov 20, 2026, in the r2 goal's files).

Numbering follows Brandon's: Tier 1 is the Director, Tier 2 the leads,
Tier 3 the workers.

## The shape

| Tier | Who | What they do |
| --- | --- | --- |
| 1 — Director (Meroki) | One session, the only one Brandon talks to | Fetches Brandon's intent, decodes it into lead assignments, handles interrupts (Brandon's messages) synchronously. Owns two things that never pipeline: cross-project priority, and the trust/verification bar. Does almost no implementation work directly. |
| 2 — Leads | Persistent sessions (side chats), one per area, each with a written brief, a defined scope, and a memory file | Run workflows, plan, delegate, verify, report. They are not workers: they do not do the agent jobs of the workflows. |
| 3 — Workers | Long-lived looping sub-agents owned by leads (BRA-213), not persisted | Do the agent jobs. Each worker runs a long-poll get-job loop for its lifetime: claim, execute in a fresh copy, submit, repeat. No memory file, no chat session — context accumulates during life and dies with the worker; the queue + Linear + ledger hold the durable state. |

## The model and the operations — see the skill

This doc is the decision record: what the structure is, why, what engine
work it needs, and in what order. The model and the operations live in
exactly one place — the fleet-ops skill
(`docs/skills/agentts-fleet-ops.md`) — and this doc
does not duplicate them. Summary: leads are processes, workers are dumb
thread-pool threads, all the smarts live in the AgentTS scheduler
(BRA-160), and pipelining is workflow stages queued to the thread pool at
trap granularity. The skill carries the CPU model, the lead scopes, the
handoff protocols, the worker pool, and the working loop.

## What this structure deliberately does not add

- No separate Research lead: research is usually in service of an
  implementation question — fold into Implementation or Knowledge.
- No Security/Trust lead: the trust bar stays with the Director. It is the one
  thing that cannot be delegated away from the Brandon-facing session,
  because it is what makes the Director's word credible.

## Engine capabilities it needs

| Capability | Issue | Notes |
| --- | --- | --- |
| Launch attribution + `owner` | [BRA-211](https://linear.app/brandf/issue/BRA-211) | Record `launchedBy` on the run; give that session progress visibility and cancel; resolve `owner` at dispatch. Without it, leads are just chats the Director talks to. |
| Named agent jobs | [BRA-50](https://linear.app/brandf/issue/BRA-50) | Full version: a `job` trap takes a target (a named lead), per-worker memory, routing. Leads are its first customer. Phase 3 — after BRA-211. |
| Dynamic scheduler | [BRA-160](https://linear.app/brandf/issue/BRA-160) | Context-aware pool scheduling + per-lead weighting, fed by the BRA-165 ledger. Phase 4. |
| Long-lived worker agents | [BRA-213](https://linear.app/brandf/issue/BRA-213) | Claim/long-poll endpoint + worker-agent runner loop + lead ownership + idle-timeout policy. The worker lifecycle; BRA-160/BRA-176 are the assignment side. |
| Progress visibility | part of BRA-211 | Mostly solvable today via shared files (journal tail, queue.json, run status); the missing piece is attribution plus a clean API, not the data. |
| Lead sessions as chats | no engine change | Available today via side chats with a brief and a memory file — no engine change needed to pilot. |

## Sequencing — release slotting

r2 is "the OS release" — this structure is its org chart.

- **Phase 1 (now, no engine change):** [BRA-212](https://linear.app/brandf/issue/BRA-212) — stand up the QA lead session as the pilot (crisp scope: tests + tier-1 + bug filing; the check on implementation). Add the Leads section to the fleet-ops skill: standing five, ephemeral lifecycle, handoff protocols, lead-spawn rule.
- **Phase 2:** [BRA-211](https://linear.app/brandf/issue/BRA-211) — launch attribution + `owner`. Small engine work; unblocks leads owning their workflows.
- **Phase 3:** [BRA-50](https://linear.app/brandf/issue/BRA-50) — named-agent routing for leads by name.
- **Phase 4:** [BRA-160](https://linear.app/brandf/issue/BRA-160) — dynamic scheduler for the context-aware pool — plus [BRA-213](https://linear.app/brandf/issue/BRA-213), the long-lived worker agents the scheduler assigns to.
- **Lead pilots after QA:** Knowledge second; Docs and Historian as needed — all three need no engine change, so they slot in whenever the Director has a session to spare.
- **Dependency, stated plainly:** without Phase 2, leads are just chats the Director talks to — the workflows they "launch" are still the Director's.

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
- **Numbering:** resolved here as Tier 1 = Director, Tier 2 = leads,
  Tier 3 = workers. Overrule if it reads wrong.
