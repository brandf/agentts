declare function print(...args: unknown[]): void;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  try {
    throw new Error("boom");
  } catch (e) {
    print("caught is Error:", e instanceof Error);
    print("caught:", (e as Error).name + ": " + (e as Error).message);
  }

  try {
    throw "plain failure";
  } catch (e) {
    print("plain is Error:", e instanceof Error);
    print("plain:", String(e));
  }

  print("done");
  return { done: true };
}
