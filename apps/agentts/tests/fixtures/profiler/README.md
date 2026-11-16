# Profiler fixtures (BRA-30)

Real journals, copied verbatim — never edited. Hand-counted values the
profiler test asserts live in `tests/test-profiler.ts`.

- `run-jfl-mock*.journal` (16 files) — JudgeFixLoop mock run, generated
  fresh with `bun src/cli.ts run tests/workflows/workflow-judge-fix-loop.ts
  --run-id run-jfl-mock --adapter mock` (5 loops, rubric update at loop 3,
  convergence at loop 5). Main 98 events; tree 218 events, 34 traps
  (job 23, decide 11), 5 forks / 5 joins / 15 branches.
- `bugfix-direct-3*.journal` (4 files) — the BRA-54 bug-fix proof run
  (`/tmp/bugfix-bra54/direct-3/journals/`). Main 38 events; tree 62
  events, 11 traps (job 9, decide 2), 1 fork / 1 join / 3 branches.
  `bugfix-direct-verify2.journal` is the follow-up verify run (6 events,
  1 job trap) and is not part of the bugfix tree.
- `briefing-proof3-2026-11-16*.journal` (23 files) — the BRA-55 briefing
  proof run (`/tmp/bra55-proof3.14gISc/state/journals/`). Main 50 events;
  tree 226 events, 31 traps (exec 2, job 26, decide 3), 3 forks / 3 joins
  / 22 branches (12 reads + 7 relates + 3 judges).
- `run-clock.journal` — virtual-clock workflow (`workflow-clock.ts`):
  55 events, 12 traps (sleep 2, clock 6, cron 4), 5 clock-advances,
  120 days total virtual advance. The Feb-1 cron fires with no advance
  (already past).
- `run-gate.journal` — gate-hold workflow (`workflow-gate-hold.ts`, run
  with `--gates hold`, then `deliver-gate`): 7 events, 1 gate trap,
  1 gate-held event.

No fixture journal carries a timestamp on any event — that is the
finding behind the profiler's time model (see `src/profiler.ts`).
