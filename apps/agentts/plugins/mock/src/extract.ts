// extract — type extraction for trap contracts (BRA-46 correction,
// Brandon 19:36 PST; reconciled with the landed BRA-46 module).
// TypeScript types are the ONLY source of truth; schemas are EXTRACTED
// by the host at first run. No author-visible schemas, no codegen step
// the author has to think about.
//
// How it works (v2 — the boxing transform is GONE, see below):
//  1. The author writes plain TS. The agentts module's wrappers carry
//     the contract at the call site:
//       job<Input, Output>({ spec: "score", input: {...} })  // 2 type args
//       decide<Output>({ question, options })                // 1 type arg
//       exec/gate/sleep/cron({...})                          // 0 type args:
//         their result types are FIXED by the trap type — the host uses
//         the module's exported result interfaces (ExecResult, ...).
//     Direct trap() calls carry the contract either as two type args
//     (<Input, Output>) or as a named `as` cast / variable annotation
//     on the result. A call with no extractable type fails loudly.
//  2. At first run (or when the workflow source hash changes — or the
//     agentts module it imports changes) this module walks the workflow
//     AST, reads the type arguments at every trap/wrapper call site,
//     and runs ts-json-schema-generator over the workflow source (and,
//     for the fixed wrappers, over the agentts module) to produce JSON
//     Schema for each type (input schema AND output schema). The
//     schemas are cached keyed by the workflow content hash — a derived
//     cache, not an artifact — and pinned with the frozen copy of the
//     source, so the validation contract cannot drift mid-run.
//  3. NO TRANSFORM. The trap arg is exactly the spec object the author
//     passed, verbatim — no added fields, no wrapping (the landed
//     module guarantees this, and the journal's trap event arg is the
//     spec). So the plugin cannot map a runtime trap to its site by a
//     boxed site id. Instead the site table is keyed by the RUNTIME
//     key (see siteKeyFor, shared with the plugin's dispatch):
//       job:<spec>  — module job calls (spec is the jobspec name, and
//                     the jobspec IS the contract identity: two sites
//                     with the same spec must agree on their types)
//       job:<op>    — direct job calls whose arg is a literal with an
//                     `op` string (the old core-suite shape)
//       <type>      — everything else (decide, exec, gate, sleep, cron,
//                     clock, and direct job calls whose arg is not a
//                     literal — e.g. step() passing `input`)
//     Sites mapping to the same key must agree on (input, output)
//     types; a conflict is a loud failure. At dispatch the plugin
//     tries the specific key, then falls back to the bare type key
//     (covers direct calls whose arg is an identifier at the call
//     site but carries a spec/op at runtime).
//  4. Fail loudly at first run: a trap call with missing / non-named /
//     non-extractable type arguments, a job call whose spec is not a
//     string literal, a type that contains non-JSON-like data
//     (functions, unknown/any → unconstrained `{}`, Date is fine —
//     the generator maps it to a date-time string), or two sites
//     disagreeing on one key, aborts extraction with every offending
//     call site listed. The run never starts. There is NO silent skip:
//     a trap with no extractable type is a loud failure, not an
//     unvalidated trap.
//
// What the plugin does with the extracted schemas: it enforces the
// OUTPUT side (JSON-clean check first — the module's toJsonValue —
// then AJV validation against the cached output schema — see
// validate.ts and mock-plugin.ts). The INPUT schema is extracted and
// cached for the arg-in enforcers (agentts module + core, BRA-43
// follow-up); the plugin does NOT validate args — it receives them as
// JSON by construction. An input schema is null when the call site
// declares no input type (a direct trap() with a literal arg and no
// type args); that is recorded, not a failure — the plugin never
// enforces input, and the arg-in enforcer derives what it needs from
// the runtime value.

import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createGenerator } from "ts-json-schema-generator";
import { GATE_COMPILER_OPTIONS, CHECKER_VERSION, gateProgramRoots } from "./gate";

export const WRAPPER_NAMES = new Set([
  "job",
  "decide",
  "exec",
  "gate",
  "sleep",
  "cron",
]);

/** Fixed (input, output) type names per wrapper, from the agentts module. */
export const FIXED_WRAPPER_TYPES: Record<string, [string, string]> = {
  exec: ["ExecSpec", "ExecResult"],
  gate: ["GateSpec", "GateResult"],
  sleep: ["SleepSpec", "SleepResult"],
  cron: ["CronSpec", "CronResult"],
};

