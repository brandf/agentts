#!/usr/bin/env bun
/**
 * M2 checker tests (Linear BRA-29).
 *
 * Units: schema-compatibility matrix, layering on synthetic files,
 * layering self-check over the host tree. Gate-level: the contract
 * fixtures (class / empty / nested-empty), the wiring fixtures
 * (mismatch through any / as-cast / JSON round-trip, plus a passing
 * flow), the layering fixture, and the real workflows (the daily
 * briefing, the JudgeFixLoop workflow, the typed-valid workflow —
 * the checker must pass them: no false positives on real code).
 * The core's tests/type-negatives/ fixtures are folded in: every
 * one must be refused by the full gate (tsc), and the checker
 * itself must not throw on any of them.
 *
 * Run outputs go to a scratch dir (argv: ROOT is the host tree
 * under test, passed by run.sh; defaults to the parent of this
 * file). Exit 0 on PASS, 1 on any mismatch.
 */
import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  checkWorkflowFile,
  checkLayeringFiles,
  checkBunUsage,
  collectCheckerFiles,
  verifySchemaCompatibility,
  runChecker,
  checkerVersion,
  CheckerError,
} from "../src/checker";
import { GATE_COMPILER_OPTIONS, gateProgramRoots } from "../src/gate";
import { GateError } from "../src/gate";
import { ExtractionError } from "../src/extract";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(process.argv[2] ?? path.join(DIR, ".."));
const TESTS = path.join(ROOT, "tests", "workflows");
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), "checker-suite-"));
const CACHE = path.join(WORKDIR, "cache");
fs.mkdirSync(CACHE, { recursive: true });

const FAILURES: string[] = [];
function fail(msg: string): void {
  console.log(`FAIL: ${msg}`);
  FAILURES.push(msg);
}
function ok(msg: string): void {
  console.log(msg);
}
function check(cond: boolean, msg: string): void {
  if (cond) ok(msg);
  else fail(msg);
}

/** Expect fn() to throw CheckerError with a diagnostic whose code
 * is one of the given rules; return the error for further asserts. */
function expectCheckerError(fn: () => unknown, rules: string[], label: string): CheckerError | null {
  let threw: any = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!(threw instanceof CheckerError)) {
    fail(`${label}: expected CheckerError, got ${threw?.constructor?.name ?? "no throw"}${threw ? `: ${String(threw.message).slice(0, 200)}` : ""}`);
    return null;
  }
  const codes = threw.diagnostics.map((d) => d.code);
  check(
    codes.some((c) => rules.includes(c)),
    `${label}: diagnostic rule is one of ${rules.join("/")} (got ${codes.join(", ")})`,
  );
  check(
    threw.diagnostics.every((d) => typeof d.file === "string" && typeof d.line === "number" && typeof d.message === "string" && typeof d.fix === "string" && d.fix.length > 0),
    `${label}: every diagnostic is a structured record {file, line, column, code, message, fix}`,
  );
  return threw;
}

function expectPass(fn: () => unknown, label: string): void {
  try {
    fn();
    ok(`${label}: passed`);
  } catch (e) {
    fail(`${label}: expected a pass, got ${e instanceof Error ? e.constructor.name : typeof e}: ${String((e as Error)?.message ?? e).slice(0, 400)}`);
  }
}

