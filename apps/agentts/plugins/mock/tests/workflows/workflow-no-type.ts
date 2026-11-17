declare function trap(type: string, arg: unknown): unknown;

declare function print(...args: unknown[]): void;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const r = trap("job", { op: "score", value: 7 });

  print("got:", JSON.stringify(r));
  return { done: true };
}