export interface SiteCall {
  line: number;
  column: number;
  kind: string;
}

export interface SiteEntry {
  /** Runtime key (see siteKeyFor). */
  key: string;
  /** Named input type, or null when the call site declares none. */
  inputType: string | null;
  /** Named output type. */
  outputType: string;
  /** JSON Schema for the input type, or null when inputType is null. */
  inputSchema: any | null;
  /** JSON Schema for the output type. */
  outputSchema: any;
  callSites: SiteCall[];
}

export interface Extraction {
  sourceHash: string;
  /** Frozen copy of the workflow source the schemas were derived from. */
  source: string;
  /** SHA-256 of the agentts module the workflow imports, or null when
   * the workflow imports no agentts module (a module change must
   * invalidate the cache, since fixed-type schemas come from it). */
  moduleHash: string | null;
  /** Site table keyed by runtime key. */
  sites: Record<string, SiteEntry>;
  /** The first-run gate result for this content hash. A cache entry
   * is only trusted when gate.passed is true AND the compiler
   * version matches the one installed now AND the checker version
   * matches (a rule change re-gates + re-checks every workflow) —
   * a cached result is bound to the compiler AND the checker that
   * produced it (the gate's behavior must be reproducible). An entry
   * written without the gate (a standalone extraction, or an older
   * version) has gate null and is re-gated + re-extracted on next use. */
  gate: { passed: true; checkedAt: string; compilerVersion: string; checkerVersion: string } | null;
}

export class ExtractionError extends Error {
  readonly details: string[];
  constructor(details: string[]) {
    super(
      `type extraction failed for ${details.length} trap call site(s):\n` +
        details.map((d) => `  - ${d}`).join("\n"),
    );
    this.name = "ExtractionError";
    this.details = details;
  }
}

function loc(sf: ts.SourceFile, node: ts.Node): string {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${line + 1}:${character + 1}`;
}

/** The runtime key for a trap of this type with this arg — the SAME
 * rule the extractor applies statically and the plugin applies at
 * dispatch, so the two can never disagree. A job's spec/op string is
 * the contract identity; anything else keys by trap type alone. */
export function siteKeyFor(type: string, arg: any): string {
  if (type === "job" && arg !== null && typeof arg === "object" && !Array.isArray(arg)) {
    if (typeof arg.spec === "string") return `job:${arg.spec}`;
    if (typeof arg.op === "string") return `job:${arg.op}`;
  }
  return type;
}

/** The type argument must be a single named type reference. */
function readTypeArg(
  arg: ts.TypeNode | undefined,
  which: "input" | "output",
  where: string,
  problems: string[],
): string | null {
  if (!arg) {
    problems.push(
      `${where}: missing ${which} type argument — write trap<${which === "input" ? "Input" : "Output"}, ...> with a concrete, named type`,
    );
    return null;
  }
  if (!ts.isTypeReferenceNode(arg)) {
    const text = arg.getText();
    problems.push(
      `${where}: ${which} type argument \`${text}\` is not a concrete, named type — name it with an interface or type alias (e.g. \`type ${which === "input" ? "ScoreInput" : "ScoreResult"} = ${text}\`)`,
    );
    return null;
  }
  const name = arg.typeName.getText();
  if (name === "unknown" || name === "any") {
    problems.push(
      `${where}: ${which} type argument \`${name}\` has nothing to extract — use a concrete, named type`,
    );
    return null;
  }
  return arg.getText();
}

/** A generated schema containing an empty `{}` subschema is
 * unconstrained somewhere — unknown/any (or another unrepresentable
 * part) leaked in. That is a loud failure, not a pass. */
