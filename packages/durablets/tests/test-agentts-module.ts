#!/usr/bin/env bun
/**
 * Standalone agentts module test (Linear BRA-46).
 *
 * Runs WITHOUT the C host and WITHOUT the driver: the core globals are
 * stubbed, the module is imported, and the checks run in-process. Run:
 *
 *   bun tests/test-agentts-module.ts
 *
 * Scratch dir: $AGENTTS_MODULE_TEST_DIR or /tmp/agentts-module-test.
 * Exit 0 on PASS, 1 on any failure. Covers:
 *   A. wrappers emit exactly trap(type, arg) with the right arg shape,
 *      combinators are the stubbed globals (re-export identity),
 *      toJsonValue() accepts clean args (Date -> ISO, DAG shared refs,
 *      null-prototype objects) and throws synchronously with a precise
 *      path for every rejected category, never dispatching the trap;
 *   B. tsc --noEmit: the positive workflows type-check; one file per
 *      mistyped call in tests/type-negatives/ must FAIL type-check;
 *   C. Bun.build bundles the module workflow small (tripwire against
 *      dependency bloat — real zod measured 166,842 bytes for the same
 *      shape; this module must stay under 16 KiB).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const SCRATCH = process.env.AGENTTS_MODULE_TEST_DIR || "/tmp/agentts-module-test";
const FAILURES: string[] = [];
function fail(msg: string): void {
  console.log(`FAIL: ${msg}`);
  FAILURES.push(msg);
}
function check(cond: boolean, msg: string): void {
  if (cond) console.log(`OK: ${msg}`);
  else fail(msg);
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ part A
// Stub the core globals BEFORE importing the module (its top level reads
// globalThis.all/any/race for the re-exports).
const trapCalls: [string, unknown][] = [];
(globalThis as any).trap = (type: string, arg: unknown): unknown => {
  trapCalls.push([type, arg]);
  return { __sentinel: type };
};
const allStub = (...args: unknown[]): unknown => ({ __combinator: "all", args });
const anyStub = (...args: unknown[]): unknown => ({ __combinator: "any", args });
const raceStub = (...args: unknown[]): unknown => ({ __combinator: "race", args });
(globalThis as any).all = allStub;
(globalThis as any).any = anyStub;
(globalThis as any).race = raceStub;

const mod = await import("../src/agentts.ts");
const { job, exec, gate, sleep, cron, decide, all, any, race, toJsonValue, JsonBoundaryError } = mod;

console.log("\n=== A. wrappers emit exactly trap(type, arg) ===");
// Each wrapper: one trap call, right type, arg deep-equal, sentinel back.
{
  const calls: [string, unknown][] = [];
  const run = (fn: () => unknown, type: string, arg: unknown, label: string) => {
    trapCalls.length = 0;
    const r = fn();
    check(trapCalls.length === 1, `${label}: exactly one trap call`);
    check(trapCalls[0]?.[0] === type, `${label}: trap type is ${type}`);
    check(eq(trapCalls[0]?.[1], arg), `${label}: trap arg is exactly ${JSON.stringify(arg)}`);
    check(eq(r, { __sentinel: type }), `${label}: wrapper returns the trap result`);
    void calls;
  };
  run(() => job({ spec: "score", input: { value: 7 } }), "job", { spec: "score", input: { value: 7 } }, "job");
  run(() => exec({ cmd: "echo hi", args: ["a"] }), "exec", { cmd: "echo hi", args: ["a"] }, "exec");
  run(() => gate({ question: "approve?", options: ["a", "b"] }), "gate", { question: "approve?", options: ["a", "b"] }, "gate");
  run(() => sleep({ ms: 1000 }), "sleep", { ms: 1000 }, "sleep");
  run(() => cron({ at: "2027-04-09T00:00:00Z" }), "cron", { at: "2027-04-09T00:00:00Z" }, "cron");
  run(() => decide({ question: "pick one", options: ["a", "b"] }), "decide", { question: "pick one", options: ["a", "b"] }, "decide");
}

console.log("\n=== A. combinators are the core globals (re-export identity) ===");
check(all === allStub, "imported all is the global all (same function object, no wrapper)");
check(any === anyStub, "imported any is the global any");
check(race === raceStub, "imported race is the global race");
{
  // Calling the re-exported combinator calls the builtin with the same args.
  const thunks = [() => 1, () => 2];
  check(eq((all as any)(thunks), { __combinator: "all", args: [thunks] }), "all forwards its thunks to the builtin");
  check(eq((any as any)(thunks), { __combinator: "any", args: [thunks] }), "any forwards its thunks to the builtin");
  check(eq((race as any)(thunks), { __combinator: "race", args: [thunks] }), "race forwards its thunks to the builtin");
}

console.log("\n=== A. toJsonValue: clean args pass (Date converts, DAGs fine) ===");
{
  const when = new Date("2027-04-09T00:00:00Z");
  const input = { value: 7, when, nested: { list: [1, "a", null, true] } };
  const out = toJsonValue(input, "test") as any;
  check(out.when === "2027-04-09T00:00:00.000Z", "Date converts to its ISO string");
  check(input.when instanceof Date, "the author's Date is not mutated");
  check(eq(out, { value: 7, when: "2027-04-09T00:00:00.000Z", nested: { list: [1, "a", null, true] } }), "clean copy deep-equals the input with the Date converted");
  check(out !== input, "the clean copy is a fresh object");
  const shared = { x: 1 };
  check(eq(toJsonValue({ a: shared, b: shared }, "test"), { a: { x: 1 }, b: { x: 1 } }), "a DAG (same object twice, no cycle) passes and is duplicated");
  const nullProto = Object.create(null) as Record<string, unknown>;
  nullProto.k = "v";
  check(eq(toJsonValue(nullProto, "test"), { k: "v" }), "a null-prototype plain object passes");
  check(toJsonValue(new Date("2027-04-09T00:00:00Z"), "test") === "2027-04-09T00:00:00.000Z", "a root Date converts");
  check(toJsonValue(null, "test") === null, "root null passes");
}

console.log("\n=== A. toJsonValue: every rejected category throws synchronously ===");
class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}
const circ: Record<string, unknown> = { value: 7 };
circ.self = circ;
const arrExtra: unknown[] = [1, 2];
(arrExtra as Record<string, unknown>).extra = "x";
const dirtyCases: [string, unknown, string, string][] = [
  // [label, value (as the job input), expected path, expected kind]
  ["undefined value", { value: 7, missing: undefined }, "$.input.missing", "undefined"],
  ["nested undefined", { value: 7, deep: { leaf: undefined } }, "$.input.deep.leaf", "undefined"],
  ["function", { value: 7, fn: () => 1 }, "$.input.fn", "function"],
  ["symbol", { value: 7, sym: Symbol("s") }, "$.input.sym", "symbol"],
  ["bigint", { value: 7, big: 10n }, "$.input.big", "bigint"],
  ["NaN", { value: 7, nan: NaN }, "$.input.nan", "non-finite-number"],
  ["Infinity", { value: 7, inf: Infinity }, "$.input.inf", "non-finite-number"],
  ["Map", { value: 7, map: new Map([["a", 1]]) }, "$.input.map", "map"],
  ["Set", { value: 7, set: new Set([1]) }, "$.input.set", "set"],
  ["typed array", { value: 7, buf: new Uint8Array([1, 2]) }, "$.input.buf", "typed-array"],
  ["ArrayBuffer", { value: 7, buf: new ArrayBuffer(4) }, "$.input.buf", "array-buffer"],
  ["class instance", { value: 7, obj: new Point(1) }, "$.input.obj", "class-instance"],
  ["circular", circ, "$.input.self", "circular"],
  ["symbol key", { value: 7, [Symbol("k")]: 1 }, "$.input", "non-string-key"],
  ["invalid Date", { value: 7, when: new Date(NaN) }, "$.input.when", "invalid-date"],
  ["array hole", { value: 7, items: [1, , 3] }, "$.input.items[1]", "array-hole"],
  ["array extra key", { value: 7, items: arrExtra }, "$.input.items.extra", "array-extra-key"],
];
for (const [label, input, wantPath, wantKind] of dirtyCases) {
  trapCalls.length = 0;
  let err: unknown = null;
  try {
    job({ spec: "score", input: input as any });
  } catch (e) {
    err = e;
  }
  check(err instanceof JsonBoundaryError, `${label}: throws JsonBoundaryError (got ${err === null ? "no throw" : String(err)})`);
  if (err instanceof JsonBoundaryError) {
    check(err.path === wantPath, `${label}: path is ${wantPath} (got ${err.path})`);
    check(err.kind === wantKind, `${label}: kind is ${wantKind} (got ${err.kind})`);
    check(err.message.includes("JSON boundary (job arg)"), `${label}: message names the boundary`);
    check(err.message.includes(wantPath), `${label}: message carries the path`);
  }
  check(trapCalls.length === 0, `${label}: the trap never dispatched`);
}
// The helper itself, at the root: undefined / function / symbol rejected.
for (const [label, v, kind] of [
  ["root undefined", undefined, "undefined"],
  ["root function", () => 1, "function"],
  ["root symbol", Symbol("s"), "symbol"],
] as const) {
  let err: unknown = null;
  try {
    toJsonValue(v, "test");
  } catch (e) {
    err = e;
  }
  check(err instanceof JsonBoundaryError && (err as JsonBoundaryError).path === "$" && (err as JsonBoundaryError).kind === kind, `${label}: root rejected with path $ and kind ${kind}`);
}
// One dirty arg through each other wrapper (the check is shared, but every
// wrapper must actually call it).
{
  const cases: [string, () => unknown, string][] = [
    // Each value is JSON-dirty (not merely mistyped — a number where a
    // string belongs is still clean JSON; the type system catches that).
    ["exec", () => exec({ cmd: (() => "echo") as unknown as string }), "$.cmd"],
    ["gate", () => gate({ question: (() => "q") as unknown as string }), "$.question"],
    ["sleep", () => sleep({ ms: NaN as unknown as number }), "$.ms"],
    ["cron", () => cron({ at: undefined as unknown as string }), "$.at"],
    ["decide", () => decide({ question: "q", options: new Map() as unknown as string[] }), "$.options"],
  ];
  for (const [label, fn, wantPath] of cases) {
    trapCalls.length = 0;
    let err: unknown = null;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    check(
      err instanceof JsonBoundaryError && (err as JsonBoundaryError).path === wantPath && trapCalls.length === 0,
      `${label}: dirty arg throws at ${wantPath} before dispatch (got ${err === null ? "no throw" : String(err)})`,
    );
  }
}

// ------------------------------------------------------------------ part B
console.log("\n=== B. tsc: positive files pass, mistyped files fail ===");
function tsc(args: string[]): { status: number | null; out: string } {
  const r = spawnSync("bun", ["x", "tsc", ...args], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const tscVersion = spawnSync("bun", ["x", "tsc", "--version"], { encoding: "utf8" });
console.log(`tsc: ${(tscVersion.stdout || "").trim()}`);
const positive = [
  "src/agentts.ts",
  "tests/workflow-agentts.ts",
  "tests/workflow-json-boundary.ts",
  "tests/workflow-judges-module.ts",
  "tests/workflow-global-module.ts",
  "tests/workflow-nested-module.ts",
  "tests/workflow-failfast-module.ts",
  "tests/workflow-any-module.ts",
  "tests/workflow-race-module.ts",
].map((f) => path.join(ROOT, f));
const pos = tsc(["--noEmit", "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", ...positive]);
check(pos.status === 0, `positive files type-check (exit ${pos.status})${pos.status !== 0 ? ":\n" + pos.out : ""}`);
const negDir = path.join(ROOT, "tests", "type-negatives");
const negCases: [string, string][] = [
  ["neg-job-input.ts", "string"],
  ["neg-job-missing-spec.ts", "spec"],
  ["neg-job-output-mismatch.ts", "ScoreResult"],
  ["neg-job-one-type-arg.ts", "ScoreResult"],
  ["neg-exec-cmd.ts", "number"],
  ["neg-sleep-ms.ts", "string"],
  ["neg-gate-question.ts", "number"],
  ["neg-cron-at.ts", "number"],
  ["neg-decide-options.ts", "string"],
  ["neg-all-thunks.ts", "number"],
  ["neg-all-failfast-type.ts", "string"],
];
for (const [file, fragment] of negCases) {
  const r = tsc(["--noEmit", "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", path.join(negDir, file)]);
  check(r.status !== 0, `${file}: type-check FAILS as required (exit ${r.status})`);
  check(r.out.includes("error TS"), `${file}: tsc reports a type error`);
  check(r.out.includes(fragment), `${file}: error mentions ${JSON.stringify(fragment)}`);
}

// ------------------------------------------------------------------ part C
console.log("\n=== C. Bun.build stays small ===");
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const built = await Bun.build({
  entrypoints: [path.join(ROOT, "tests", "workflow-agentts.ts")],
  outdir: SCRATCH,
  target: "bun",
  naming: "bundle-agentts.js",
});
check(built.success, "Bun.build succeeds");
const bundlePath = path.join(SCRATCH, "bundle-agentts.js");
if (fs.existsSync(bundlePath)) {
  const size = fs.statSync(bundlePath).size;
  console.log(`bundle: ${size} bytes`);
  check(size < 16384, `bundle under 16 KiB (got ${size}; real zod measured 166,842 for the same shape)`);
}

console.log();
if (FAILURES.length) {
  console.log(`FAIL (${FAILURES.length} check(s))`);
  process.exit(1);
}
console.log("PASS agentts-module (wrappers + combinator identity + JSON boundary + tsc + bundle size)");
