declare function race(thunks: (() => string)[]): string;

declare function print(...args: unknown[]): void;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const v = race([]);

  print("resolved:", v);
  return { done: true };
}
