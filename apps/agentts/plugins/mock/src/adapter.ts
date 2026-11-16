// mock adapter plugin (BRA-53).
//
// Loads via the Host.loadAdapter seam (`--adapter mock`): returns
// the MockAdapter from src/adapters/mock-adapter.ts — the canned
// answers (same table as the mock plugin engine) plus the
// JudgeFixLoop mock judges/fix/aggregate/rubric-update and the
// bug-fix simulation. Same shape as plugins/muse/src/adapter.ts:
// the implementation lives in the host's src/adapters/ (one copy,
// shared by the Host constructor default and this seam) and this
// file is the loadable plugin module. The mock plugin ENGINE
// (mock-plugin.ts) is a different thing: a full in-memory host
// with its own smaller canned set; this adapter is what the disk
// host drives runs with.
//
//   bun src/cli.ts run tests/workflows/workflow-judges.ts \
//       --adapter mock --state-dir <scratch>
//
// Before BRA-53, Host.loadAdapter short-circuited "mock" to the
// built-in and this file did not exist; the loader is now the only
// path for `--adapter mock` (the Host constructor's
// `new MockAdapter()` default stays as the fallback when no adapter
// is configured at all).

import { MockAdapter } from "../../../src/adapters/mock-adapter";

export function createAdapter(): MockAdapter {
  return new MockAdapter({ gates: "auto" });
}

export default createAdapter;
