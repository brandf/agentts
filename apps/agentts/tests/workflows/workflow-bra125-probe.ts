import { sleep } from "../../src/agentts";

/**
 * BRA-125 probe workflow: a sleep that never completes, cancelled
 * while suspended, with the CancellationError uncaught.
 *
 * The driver starts the run (it suspends at the 60s sleep), then
 * cancels it. The CancellationError is thrown at the sleep call site
 * and propagates uncaught, so the run fails in the C host's cancel
 * handler (packages/durablets/src/durablets.c, the `cancel` arm).
 * Before the BRA-125 fix that arm emitted the lifecycle "failed"
 * event BEFORE print_exception, so the journaled event carried no
 * error at all; after the fix it carries
 * "CancellationError: probe cancel".
 */
export interface ProbeOutput {
  ok: boolean;
}

export default function run(): ProbeOutput {
  sleep({ ms: 60000 });
  return { ok: true };
}
