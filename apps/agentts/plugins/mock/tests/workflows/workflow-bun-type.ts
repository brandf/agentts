declare function trap<Input, Output>(type: string, arg: unknown): unknown;

declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
}

interface ScoreResult {
  score: number;
  label: string;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  function label(f: Bun.BunFile): string {
    return f.name ?? "";
  }

  const fileName = label({ name: "notes.txt" } as unknown as Bun.BunFile);

  print("label:", fileName);

  const j = trap<ScoreInput, ScoreResult>("job", { spec: "score", input: { value: 7 } }) as ScoreResult;

  print("job:", JSON.stringify(j));

  print("done");
  return { done: true };
}
