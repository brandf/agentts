/**
 * BRA-131 probe workflow: throws immediately, before any trap — the
 * run fails on its first slice, so the slice path deletes its
 * registry entry (and records finished in-process). A fresh Host
 * over the same stateDir has no registry entry and an empty finished
 * map, so result() must derive the failure from the journal's
 * lifecycle "failed" event alone.
 */
export interface ThrowOutput {
  ok: boolean;
}

export default function run(): ThrowOutput {
  throw new Error("bra131 immediate throw");
}
