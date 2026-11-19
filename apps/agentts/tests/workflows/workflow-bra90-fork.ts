// BRA-90 test workflow: an N-branch all(). Each branch sleeps once
// (so its first suspension writes a delta against the shared
// fork-point keyframe) and returns its name. The join must complete
// with all names, and the branches must never write a keyframe of
// their own — the keyframe store must hold exactly one file.
import { sleep, all } from "../../src/agentts";

export interface ForkInput {
  branches: number;
}
export interface ForkResult {
  parts: string[];
}

function branch(n: number): string {
  sleep({ ms: 0 });
  return `branch-${n}`;
}

export default function run(input: ForkInput): ForkResult {
  const thunks: (() => string)[] = [];
  for (let i = 0; i < input.branches; i++) {
    const n = i;
    thunks.push(() => branch(n));
  }
  const outcomes = all(thunks);
  const parts: string[] = [];
  for (const o of outcomes) {
    if (!o.ok) throw new Error(`branch failed: ${JSON.stringify(o.error)}`);
    parts.push(o.value);
  }
  return { parts };
}
