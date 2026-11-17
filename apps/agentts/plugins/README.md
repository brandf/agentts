# Layer 3 — environment adapters (BRA-68)

This directory is Layer 3's home: **one folder per environment**.
There is no top-level `adapters/` and no `src/adapters/` any more —
before BRA-68 the built-in adapters lived in `src/adapters/` while
the loadable plugins lived here, and the split between the two was
not obvious from the folders. Now the implementation and the
loadable seam live together, per environment:

```
plugins/
  mock/       mock adapter: canned answers (the test double)
    src/
      mock-adapter.ts   THE implementation (MockAdapter class)
      adapter.ts        the loadable seam (createAdapter / default)
      mock-plugin.ts    the mock PLUGIN ENGINE (a full in-memory
                        host — not an adapter; see below)
      checker.ts / extract.ts / gate.ts / validate.ts / agentts.ts
                        copies of the host's gate pipeline, used by
                        the mock plugin engine
    tests/              mock suite + swap test
    run.sh              mock plugin's own build + test run
  direct/     direct adapter: real worker processes, real exec
    src/
      direct-adapter.ts  THE implementation (DirectAdapter class)
      adapter.ts         the loadable seam (createAdapter / default)
  muse/       muse adapter: the get-job/complete-job worker pool
    src/
      muse-adapter.ts   THE implementation (MuseAdapter class)
      adapter.ts        the loadable seam (createAdapter / default)
    worker-loop.ts      worker-side loop, script mode (Bun proof leg)
    get-job.ts / complete-job.ts
                        one-shot CLIs a subagent worker runs
    WORKER.md           standing instructions for subagent workers
    TICK-AGENT.md       standing instructions for the tick agent
    tick.ts             the tick agent's blocking /tick long-poll CLI
    jobspecs/           prose job specs, hash-cached by workers
  briefing/   briefing adapter: DirectAdapter with the briefing
              workers registered (+ a mock mode under
              AGENTTS_BRIEFING_MOCK=1)
    src/adapter.ts
```

## Adapters vs plugins — there is no split

Every adapter IS a plugin: `Host.loadAdapter(name)` imports
`plugins/<name>/src/adapter.ts` (a module exporting
`createAdapter()` or a default adapter) for every name —
mock, direct, muse, briefing alike. BRA-68 removed the last
built-in short-circuit ("direct"); BRA-53 had already removed
"mock". The host and CLI still construct `MockAdapter` /
`DirectAdapter` directly for their defaults (Host constructor,
CLI `makeHost`) — that is the same class from the implementation
file, not a second copy. The host never statically imports the
muse adapter: only the muse seam constructs it, and the layering
lint (below) enforces that.

## Why the mock adapter appears twice

`plugins/mock/src/mock-adapter.ts` (implementation) vs
`plugins/mock/src/adapter.ts` (seam) are different jobs, and
neither is redundant — verified by grep before BRA-68 closed:

- The **implementation** holds every canned answer. It is what
  the host constructor, the CLI, and the tests construct directly.
- The **seam** holds no answers at all: it constructs a
  `MockAdapter` and hands it to `Host.loadAdapter`. It is the only
  thing the loader imports. Delete the seam and `--adapter mock`
  has nothing to load; delete the implementation and there is no
  class to construct.

`plugins/mock/src/mock-plugin.ts` is a third, different thing —
the mock plugin ENGINE, a full in-memory host (BRA-45) with its
own smaller canned set. It is not an adapter; the swap test
requires the disk host's mock adapter and this engine to answer
byte-identically.

## The muse folder's worker machinery

`plugins/muse/` holds more than the adapter because the muse
environment is a worker pool, not just an answer function: the
adapter enqueues jobs on the pool queue, and the worker side
(`worker-loop.ts`, `get-job.ts` / `complete-job.ts`, `WORKER.md`,
`TICK-AGENT.md`, `tick.ts`, `jobspecs/`) is the other half of
that environment. Those paths are invoked by the live tick agent
and worker subagents, which is why BRA-68 kept this folder
exactly where it was instead of moving Layer 3 to a top-level
`adapters/` (rejected: adapters import the `Adapter` interface
from `apps/agentts/src/`, so a top-level folder would invert the
dependency, and it would have renamed every live worker/tick
invocation path).

## The import lint (the layer boundary, enforced)

Hard rule: **core (Layer 1) + host (Layer 2) never import
Muse-specific APIs.** Only Layer 3 (this directory, and only the
muse files within it) may touch them. The check is the M2
layering rule in `src/checker.ts` (`checkLayeringFiles`), run as
`agentts check --layering`:

```sh
# from apps/agentts/ — defaults cover src/ + plugins/ + workflows/
bun src/cli.ts check --layering
```

What counts as a violation:

- `M2-LAYER-MUSE` — a file outside Layer 3 imports the muse
  adapter or anything under `plugins/muse/` (the class
  `muse-adapter.ts` or the seam `adapter.ts` alike). The host
  loads the muse adapter only through `Host.loadAdapter`'s
  dynamic `import()` — dynamic imports are not static import
  declarations and are not flagged.
- `M2-LAYER-PLUGIN` — a workflow (or the `agentts` module)
  imports anything under `plugins/` at all. Workflows talk to
  traps only; the host supplies the adapter.

Scope: the lint runs over `packages/durablets/src`,
`apps/agentts/src`, `apps/agentts/workflows`, and this directory
— but NOT `tests/`, whose drivers legitimately import adapters
to test them (the checker unit tests cover the fixture
expectations instead). It is wired into `apps/agentts/run.sh`
right after the checker suite, so the boundary is enforced on
every full run, not as a manual step; it also runs inside the
first-run gate for every workflow (`checkLayeringForWorkflow`).
A violation fails loudly (exit 1, `LAYERING` diagnostics) —
never a silent default.

There is deliberately no eslint config in this repo: the checker
already is the lint (AST-based, no plugin ecosystem), and
`run.sh` is what makes it enforced rather than conventional.
