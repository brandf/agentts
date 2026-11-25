// BRA-214 fixture: a minimal workflow whose single exec trap returns
// a stdout of a chosen size. The regression test (tests/test-bra214.ts)
// drives it at sizes straddling the 64KB inline threshold and at the
// real-tree manifest size.
//
// Shapes:
//   "flat" — stdout is `bytes` x's (no JSON escaping growth: the trap
//     result is stdout + ~50 bytes of wrapper, so the inline/file
//     boundary sits at stdout ~= 65,486).
//   "manifest" — stdout is a JSON manifest dict of exactly `bytes`
//     bytes (many quotes, so the trap-result JSON grows via escaping:
//     a 64,111 B manifest produces a ~66.9KB result, file-backed —
//     Quality's Nov 20 numbers: 59,561 B passes inline, 64,111 B crashes
//     on the stale binary).
//
// sleepSec widens the window between the trap suspending and the
// result arriving (the cross-shift case kills the driver mid-exec).
import { exec } from "../../src/agentts";

export interface LargeExecInput {
  bytes: number;
  shape?: "flat" | "manifest";
  sleepSec?: number;
}

export interface LargeExecResult {
  stdoutLen: number;
}

export default function largeExec(input: LargeExecInput): LargeExecResult {
  const bytes = input.bytes;
  const shape = input.shape ?? "flat";
  const sleepSec = input.sleepSec ?? 0;
  const py =
    shape === "manifest"
      ? `import json; n=${bytes}; e={}; [e.update({('lib/dummy-%04d.ts' % i): 'a'*64}) for i in range((n//89)+2)]; s=json.dumps({'files': e}); print(s[:n], end='')`
      : `import sys; sys.stdout.write('x' * ${bytes})`;
  const shell = `${sleepSec > 0 ? `sleep ${sleepSec}; ` : ""}python3 -c "${py}"`;
  const r = exec({ cmd: "/bin/sh", args: ["-c", shell] });
  return { stdoutLen: r.stdout.length };
}
