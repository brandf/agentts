// muse adapter plugin (BRA-48, moved under plugins/ by BRA-68).
//
// Loads via the Host.loadAdapter seam (`--adapter muse`): returns
// the MuseAdapter from ./muse-adapter.ts, which answers job traps
// through the get-job/complete-job queue over HTTP (see
// src/worker-server.ts) and holds gates / runs exec / decides
// locally like the direct adapter.
//
//   # zero-setup: the adapter auto-starts the queue server
//   bun src/cli.ts run tests/workflows/workflow-judge-fix-loop.ts \
//       --adapter muse --state-dir <scratch>
//
//   # explicit server (the true-subagent leg: the coordinator starts
//   # the server, then spawns worker subagents against it)
//   bun src/cli.ts worker serve --state-dir <scratch> --port 18741
//   bun src/cli.ts run <workflow> --adapter muse --state-dir <scratch>
//
// Same shape as plugins/mock/src/adapter.ts and
// plugins/direct/src/adapter.ts: the implementation lives in this
// plugin's src/ (./muse-adapter.ts, one copy) and this file is only
// the loadable plugin module — it constructs a MuseAdapter and hands
// it to the loader. The worker side lives next to this file:
// worker-loop.ts (Bun processes running registered worker scripts —
// the proof leg), get-job.ts / complete-job.ts (one-shot CLIs a
// subagent runs — the true-subagent leg), WORKER.md (standing
// instructions for subagent workers), jobspecs/ (prose specs,
// hash-cached by workers).

import { MuseAdapter, type MuseAdapterConfig } from "./muse-adapter";

export function createAdapter(config?: MuseAdapterConfig): MuseAdapter {
  return new MuseAdapter(config ?? {});
}

export default createAdapter;
