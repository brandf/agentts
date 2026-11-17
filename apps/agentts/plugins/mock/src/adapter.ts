// mock adapter plugin (BRA-53, moved under plugins/ by BRA-68).
//
// Loads via the Host.loadAdapter seam (`--adapter mock`): returns
// the MockAdapter from ./mock-adapter.ts — the canned answers (same
// table as the mock plugin engine) plus the JudgeFixLoop mock
// judges/fix/aggregate/rubric-update and the bug-fix simulation.
// Same shape as plugins/muse/src/adapter.ts and
// plugins/direct/src/adapter.ts: the implementation lives in this
// plugin's src/ (one copy, shared by the Host constructor default
// and this seam) and this file is the loadable plugin module.
//
// Why the mock adapter appears twice (and why neither copy is
// redundant): this file is only the SEAM — it constructs a
// MockAdapter and hands it to the loader; it contains no canned
// answers itself. The IMPLEMENTATION is ./mock-adapter.ts, which
// the host and CLI also construct directly for their defaults
// (Host constructor, CLI makeHost). Delete the seam and
// `--adapter mock` has nothing to load; delete the implementation
// and there is no class to construct. The mock plugin ENGINE
// (mock-plugin.ts, same directory) is a third, different thing: a
// full in-memory host with its own smaller canned set — not an
// adapter at all.
//
//   bun src/cli.ts run tests/workflows/workflow-judges.ts \
//       --adapter mock --state-dir <scratch>
//
// Before BRA-53, Host.loadAdapter short-circuited "mock" to the
// built-in and this file did not exist; the loader is now the only
// path for `--adapter mock` (the Host constructor's
// `new MockAdapter()` default stays as the fallback when no adapter
// is configured at all).

import { MockAdapter } from "./mock-adapter";

export function createAdapter(): MockAdapter {
  return new MockAdapter({ gates: "auto" });
}

export default createAdapter;