// ------------------------------------------------------- schema compat
function testSchemaCompatibility(): void {
  console.log("\n=== schema compatibility matrix ===");
  const cases: Array<{ name: string; producer: any; consumer: any; mismatch: boolean }> = [
    {
      name: "identical object schemas",
      producer: { type: "object", properties: { score: { type: "number" }, label: { type: "string" } }, required: ["score", "label"] },
      consumer: { type: "object", properties: { score: { type: "number" }, label: { type: "string" } }, required: ["score", "label"] },
      mismatch: false,
    },
    {
      name: "producer supplies a superset of required props",
      producer: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a", "b"] },
      consumer: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      mismatch: false,
    },
    {
      name: "missing required property",
      producer: { type: "object", properties: { score: { type: "number" }, label: { type: "string" } }, required: ["score", "label"] },
      consumer: { type: "object", properties: { score: { type: "number" }, label: { type: "string" }, notes: { type: "string" } }, required: ["score", "label", "notes"] },
      mismatch: true,
    },
    {
      name: "optional consumer prop missing on the producer is fine",
      producer: { type: "object", properties: { score: { type: "number" } }, required: ["score"] },
      consumer: { type: "object", properties: { score: { type: "number" }, notes: { type: "string" } }, required: ["score"] },
      mismatch: false,
    },
    {
      name: "primitive type mismatch",
      producer: { type: "string" },
      consumer: { type: "number" },
      mismatch: true,
    },
    {
      name: "integer producer satisfies number consumer",
      producer: { type: "integer" },
      consumer: { type: "number" },
      mismatch: false,
    },
    {
      name: "nested mismatch names the path",
      producer: { type: "object", properties: { meta: { type: "object", properties: { n: { type: "string" } }, required: ["n"] } }, required: ["meta"] },
      consumer: { type: "object", properties: { meta: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } }, required: ["meta"] },
      mismatch: true,
    },
    {
      name: "array items mismatch",
      producer: { type: "array", items: { type: "string" } },
      consumer: { type: "array", items: { type: "number" } },
      mismatch: true,
    },
    {
      name: "unconstrained producer never fails",
      producer: {},
      consumer: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      mismatch: false,
    },
    {
      name: "anyOf: some branch fits",
      producer: { type: "string" },
      consumer: { anyOf: [{ type: "number" }, { type: "string" }] },
      mismatch: false,
    },
    {
      name: "anyOf: no branch fits",
      producer: { type: "boolean" },
      consumer: { anyOf: [{ type: "number" }, { type: "string" }] },
      mismatch: true,
    },
    {
      name: "date-time string satisfies a string consumer (format is annotation-only)",
      producer: { type: "string", format: "date-time" },
      consumer: { type: "string" },
      mismatch: false,
    },
  ];
  for (const c of cases) {
    const hit = verifySchemaCompatibility(c.producer, c.consumer, "$");
    check(
      (hit !== null) === c.mismatch,
      `SCHEMA ${c.mismatch ? "MISMATCH" : "OK"}: ${c.name}${hit ? ` — ${hit}` : ""}`,
    );
    if (c.name === "nested mismatch names the path") {
      check(!!hit && hit.includes("$.meta.n"), `SCHEMA OK: nested mismatch names $.meta.n (got: ${hit})`);
    }
  }
}

// ------------------------------------------------------------- layering
function testLayering(): void {
  console.log("\n=== layering boundary ===");
  const dir = path.join(WORKDIR, "layering");
  fs.mkdirSync(dir, { recursive: true });
  const write = (name: string, src: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, src);
    return p;
  };
  // A host file importing the muse adapter: violation.
  const bad = write("bad-host.ts", `import { MuseAdapter } from "../src/adapters/muse-adapter";\nvoid MuseAdapter;\n`);
  // A workflow importing from plugins/: two violations (MUSE + PLUGIN).
  // It lives under a workflows/ dir so the workflow layering rule
  // applies to it, as it does to real workflow files.
  const wfDir = path.join(dir, "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  const badWf = path.join(wfDir, "bad-workflow.ts");
  fs.writeFileSync(badWf, `import { createAdapter } from "../../plugins/muse/src/adapter";\nvoid createAdapter;\n`);
  // A layer-3 file importing the muse adapter: allowed.
  const museDir = path.join(dir, "plugins", "muse", "src");
  fs.mkdirSync(museDir, { recursive: true });
  const layer3 = path.join(museDir, "adapter.ts");
  fs.writeFileSync(layer3, `import { MuseAdapter } from "../../../src/adapters/muse-adapter";\nvoid MuseAdapter;\n`);
  // A clean host file: no violation.
  const clean = write("clean.ts", `import { MockAdapter } from "../src/adapters/mock-adapter";\nvoid MockAdapter;\n`);

  const found = checkLayeringFiles([bad, badWf, layer3, clean]);
  const byFile = new Map<string, string[]>();
  for (const d of found) {
    const list = byFile.get(d.file) ?? [];
    list.push(d.code);
    byFile.set(d.file, list);
  }
  check((byFile.get(bad) ?? []).includes("M2-LAYER-MUSE"), `LAYER OK: host file importing muse-adapter flagged M2-LAYER-MUSE (got ${JSON.stringify(byFile.get(bad))})`);
  check(
    (byFile.get(badWf) ?? []).includes("M2-LAYER-MUSE") && (byFile.get(badWf) ?? []).includes("M2-LAYER-PLUGIN"),
    `LAYER OK: workflow importing plugins/muse flagged MUSE + PLUGIN (got ${JSON.stringify(byFile.get(badWf))})`,
  );
  check(!(byFile.get(layer3) ?? []).length, `LAYER OK: layer-3 file importing the muse adapter is allowed (got ${JSON.stringify(byFile.get(layer3))})`);
  check(!(byFile.get(clean) ?? []).length, `LAYER OK: clean host file passes`);

  // Self-check: the host tree itself must be clean. Workflows,
  // src, plugins — but not tests/ (test drivers import broadly).
  const treeFiles: string[] = [];
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith(".ts")) treeFiles.push(p);
    }
  };
  for (const sub of ["src", "plugins", "workflows"]) walk(path.join(ROOT, sub));
  const selfFound = checkLayeringFiles(treeFiles);
  check(
    selfFound.length === 0,
    `LAYER OK: self-check over ${treeFiles.length} file(s) in src/ + plugins/ + workflows/ is clean` +
      (selfFound.length ? ` — ${selfFound.map((d) => `${d.file}:${d.line} ${d.code}`).join("; ")}` : ""),
  );
}

