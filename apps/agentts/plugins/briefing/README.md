# briefing adapter plugin (BRA-55)

Workaround for BRA-56: the direct adapter hardcodes its worker
registry and the CLI gives it no config, so a new workflow's job
specs have no CLI path to a worker. This plugin uses the sanctioned
`Host.loadAdapter` seam (`--adapter briefing`).

## Modes

Direct (real workers, real network):

```sh
bun src/cli.ts run workflows/daily-ai-briefing.ts --adapter briefing \
    --state-dir <scratch-state-dir>
```

Mock (deterministic fixture answers, no files written — gate/swap checks):

```sh
AGENTTS_BRIEFING_MOCK=1 bun src/cli.ts run workflows/daily-ai-briefing.ts \
    --adapter briefing --state-dir <scratch-state-dir>
```

## What it registers

Direct mode returns a `DirectAdapter` with these specs mapped to
`workflows/briefing-worker.ts` (resolved relative to this file, with
a fallback to the `agentts-host` working tree):

- `briefing-discover`, `briefing-read`, `briefing-relate`,
  `briefing-render`, `briefing-write`

Mock mode wraps the built-in `MockAdapter` and answers those five
specs with deterministic fixture data (fake IDs `2611.9000x`);
everything else (exec/gate/decide, and the JudgeFixLoop specs
`judge`/`fix`/`aggregate`/`rubric-update`) delegates to the mock.

## Notes

- The built-in `--adapter mock` cannot run the briefing workflow:
  it answers unknown job specs with a generic `{score: 0.5}` that
  fails validation against the briefing's concrete output types
  (part of BRA-56).
- The plugin imports the host adapters via paths relative to this
  file, so it works whether the CLI runs from the working dir
  (`agentts-host`) or the staged tree (`apps/agentts`).
