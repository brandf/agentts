// Parent workflow for BRA-105 S3: calls the throwing child inside
// try/catch and reports what it caught. The child error's name and
// message must surface at the call site.

import { run as runChild } from "../../src/agentts";
import type {
  Bra105ThrowChildInput,
  Bra105ThrowChildOutput,
} from "./workflow-bra105-child-throw";

declare function print(...args: unknown[]): void;

export interface Bra105ThrowParentOutput {
  caught: string;
}

export default function run(): Bra105ThrowParentOutput {
  try {
    const r = runChild<Bra105ThrowChildInput, Bra105ThrowChildOutput>({
      workflow: "./workflow-bra105-child-throw.ts",
      input: { n: 0 },
    });
    print("parent got:", JSON.stringify(r));
    return { caught: "(none — the child did not throw)" };
  } catch (e) {
    const err = e as Error;
    print(`caught: ${err.name}: ${err.message}`);
    return { caught: err.name };
  }
}