// -------------------------------------------------------------- contracts
function testContracts(): void {
  console.log("\n=== contract rules: class / empty ===");
  const errClass = expectCheckerError(
    () => checkWorkflowFile(path.join(TESTS, "workflow-checker-class.ts"), CACHE),
    ["M2-CLASS"],
    "CLASS",
  );
  if (errClass) {
    check(errClass.diagnostics[0].message.includes("class"), `CLASS OK: message names the class problem (got: ${errClass.diagnostics[0].message.slice(0, 160)})`);
    check(errClass.diagnostics[0].fix?.includes("interface") ?? false, `CLASS OK: fix hint says to use an interface`);
  }
  const errEmpty = expectCheckerError(
    () => checkWorkflowFile(path.join(TESTS, "workflow-checker-empty.ts"), CACHE),
    ["M2-EMPTY"],
    "EMPTY",
  );
  if (errEmpty) {
    check(errEmpty.diagnostics[0].message.includes("empty"), `EMPTY OK: message names the empty type`);
  }
  const errNested = expectCheckerError(
    () => checkWorkflowFile(path.join(TESTS, "workflow-checker-nested-empty.ts"), CACHE),
    ["M2-EMPTY"],
    "NESTED-EMPTY",
  );
  if (errNested) {
    check(
      errNested.diagnostics.some((d) => d.message.includes("$.meta")),
      `NESTED-EMPTY OK: the nested empty member is flagged at $.meta (got: ${errNested.diagnostics.map((d) => d.message.slice(0, 120)).join(" | ")})`,
    );
  }
}

// ----------------------------------------------------------------- wiring
function testWiring(): void {
  console.log("\n=== wiring verification ===");
  expectPass(
    () => checkWorkflowFile(path.join(TESTS, "workflow-checker-wiring-pass.ts"), CACHE),
    "WIRING-PASS",
  );
  for (const [name, file] of [
    ["any", "workflow-checker-wiring-any.ts"],
    ["cast", "workflow-checker-wiring-cast.ts"],
    ["json", "workflow-checker-wiring-json.ts"],
  ] as const) {
    const err = expectCheckerError(
      () => checkWorkflowFile(path.join(TESTS, file), CACHE),
      ["M2-WIRING"],
      `WIRING-${name.toUpperCase()}`,
    );
    if (err) {
      const d = err.diagnostics.find((x) => x.code === "M2-WIRING")!;
      check(
        d.message.includes("job:score") && d.message.includes("job:fix"),
        `WIRING-${name.toUpperCase()} OK: diagnostic names producer job:score and consumer job:fix`,
      );
      check(
        d.message.includes("notes"),
        `WIRING-${name.toUpperCase()} OK: diagnostic names the missing required property 'notes'`,
      );
      check(
        !!d.related && d.related.site === "job:score",
        `WIRING-${name.toUpperCase()} OK: related site points at the producer (job:score)`,
      );
      if (name !== "any") {
        check(
          d.message.includes("TypeScript could not check it"),
          `WIRING-${name.toUpperCase()} OK: diagnostic says tsc could not see this flow`,
        );
      }
    }
  }
}