function findEmptySubschema(schema: any, trail: string[] = []): string | null {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return null;
  const keys = Object.keys(schema);
  if (keys.length === 0) return trail.join("") || "$";
  for (const k of keys) {
    const v = (schema as any)[k];
    if (k === "properties" && v && typeof v === "object") {
      for (const prop of Object.keys(v)) {
        const hit = findEmptySubschema(v[prop], [...trail, `.${prop}`]);
        if (hit) return hit;
      }
    } else if (k === "items" || k === "additionalProperties") {
      const hit = findEmptySubschema(v, [...trail, `.${k}`]);
      if (hit) return hit;
    } else if ((k === "anyOf" || k === "oneOf" || k === "allOf") && Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const hit = findEmptySubschema(v[i], [...trail, `[${k} ${i}]`]);
        if (hit) return hit;
      }
    } else if ((k === "definitions" || k === "$defs") && v && typeof v === "object") {
      for (const def of Object.keys(v)) {
        const hit = findEmptySubschema(v[def], [...trail, `#/${k}/${def}`]);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** Read a string-literal property off an object literal argument. */
function literalProp(arg: ts.Expression | undefined, prop: string): string | null {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const p of arg.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === prop &&
      ts.isStringLiteral(p.initializer)
    ) {
      return p.initializer.text;
    }
  }
  return null;
}

/** The result type a direct trap() call declares without type args:
 * an `as` cast (must name a type) or the receiving variable's
 * annotation. Returns the named type text + its TypeNode, or null
 * when the call declares nothing — the caller records the problem. */
function declaredResultType(call: ts.CallExpression): {
  type: string | null;
  node: ts.TypeNode | null;
  problem: string | null;
} {
  const parent = call.parent;
  if (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
    const t = parent.type;
    if (ts.isTypeReferenceNode(t)) {
      const name = t.typeName.getText();
      if (name === "unknown" || name === "any") {
        return { type: null, node: null, problem: `result type \`${name}\` has nothing to extract — use a concrete, named type` };
      }
      return { type: t.getText(), node: t, problem: null };
    }
    return {
      type: null,
      node: null,
      problem: `result type \`${t.getText()}\` is not a concrete, named type — name it with an interface or type alias`,
    };
  }
  if (ts.isVariableDeclaration(parent) && parent.type) {
    const t = parent.type;
    if (ts.isTypeReferenceNode(t)) {
      const name = t.typeName.getText();
      if (name === "unknown" || name === "any") {
        return { type: null, node: null, problem: `result type \`${name}\` has nothing to extract — use a concrete, named type` };
      }
      return { type: t.getText(), node: t, problem: null };
    }
    return {
      type: null,
      node: null,
      problem: `result type \`${t.getText()}\` is not a concrete, named type — name it with an interface or type alias`,
    };
  }
  return { type: null, node: null, problem: null };
}

/** The input type an identifier arg declares: scan the file for a
 * variable/parameter declaration of that name with a named type
 * annotation. Returns the type text + its TypeNode, or null when not
 * declared. */
function declaredArgType(sf: ts.SourceFile, name: string): { type: string; node: ts.TypeNode } | null {
  let found: { type: string; node: ts.TypeNode } | null = null;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.type &&
      ts.isTypeReferenceNode(node.type)
    ) {
      found = { type: node.type.getText(), node: node.type };
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

/** The JSON-like pre-check, adapted from the BRA-46 extractor probe
 * (agentts-durablets/extractor-probe/probe.ts — the probe's
 * convertInner, rejection-only). ts-json-schema-generator silently
 * drops what it cannot represent: a Map becomes {type:"object",
 * properties:{size}} and a class loses its methods — schemas that
 * validate values the runtime would reject. The checker walk catches
 * those BEFORE generation, so the failure is loud and precise. Date
 * is the one exception (maps to date-time, mirroring the module's
 * runtime Date → ISO conversion). Recursive types are handled by
 * the ancestors set: a re-encountered type is already being checked
 * — the cycle is fine, the type is JSON-like if its other members
 * are. */
function isLibDate(t: ts.Type): boolean {
  const sym = t.getSymbol() ?? t.aliasSymbol;
  if (!sym || sym.getName() !== "Date") return false;
  const decls = sym.getDeclarations() ?? [];
  return decls.some((d) => /\/lib\.[^/]*\.d\.ts$/.test(d.getSourceFile().fileName));
}

function checkJsonLikeType(
  checker: ts.TypeChecker,
  t: ts.Type,
  path: string,
  label: string,
  ancestors: Set<ts.Type>,
  problems: string[],
): void {
  const flags = t.getFlags();
  if (flags & ts.TypeFlags.Any) {
    problems.push(`${label} at ${path}: type is any — supply a concrete named type`);
    return;
  }
  if (flags & ts.TypeFlags.Unknown) {
    problems.push(`${label} at ${path}: type is unknown — supply a concrete named type`);
    return;
  }
  if (flags & ts.TypeFlags.TypeParameter) {
    problems.push(`${label} at ${path}: unresolved type parameter ${checker.typeToString(t)} — the M2 checker requires concrete, named types at the call site`);
    return;
  }
  if (flags & ts.TypeFlags.Undefined) {
    problems.push(`${label} at ${path}: type is undefined — use null, not undefined, for no value`);
    return;
  }
  if (flags & ts.TypeFlags.Void) {
    problems.push(`${label} at ${path}: type is void — not JSON-like`);
    return;
  }
  if (
    flags &
    (ts.TypeFlags.String |
      ts.TypeFlags.Number |
      ts.TypeFlags.Boolean |
      ts.TypeFlags.Null |
      ts.TypeFlags.StringLiteral |
      ts.TypeFlags.NumberLiteral |
      ts.TypeFlags.BooleanLiteral |
      ts.TypeFlags.EnumLiteral |
      ts.TypeFlags.Enum)
  ) {
    return; // leaf
  }
  if (isLibDate(t)) return; // Date exception
  if (t.getCallSignatures().length > 0) {
    problems.push(`${label} at ${path}: type ${checker.typeToString(t)} is a function — functions cannot cross a trap boundary`);
    return;
  }
  const sym = t.getSymbol() ?? t.aliasSymbol;
  const symName = sym?.getName();
  if (
    symName === "Map" ||
    symName === "Set" ||
    symName === "WeakMap" ||
    symName === "WeakSet" ||
    symName === "Promise" ||
    symName === "RegExp"
  ) {
    problems.push(`${label} at ${path}: type ${checker.typeToString(t)} is a ${symName} — not JSON-like`);
    return;
  }
  if (ancestors.has(t)) return; // recursive — already being checked
  ancestors.add(t);
  try {
    if (t.isUnion()) {
      const members = t.types.filter((m) => !(m.getFlags() & ts.TypeFlags.Undefined));
      if (members.length === 0) {
        problems.push(`${label} at ${path}: union is only undefined — use null instead`);
        return;
      }
      for (const m of members) checkJsonLikeType(checker, m, path, label, ancestors, problems);
      return;
    }
    if (t.isIntersection()) {
      for (const m of t.types) checkJsonLikeType(checker, m, path, label, ancestors, problems);
      return;
    }
    if (checker.isArrayType(t)) {
      const el = (t as ts.TypeReference).typeArguments?.[0];
      if (!el) {
        problems.push(`${label} at ${path}: array without an element type`);
        return;
      }
      checkJsonLikeType(checker, el, `${path}[]`, label, ancestors, problems);
      return;
    }
    if (checker.isTupleType(t)) {
      const els = (t as ts.TypeReference).typeArguments ?? [];
      els.forEach((el, i) => checkJsonLikeType(checker, el, `${path}[${i}]`, label, ancestors, problems));
      return;
    }
    if (flags & ts.TypeFlags.Object) {
      const props = checker.getPropertiesOfType(t);
      for (const prop of props) {
        const decl = prop.valueDeclaration ?? prop.getDeclarations()?.[0];
        let pt = checker.getTypeOfSymbolAtLocation(prop, decl ?? (t as unknown as ts.Node));
        if (pt.isUnion()) {
          const rest = pt.types.filter((m) => !(m.getFlags() & ts.TypeFlags.Undefined));
          if (rest.length === 0) {
            problems.push(`${label} at ${path}.${prop.getName()}: property is only undefined — use null instead`);
            continue;
          }
          pt = rest.length === 1 ? rest[0] : checker.getUnionType(rest);
        }
        checkJsonLikeType(checker, pt, `${path}.${prop.getName()}`, label, ancestors, problems);
      }
      const strIdx = t.getStringIndexType();
      if (strIdx) checkJsonLikeType(checker, strIdx, `${path}[string]`, label, ancestors, problems);
      else {
        const numIdx = t.getNumberIndexType();
        if (numIdx) checkJsonLikeType(checker, numIdx, `${path}[number]`, label, ancestors, problems);
      }
      return;
    }
  } finally {
    ancestors.delete(t);
  }
  problems.push(`${label} at ${path}: type ${checker.typeToString(t)} cannot be extracted — simplify it to plain JSON-like data`);
}

/** Resolve a contract type to a checker type: from its TypeNode when
 * the call site supplies one (type arguments, `as` casts, variable
 * annotations — this resolves imports and generic instantiations
 * correctly), or by declaration name in the given file (the module's
 * fixed types, which have no call-site node). */
function resolveContractType(
  checker: ts.TypeChecker,
  program: ts.Program,
  file: string,
  name: string,
  node?: ts.TypeNode,
): ts.Type | null {
  if (node) return checker.getTypeFromTypeNode(node);
  const sf = program.getSourceFile(file);
  if (!sf) return null;
  for (const st of sf.statements) {
    if (
      (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st)) &&
      st.name?.text === name
    ) {
      const sym = checker.getSymbolAtLocation(st.name);
      if (!sym) return null;
      return checker.getDeclaredTypeOfSymbol(sym);
    }
  }
  return null;
}

/** Resolve the agentts module a workflow imports (the file the
 * host's fixed-type schemas and the pre-check resolve from). The
 * workflow's own import specifier decides — the plugin's copy is
 * only the fallback when the workflow imports no agentts module
 * (fixed types cannot arise then anyway). */
function resolveAgenttsModule(source: string, workflowDir: string): string | null {
  const probe = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, false);
  for (const st of probe.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.includes("agentts")) {
      const resolved = ts.resolveModuleName(
        st.moduleSpecifier.text,
        path.join(workflowDir, "probe.ts"),
        GATE_COMPILER_OPTIONS,
        ts.sys,
      );
      if (resolved.resolvedModule) return resolved.resolvedModule.resolvedFileName;
    }
  }
  return null;
}

