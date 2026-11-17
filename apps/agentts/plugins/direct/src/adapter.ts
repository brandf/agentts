// direct adapter plugin (BRA-68).
//
// Loads via the Host.loadAdapter seam (`--adapter direct`): returns
// the DirectAdapter from ./direct-adapter.ts — real execution (one
// worker process per job trap, real exec, held gates, local decision
// model). Same shape as plugins/mock/src/adapter.ts: the
// implementation lives in this plugin's src/ (one copy) and this
// file is the loadable plugin module. Before BRA-68 there was no
// direct plugin — Host.loadAdapter short-circuited "direct" to the
// built-in; the short-circuit is gone, so every adapter name goes
// through the same plugin seam. The host and CLI still construct
// DirectAdapter directly for their defaults (makeHost / the Host
// constructor); that is the same class, not a second copy.

import { DirectAdapter } from "./direct-adapter";

export function createAdapter(): DirectAdapter {
  return new DirectAdapter();
}

export default createAdapter;