// ------------------------------------------------------- real workflows
function testRealWorkflows(): void {
  console.log("\n=== real workflows must pass (no false positives) ===");
  // The daily briefing: JFL callbacks (verdicts/item/rubric/agg
  // parameters), .map fan-out (PaperCandidate nested in
  // DiscoveryResult), render → write (EditionMeta), reads → relate
  // (per-field flows). Every edge the tracer establishes must be
  // schema-compatible.
  expectPass(
    () => checkWorkflowFile(path.join(ROOT, "workflows", "daily-ai-briefing.ts"), CACHE),
    "BRIEFING",
  );
  expectPass(
    () => checkWorkflowFile(path.join(TESTS, "workflow-judge-fix-loop.ts"), CACHE),
    "JFL-WORKFLOW",
  );
  expectPass(
    () => checkWorkflowFile(path.join(TESTS, "workflow-typed-valid.ts"), CACHE),
    "TYPED-VALID",
  );
  // An empty INPUT type is the honest "takes no input" encoding
  // (the clock trap's ClockInput) — M2-EMPTY is output-only, so
  // this workflow must pass.
  expectPass(
    () => checkWorkflowFile(path.join(TESTS, "workflow-clock.ts"), CACHE),
    "EMPTY-INPUT-OK",
  );
  // The layering workflow: the import itself type-checks, so the
  // refusal must be the checker's, not tsc's.
  const err = expectCheckerError(
    () => checkWorkflowFile(path.join(TESTS, "workflow-checker-layering.ts"), CACHE),
    ["M2-LAYER-MUSE", "M2-LAYER-PLUGIN"],
    "LAYERING-WORKFLOW",
  );
  if (err) {
    check(
      err.diagnostics.some((d) => d.code === "M2-LAYER-MUSE") && err.diagnostics.some((d) => d.code === "M2-LAYER-PLUGIN"),
      `LAYERING-WORKFLOW OK: both layering rules fired`,
    );
  }
}

// ------------------------------------------------------------ Bun (BRA-58)
function testBun(): void {
  console.log("\n=== Bun global: type uses pass, value uses refused (M2-BUN) ===");
  // The value fixture: tsc passes (the gate program includes
  // bun-types), so the refusal MUST be the checker's M2-BUN — not a
  // GateError. That is the whole point: the gate knows Bun types,
  // the checker knows the engine has no Bun global.
  const err = expectCheckerError(
    () => checkWorkflowFile(path.join(TESTS, "workflow-bun-value.ts"), CACHE),
    ["M2-BUN"],
    "BUN-VALUE",
  );
  if (err) {
    const d = err.diagnostics.find((x) => x.code === "M2-BUN")!;
    check(d.message.includes("Bun global"), `BUN-VALUE OK: diagnostic names the Bun global`);
    check(d.fix?.includes("adapter") ?? false, `BUN-VALUE OK: fix hint points at the adapter`);
    check(
      err.diagnostics.every((x) => x.code === "M2-BUN"),
      `BUN-VALUE OK: the only refusal is M2-BUN (got ${err.diagnostics.map((x) => x.code).join(",")})`,
    );
  }
  // The type-only fixture passes the whole gate (tsc + extract +
  // checker) — a Bun type that erases at runtime is legal.
  expectPass(
    () => checkWorkflowFile(path.join(TESTS, "workflow-bun-type.ts"), CACHE),
    "BUN-TYPE",
  );
  // Direct unit: the edge cases on one synthetic file — a value call,
  // a type use, a property named Bun, a local binding named Bun,
  // globalThis.Bun, typeof Bun as a value. Exactly three flags, at
  // the value-use lines (5, 10, 11).
  const dir = path.join(WORKDIR, "bun");
  fs.mkdirSync(dir, { recursive: true });
  const edge = path.join(dir, "edge.ts");
  fs.writeFileSync(
    edge,
    [
      `declare function trap<Input, Output>(type: string, arg: unknown): unknown;`,
      `declare function print(...args: unknown[]): void;`,
      `interface ScoreInput { value: number; }`,
      `interface ScoreResult { score: number; label: string; }`,
      `Bun.sleepSync(1);`,
      `function label(f: Bun.BunFile): string { return f.name ?? ""; }`,
      `const local = { Bun: 1 };`,
      `print(local.Bun);`,
      `function useLocal(Bun: { sleepSync(ms: number): void }): void { Bun.sleepSync(1); }`,
      `globalThis.Bun.sleepSync(1);`,
      `const t = typeof Bun;`,
      `print(t);`,
      `const j = trap<ScoreInput, ScoreResult>("job", { spec: "score", input: { value: 7 } }) as ScoreResult;`,
      `print("job:", JSON.stringify(j));`,
      `print("done");`,
      ``,
    ].join("\n"),
  );
  const program = ts.createProgram(gateProgramRoots(edge), GATE_COMPILER_OPTIONS);
  program.getSemanticDiagnostics();
  const found = checkBunUsage(program, collectCheckerFiles(edge));
  const lines = found.map((d) => d.line);
  check(
    JSON.stringify(lines) === JSON.stringify([5, 10, 11]),
    `BUN-EDGE OK: exactly the value uses flagged, at lines 5/10/11 (got ${JSON.stringify(lines)})`,
  );
  check(
    found.every((d) => d.code === "M2-BUN"),
    `BUN-EDGE OK: every diagnostic is M2-BUN`,
  );
}

