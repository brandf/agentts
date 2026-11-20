import { exec } from "../../src/agentts";

/**
 * BRA-145 fixture (bad input): a trivial workflow whose input is a
 * single number, so a wrong-typed input is refused at submit.
 */
export interface In {
  n: number;
}

export interface Out {
  doubled: number;
}

export default function wf(input: In): Out {
  const r = exec({ cmd: "echo", args: ["hi"] });
  return { doubled: input.n * 2 };
}
