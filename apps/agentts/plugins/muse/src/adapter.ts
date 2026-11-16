// muse adapter plugin (BRA-48).
//
// Loads via the Host.loadAdapter seam (`--adapter muse`): returns
// the MuseAdapter from src/adapters/muse-adapter.ts, which answers
// job traps through the get-job/complete-job queue over HTTP (see
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
// The worker side lives next to this file: worker-loop.ts (Bun
// processes running registered worker scripts — the proof leg),
// get-job.ts / complete-job.ts (one-shot CLIs a subagent runs — the
// true-subagent leg), WORKER.md (standing instructions for subagent
// workers), jobspecs/ (prose specs, hash-cached by workers).

import { MuseAdapter } from "../../../src/adapters/muse-adapter";

export function createAdapter(): MuseAdapter {
  return new MuseAdapter();
}

export default createAdapter;
