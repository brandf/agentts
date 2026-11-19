import { sleep } from "../../src/agentts";

export interface HelloInput {
  name: string;
}

export interface HelloResult {
  greeting: string;
}

export default function hello(input: HelloInput): HelloResult {
  sleep({ ms: 100 });
  return { greeting: `Hello, ${input.name}!` };
}
