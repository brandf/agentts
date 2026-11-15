// Complex workflow: nested loops with a step call inside the inner loop,
// branch-dependent steps (if/else, each branch calls a different step),
// try/catch/finally around step calls, helper functions that contain
// step calls, and a step that throws (value 9 — the mock delivers it as
// an exception, and scoreItem catches it).

interface StepInput {
  op: string;
  value: number;
}

interface StepResult {
  score: number;
  label: string;
}

declare function step(input: StepInput): StepResult;
declare function print(...args: unknown[]): void;

function judge(score: number): string {
  if (score >= 0.9) return "ship";
  if (score >= 0.5) return "revise";
  return "reject";
}

// Helper with a step call inside try/catch/finally. The step for value 9
// throws; the catch turns it into a fallback result. The finally runs on
// both the success path and the caught-failure path.
function scoreItem(value: number): StepResult {
  try {
    return step({ op: "score", value: value });
  } catch (e) {
    print("item", value, "failed:", String(e));
    return { score: 0.0, label: "failed" };
  } finally {
    print("item", value, "settled");
  }
}

// Helper with branch-dependent steps: the branch taken decides which
// step runs — "verify" on the pass side, "retry" on the weak side.
function checkItem(value: number): string {
  const first = step({ op: "score", value: value });
  if (first.score >= 0.5) {
    const extra = step({ op: "verify", value: value });
    print("check", value, "passed, verify ->", JSON.stringify(extra));
    return judge(extra.score);
  } else {
    const retry = step({ op: "retry", value: value });
    print("check", value, "weak, retry ->", JSON.stringify(retry));
    return judge(retry.score);
  }
}

function runWorkflow(): string {
  let shipped = 0;
  let failed = 0;
  // Nested loops: the step call is inside the inner loop.
  const grid = [[7, 9], [3, 8]];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c];
      const res = scoreItem(v);
      print("grid", r, c, "value", v, "->", JSON.stringify(res));
      if (res.score >= 0.9) shipped++;
      if (res.label === "failed") failed++;
    }
  }
  // Branch-dependent steps: 7 scores high (verify branch), 3 scores low
  // (retry branch).
  const v1 = checkItem(7);
  const v2 = checkItem(3);
  print("checks:", v1 + "/" + v2);
  print("shipped:", shipped, "failed:", failed);
  return "done";
}

print("workflow done:", runWorkflow());