// --------------------------------------------------------- type negatives
function resolveTypeNegativesDir(): string | null {
  const candidates = [
    process.env.AGENTTS_CORE_DIR ? path.join(process.env.AGENTTS_CORE_DIR, "tests", "type-negatives") : "",
    path.join(ROOT, "..", "agentts-repo", "packages", "durablets", "tests", "type-negatives"),
    path.join(ROOT, "..", "..", "packages", "durablets", "tests", "type-negatives"),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function testTypeNegatives(): void {
  console.log("\n=== core type-negatives fixtures (M2 territory, folded in) ===");
  const dir = resolveTypeNegativesDir();
  if (!dir) {
    fail("TYPE-NEGATIVES: could not locate packages/durablets/tests/type-negatives (tried working-dir, staged, $AGENTTS_CORE_DIR)");
    return;
  }
  const fixtures = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("neg-") && f.endsWith(".ts"))
    .sort();
  check(fixtures.length === 11, `TYPE-NEGATIVES OK: found ${fixtures.length} fixtures (expected 11)`);
  for (const f of fixtures) {
    const p = path.join(dir, f);
    // The full gate refuses each one (tsc): the checker test proves
    // the gate-as-a-whole catches the class.
    let threw: any = null;
    try {
      checkWorkflowFile(p, CACHE);
    } catch (e) {
      threw = e;
    }
    check(
      threw instanceof GateError && Array.isArray(threw.diagnostics) && threw.diagnostics.length >= 1,
      `TYPE-NEGATIVES OK: ${f} refused at the gate (${threw?.constructor?.name ?? "no throw"}${threw instanceof GateError ? `, ${threw.diagnostics.length} diagnostic(s), first TS${threw.diagnostics[0]?.code}` : ""})`,
    );
    // And the checker itself must not throw on a type-erroring
    // program (it runs after tsc in the real gate, but it must be
    // robust to error types — no crash, no false CheckerError).
    try {
      const program = ts.createProgram([p], GATE_COMPILER_OPTIONS);
      program.getSemanticDiagnostics();
      runChecker(program, p, { sites: {} });
      ok(`TYPE-NEGATIVES OK: checker does not throw on ${f}`);
    } catch (e) {
      fail(`TYPE-NEGATIVES: checker threw on ${f}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
  }
}

// ------------------------------------------------------------ cache record
function testCacheRecord(): void {
  console.log("\n=== cache entry records the checker ===");
  const wf = path.join(TESTS, "workflow-checker-wiring-pass.ts");
  const source = fs.readFileSync(wf, "utf8");
  const hash = crypto.createHash("sha256").update(source).digest("hex");
  checkWorkflowFile(wf, CACHE);
  const entryPath = path.join(CACHE, `${hash}.json`);
  if (!fs.existsSync(entryPath)) {
    fail(`CACHE OK: no cache entry written for the passing workflow (expected ${entryPath})`);
    return;
  }
  const entry = JSON.parse(fs.readFileSync(entryPath, "utf8"));
  check(entry.gate?.passed === true, `CACHE OK: entry records gate.passed`);
  check(
    entry.gate?.checkerVersion === checkerVersion(),
    `CACHE OK: entry records checkerVersion ${checkerVersion()} (got ${entry.gate?.checkerVersion})`,
  );
  check(
    entry.gate?.compilerVersion === ts.version,
    `CACHE OK: entry records compilerVersion ${ts.version}`,
  );
  // A checker-failing workflow must NOT leave a gated cache entry.
  const badWf = path.join(TESTS, "workflow-checker-class.ts");
  const badHash = crypto.createHash("sha256").update(fs.readFileSync(badWf, "utf8")).digest("hex");
  try {
    checkWorkflowFile(badWf, CACHE);
  } catch {
    /* expected */
  }
  const badEntry = path.join(CACHE, `${badHash}.json`);
  check(
    !fs.existsSync(badEntry),
    `CACHE OK: checker-failing workflow left no cache entry (a throw aborts before the write)`,
  );
}

function main(): number {
  testSchemaCompatibility();
  testLayering();
  testContracts();
  testWiring();
  testBun();
  testRealWorkflows();
  testTypeNegatives();
  testCacheRecord();
  console.log();
  if (FAILURES.length) {
    console.log(`FAIL (${FAILURES.length} check(s)):`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log(
    "PASS checker (BRA-29: schema compatibility + layering + class/empty contracts + wiring + real workflows + type-negatives + cache record)",
  );
  return 0;
}

process.exit(main());