export function extractWorkflow(
  workflowPath: string,
  cacheDir: string,
  opts?: {
    /** Called once per first run (cache miss), with the program the
     * host built for this workflow — the host runs the first-run gate
     * in this hook (it throws GateError when the workflow does not
     * type-check). The hook is what makes the cache entry gated: an
     * entry is only written with gate.passed when the hook ran. A
     * standalone extraction (no hook) writes gate null. */
    onFirstRun?: (program: ts.Program) => void;
    /** Called once per first run, after the sites + schemas are
     * built but BEFORE the cache entry is written — the host runs
     * the M2 checker in this hook (it throws CheckerError when a
     * rule fails). A throw aborts before the write, so a
     * checker-failing workflow is never cached as gated. */
    onExtracted?: (entry: Extraction, program: ts.Program) => void;
  },
): Extraction {
  const abs = path.resolve(workflowPath);
  const source = fs.readFileSync(abs, "utf8");
  const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${sourceHash}.json`);
  // The agentts module this workflow imports (resolved from its own
  // import specifier) — the fixed-type schemas and the pre-check
  // resolve from this file, and its hash invalidates the cache.
  const importedModule = resolveAgenttsModule(source, path.dirname(abs));
  const modulePath = importedModule ?? path.join(import.meta.dir, "agentts.ts");
  const moduleHash = fs.existsSync(modulePath)
    ? crypto.createHash("sha256").update(fs.readFileSync(modulePath)).digest("hex")
    : null;
  if (fs.existsSync(cachePath)) {
    try {
      const entry = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Extraction;
      // Pinned with the frozen copy: the cached source must hash to the
      // same content hash, or the entry is stale and gets re-extracted.
      // A changed agentts module also invalidates (fixed-type schemas
      // come from it) — but only for workflows that import it. And an
      // entry is only trusted when its gate passed: an ungated entry
      // is re-gated + re-extracted.
      if (
        entry.sourceHash === sourceHash &&
        crypto.createHash("sha256").update(entry.source).digest("hex") === sourceHash &&
        (entry.moduleHash === null || entry.moduleHash === moduleHash) &&
        entry.gate?.passed === true &&
        entry.gate.compilerVersion === ts.version &&
        entry.gate.checkerVersion === CHECKER_VERSION
      ) {
        return entry;
      }
    } catch {
      // Corrupt cache entry: fall through and re-extract.
    }
  }

  // Cache miss: build the program once for this first run. The host
  // runs the first-run gate on it (CHECK, via the onFirstRun hook —
  // throws GateError when the workflow does not type-check), and the
  // extraction pre-check below reuses the same program — the gate and
  // the extraction are the same first-run step, not two program
  // constructions. A standalone extraction (no hook) still builds the
  // program for the pre-check, but writes gate null: the entry is
  // only trusted as gated when the hook ran. The roots include
  // bun-types when resolvable (gateProgramRoots, BRA-58), so the
  // gate, the extraction, and the checker all see the same `Bun`
  // types.
  const program = ts.createProgram(gateProgramRoots(abs), GATE_COMPILER_OPTIONS);
  opts?.onFirstRun?.(program);

  // Force the checker to bind the program's files: createProgram does
  // NOT set parent pointers, and the walk below needs them (getText(),
  // call.parent). getSemanticDiagnostics binds (and its results are
  // cached, so the gate's checkProgram reuses them — this is the same
  // computation, not a second one). Without this, getText() throws
  // "sourceFile.text" on program nodes.
  program.getSemanticDiagnostics();

  // Walk the PROGRAM's SourceFile, not a fresh parse: the checker can
  // only resolve types from nodes that belong to the program — nodes
  // from a standalone createSourceFile resolve to `any`, which the
  // pre-check would (correctly but uselessly) reject.
  const sf = program.getSourceFile(abs);
  if (!sf) {
    throw new ExtractionError([`could not load ${abs} into the type-checker program`]);
  }
  const problems: string[] = [];

  // Which names are the agentts module's wrappers in this file: the
  // names imported from a module specifier containing "agentts".
  const importedWrappers = new Set<string>();
  let importsAgentts = false;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.includes("agentts")) {
      importsAgentts = true;
      const clause = st.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          importedWrappers.add(el.name.text);
        }
      }
    }
  }
  // Local declarations of the wrapper names (a workflow's own helper
  // named job/exec/... is not a trap call).
  const localNames = new Set<string>();
  function collectLocals(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) localNames.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) localNames.add(node.name.text);
    ts.forEachChild(node, collectLocals);
  }
  collectLocals(sf);

  interface FoundSite {
    key: string;
    kind: string;
    line: number;
    column: number;
    inputType: string | null;
    outputType: string;
    /** Files to generate this site's types from: the input type and
     * the output type can live in different files (decide's input
     * DecideSpec is in the module, its output in the workflow). */
    inputFile: string | null;
    outputFile: string;
    /** TypeNodes the checker resolves the contract types from (the
     * call site's type arguments, or an `as` cast / annotation).
     * Fixed module types have no node here — they resolve by
     * declaration name in the module file. */
    inputNode?: ts.TypeNode;
    outputNode?: ts.TypeNode;
  }
  const found: FoundSite[] = [];

  function pushSite(
    node: ts.CallExpression,
    key: string,
    kind: string,
    inputType: string | null,
    outputType: string | null,
    inputFile: string | null,
    outputFile: string,
    inputNode?: ts.TypeNode,
    outputNode?: ts.TypeNode,
  ): void {
    if (!outputType) return; // problem already recorded
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ key, kind, line: line + 1, column: character + 1, inputType, outputType, inputFile, outputFile, inputNode, outputNode });
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name !== null && (name === "trap" || WRAPPER_NAMES.has(name))) {
        const where = `${abs}:${loc(sf, node)}`;
        const args = node.typeArguments ?? [];
        if (name === "trap") {
          // Direct trap() call.
          const first = node.arguments[0];
          const trapType = first && ts.isStringLiteral(first) ? first.text : null;
          if (trapType === null) {
            problems.push(`${where}: trap type must be a string literal so the host can map the trap to its contract`);
          } else {
            let inputType: string | null = null;
            let outputType: string | null = null;
            let inputNode: ts.TypeNode | undefined;
            let outputNode: ts.TypeNode | undefined;
            if (args.length > 0) {
              if (args.length !== 2) {
                problems.push(
                  `${where}: trap call \`${name}\` has ${args.length} type argument(s) — it must carry exactly two, <Input, Output>, both concrete, named types`,
                );
              } else {
                inputType = readTypeArg(args[0], "input", where, problems);
                outputType = readTypeArg(args[1], "output", where, problems);
                inputNode = args[0];
                outputNode = args[1];
              }
            } else {
              const declared = declaredResultType(node);
              if (declared.problem) problems.push(`${where}: ${declared.problem}`);
              else if (!declared.type) {
                problems.push(
                  `${where}: trap call has no type arguments and no result type — it must carry exactly two, <Input, Output>, both concrete, named types, or name the result with an \`as\` cast / variable annotation (e.g. \`as JobResult\`)`,
                );
              } else {
                outputType = declared.type;
                outputNode = declared.node ?? undefined;
                const argExpr = node.arguments[1];
                if (argExpr && ts.isIdentifier(argExpr)) {
                  const argDeclared = declaredArgType(sf, argExpr.text);
                  if (argDeclared) {
                    inputType = argDeclared.type;
                    inputNode = argDeclared.node;
                  }
                }
                // A literal arg declares no input type: input stays
                // null (recorded, not a failure — the plugin never
                // enforces input).
              }
            }
            if (inputType !== null || outputType !== null) {
              // Static key: a literal arg's spec/op string, else the type.
              const argExpr = node.arguments[1];
              let key = trapType;
              if (trapType === "job") {
                const spec = literalProp(argExpr, "spec") ?? literalProp(argExpr, "op");
                if (spec !== null) key = `job:${spec}`;
              }
              pushSite(node, key, "trap", inputType, outputType, abs, abs, inputNode, outputNode);
            }
          }
        } else if (importedWrappers.has(name)) {
          // Module wrapper call.
          if (name === "job") {
            if (args.length !== 2) {
              problems.push(
                `${where}: job(...) has ${args.length} type argument(s) — it must carry exactly two, <Input, Output>, both concrete, named types`,
              );
            }
            const inputType = readTypeArg(args[0], "input", where, problems);
            const outputType = readTypeArg(args[1], "output", where, problems);
            const spec = literalProp(node.arguments[0], "spec");
            if (spec === null) {
              problems.push(
                `${where}: job spec must be a string literal so the host can map the trap to its contract (job:<spec>) — write job<...>({ spec: "score", input: ... })`,
              );
            }
            if (inputType && outputType && spec !== null) {
              pushSite(node, `job:${spec}`, "job", inputType, outputType, abs, abs, args[0], args[1]);
            }
          } else if (name === "decide") {
            if (args.length !== 1) {
              problems.push(
                `${where}: decide(...) has ${args.length} type argument(s) — it must carry exactly one, <Output>, a concrete, named type`,
              );
            }
            const outputType = readTypeArg(args[0], "output", where, problems);
            if (outputType) {
              // Input DecideSpec lives in the module; the output type
              // is declared in the workflow.
              pushSite(node, "decide", "decide", "DecideSpec", outputType, modulePath, abs, undefined, args[0]);
            }
          } else {
            // Fixed-result wrappers: no type args, types from the module.
            if (args.length !== 0) {
              problems.push(
                `${where}: ${name}(...) carries ${args.length} type argument(s) — it carries none; its result type is fixed by the trap type (${FIXED_WRAPPER_TYPES[name][1]} from the agentts module)`,
              );
            } else {
              const [inputType, outputType] = FIXED_WRAPPER_TYPES[name];
              pushSite(node, name, name, inputType, outputType, modulePath, modulePath);
            }
          }
        } else if (!localNames.has(name)) {
          problems.push(
            `${where}: \`${name}(...)\` is called but is not imported from the agentts module and is not declared locally — import it from the agentts module so the host can extract its contract`,
          );
        }
        // A locally-declared job/exec/... is the workflow's own helper,
        // not a trap call: skip silently.
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (problems.length) throw new ExtractionError(problems);

  // Same key, different contract = a conflict: the key IS the contract
  // identity, so two sites on one key must agree.
  const byKey = new Map<string, FoundSite>();
  for (const s of found) {
    const prev = byKey.get(s.key);
    if (prev && (prev.inputType !== s.inputType || prev.outputType !== s.outputType)) {
      throw new ExtractionError([
        `conflicting contracts for trap key \`${s.key}\`: ${prev.kind} at ${prev.line}:${prev.column} declares <${prev.inputType ?? "?"}, ${prev.outputType}> but ${s.kind} at ${s.line}:${s.column} declares <${s.inputType ?? "?"}, ${s.outputType}> — one jobspec (or one trap type) has one contract; give the jobs a different spec or unify the types`,
      ]);
    }
    if (!prev) byKey.set(s.key, s);
  }

  // Pre-check (EXTRACT, step 2): every contract type must be
  // JSON-like data, verified by the checker BEFORE the generator
  // runs — the generator silently drops what it cannot represent.
  const checker = program.getTypeChecker();
  const likeProblems: string[] = [];
  {
    const seen = new Set<string>();
    for (const s of found) {
      for (const [side, typeName, file, node] of [
        ["input", s.inputType, s.inputFile, s.inputNode],
        ["output", s.outputType, s.outputFile, s.outputNode],
      ] as const) {
        if (!typeName || !file) continue;
        const key = `${file}\0${typeName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const label = `type \`${typeName}\` (used at ${s.key} (${side})) cannot be validated`;
        const resolved = resolveContractType(checker, program, file, typeName, node);
        if (!resolved) {
          likeProblems.push(`${label} — the type could not be resolved — simplify it to a concrete, named JSON-like type`);
          continue;
        }
        checkJsonLikeType(checker, resolved, "$", label, new Set(), likeProblems);
      }
    }
  }
  if (likeProblems.length) throw new ExtractionError(likeProblems);

  // Generate one schema per distinct named type, per source file.
  // expose:"all" so non-exported workflow interfaces resolve (the
  // author writes plain interfaces — export is not required).
  // functions:"fail" so a function anywhere in a contract type is a
  // loud generator error.
  const schemas = new Map<string, any>();
  const genByFile = new Map<string, any>();
  function schemaFor(typeName: string, file: string): any {
    const cacheKey = `${file}\0${typeName}`;
    if (schemas.has(cacheKey)) return schemas.get(cacheKey);
    let gen = genByFile.get(file);
    if (!gen) {
      try {
        gen = createGenerator({
          path: file,
          type: [],
          expose: "all",
          topRef: false,
          jsDoc: "none",
          functions: "fail",
          // Skip the full type check: workflow files legitimately use
          // host-provided runtime globals (AggregateError, print, trap)
          // that are not in the default lib, and the extractor's job is
          // schema derivation, not whole-program type-checking (the M2
          // checker enforces type-arg concreteness separately). The
          // generator still fails loudly on unrepresentable types, and
          // the empty-schema check below still catches unknown/any.
          skipTypeCheck: true,
        });
        genByFile.set(file, gen);
      } catch (e: any) {
        throw new ExtractionError([
          `could not start the type extractor over ${file}: ${String(e?.message ?? e).split("\n")[0]}`,
        ]);
      }
    }
    let schema: any;
    try {
      schema = gen.createSchema(typeName);
    } catch (e: any) {
    const users = found
        .filter((s) => s.inputType === typeName || s.outputType === typeName)
        .map((s) => `${s.key} (${s.inputType === typeName ? "input" : "output"})`)
        .join(", ");
      throw new ExtractionError([
        `type \`${typeName}\` (used at ${users}) cannot be validated — simplify it: ${String(e?.message ?? e).split("\n")[0]}`,
      ]);
    }
    const emptyAt = findEmptySubschema(schema);
    if (emptyAt) {
      throw new ExtractionError([
        `type \`${typeName}\` cannot be validated — it has an unconstrained part at ${emptyAt} (unknown/any or another non-JSON type) — simplify it to JSON-like data (objects, arrays, strings, numbers, booleans, unions, enums, optionals)`,
      ]);
    }
    schemas.set(cacheKey, schema);
    return schema;
  }

  const sites: Record<string, SiteEntry> = {};
  for (const [key, s] of byKey) {
    const callSites = found
      .filter((f) => f.key === key)
      .map((f) => ({ line: f.line, column: f.column, kind: f.kind }));
    sites[key] = {
      key,
      inputType: s.inputType,
      outputType: s.outputType,
      inputSchema: s.inputType && s.inputFile ? schemaFor(s.inputType, s.inputFile) : null,
      outputSchema: schemaFor(s.outputType, s.outputFile),
      callSites,
    };
  }

  const entry: Extraction = {
    sourceHash,
    source,
    moduleHash: importsAgentts ? moduleHash : null,
    gate: opts?.onFirstRun && opts?.onExtracted
      ? { passed: true as const, checkedAt: new Date().toISOString(), compilerVersion: ts.version, checkerVersion: CHECKER_VERSION }
      : null,
    sites,
  };
  // The M2 checker runs here, before the cache write: a throw aborts
  // before the entry is written, so a checker-failing workflow is
  // never cached as gated. The gate record above is only set when
  // BOTH hooks were passed — an extraction with only the tsc hook
  // (no checker) writes gate null, so it is re-gated + re-checked
  // on next use rather than trusted as checker-verified.
  opts?.onExtracted?.(entry, program);
  fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2));
  return entry;
}
