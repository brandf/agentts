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
  "run",
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

export interface WorkflowEntry {
  /** The default-exported entry function's name (for diagnostics;
   * the driver imports the default, so the name does not matter to
   * it). */
  name: string;
  /** Named input type, or null when the entry takes no parameter. */
  inputType: string | null;
  /** Named output type. */
  outputType: string;
  /** JSON Schema for the input type, or null when inputType is null. */
  inputSchema: any | null;
  /** JSON Schema for the output type. */
  outputSchema: any;
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
  /** The workflow's entry function (the default export): its input
   * and output types and schemas. A workflow is a function — one
   * JSON-capable input in, one JSON-capable output out — and the gate
   * refuses a file with no exported entry function. */
  entry: WorkflowEntry;
  /** SHA-256 over the transitive relative imports' contents (null
   * when the workflow imports no local files). A library change
   * invalidates the cache even when the workflow source is unchanged. */
  depHash: string | null;
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
  // BRA-105: a run call's contract identity is the child workflow
  // path, like a job's spec — two run calls to different children
  // are different contracts; two to the same child with different
  // types are the usual one-key-one-contract conflict.
  if (type === "run" && arg !== null && typeof arg === "object" && !Array.isArray(arg)) {
    if (typeof arg.workflow === "string") return `run:${arg.workflow}`;
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

/** The workflow's entry function: the file's default export. A
 * workflow is a function — `export default function <name>(input:
 * <Input>): <Output>` — and the gate refuses a file with no exported
 * entry function (a global script). The entry takes 0 or 1
 * parameters (one JSON-capable input); its return type is the one
 * JSON-capable output. Returns null when the entry is missing or
 * malformed (problems recorded). */
interface EntryInfo {
  name: string;
  inputType: string | null;
  outputType: string;
  inputNode?: ts.TypeNode;
  outputNode?: ts.TypeNode;
}

function findEntry(sf: ts.SourceFile, problems: string[]): EntryInfo | null {
  let fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | null = null;
  let fnName = "default";
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) {
      const mods = ts.getModifiers(st) ?? [];
      const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      const isExport = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isDefault && isExport) {
        fn = st;
        fnName = st.name?.text ?? "default";
        break;
      }
    } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
      const expr = st.expression;
      if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
        fn = expr;
        fnName = "default";
      } else if (ts.isIdentifier(expr)) {
        const target = expr.text;
        for (const s2 of sf.statements) {
          if (ts.isFunctionDeclaration(s2) && s2.name?.text === target) {
            fn = s2;
            fnName = target;
            break;
          }
          if (ts.isVariableStatement(s2)) {
            for (const d of s2.declarationList.declarations) {
              if (
                ts.isIdentifier(d.name) &&
                d.name.text === target &&
                d.initializer &&
                (ts.isFunctionExpression(d.initializer) || ts.isArrowFunction(d.initializer))
              ) {
                fn = d.initializer;
                fnName = target;
                break;
              }
            }
            if (fn) break;
          }
        }
        if (!fn) {
          problems.push(
            `the default export \`${target}\` is not a function — a workflow must export a default entry function: \`export default function <name>(input: <Input>): <Output>\``,
          );
        }
      } else {
        problems.push(
          `the default export is not a function — a workflow must export a default entry function: \`export default function <name>(input: <Input>): <Output>\``,
        );
      }
      break;
    }
  }
  if (!fn) {
    problems.push(
      `workflow must export a default entry function: \`export default function <name>(input: <Input>): <Output>\` — a workflow file that is a global script (top-level code, no exported entry function) is refused by the gate`,
    );
    return null;
  }
  const params = fn.parameters;
  if (params.length > 1) {
    problems.push(
      `the entry function \`${fnName}\` takes ${params.length} parameters — it must take 0 or 1 (one JSON-capable input)`,
    );
    return null;
  }
  let inputType: string | null = null;
  let inputNode: ts.TypeNode | undefined;
  if (params.length === 1) {
    const p = params[0];
    if (!p.type) {
      problems.push(
        `the entry function \`${fnName}\`'s input parameter must declare a concrete, named type — write \`export default function ${fnName}(input: <Input>): <Output>\``,
      );
      return null;
    }
    inputType = readTypeArg(p.type, "input", `entry function \`${fnName}\``, problems);
    inputNode = p.type;
    if (inputType === null) return null;
  }
  if (!fn.type) {
    problems.push(
      `the entry function \`${fnName}\` must declare a return type — one JSON-capable output — write \`export default function ${fnName}(input: <Input>): <Output>\``,
    );
    return null;
  }
  const outputType = readTypeArg(fn.type, "output", `entry function \`${fnName}\``, problems);
  if (!outputType) return null;
  return { name: fnName, inputType, outputType, inputNode, outputNode: fn.type };
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
  // BRA-106: parameter-name -> concrete-type substitution from one
  // instantiation; a type parameter present in the map is walked as
  // its mapped type instead of rejected.
  subst?: Map<string, ts.Type>,
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
    // BRA-106: a type parameter replaced by one instantiation's
    // substitution is concrete — walk the mapped type instead. A
    // parameter with no mapping (never instantiated, or nested
    // generics) is still the loud unresolved-parameter error; a
    // mapping back to the same parameter (a self-recursive generic
    // call) cannot specialize either.
    const mapped = subst?.get(checker.typeToString(t));
    if (mapped && mapped !== t) {
      checkJsonLikeType(checker, mapped, path, label, ancestors, problems, subst);
      return;
    }
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
      for (const m of members) checkJsonLikeType(checker, m, path, label, ancestors, problems, subst);
      return;
    }
    if (t.isIntersection()) {
      for (const m of t.types) checkJsonLikeType(checker, m, path, label, ancestors, problems, subst);
      return;
    }
    if (checker.isArrayType(t)) {
      const el = (t as ts.TypeReference).typeArguments?.[0];
      if (!el) {
        problems.push(`${label} at ${path}: array without an element type`);
        return;
      }
      checkJsonLikeType(checker, el, `${path}[]`, label, ancestors, problems, subst);
      return;
    }
    if (checker.isTupleType(t)) {
      const els = (t as ts.TypeReference).typeArguments ?? [];
      els.forEach((el, i) => checkJsonLikeType(checker, el, `${path}[${i}]`, label, ancestors, problems, subst));
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
          // Check each remaining member directly: TypeChecker.getUnionType
          // is internal-only in TS 5.9 (not on the public interface), so
          // the union is never reconstituted — same check, member-wise.
          for (const m of rest) checkJsonLikeType(checker, m, `${path}.${prop.getName()}`, label, ancestors, problems, subst);
          continue;
        }
        checkJsonLikeType(checker, pt, `${path}.${prop.getName()}`, label, ancestors, problems, subst);
      }
      const strIdx = t.getStringIndexType();
      if (strIdx) checkJsonLikeType(checker, strIdx, `${path}[string]`, label, ancestors, problems, subst);
      else {
        const numIdx = t.getNumberIndexType();
        if (numIdx) checkJsonLikeType(checker, numIdx, `${path}[number]`, label, ancestors, problems, subst);
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
 * (fixed types cannot arise then anyway). Exported for the host's
 * frozen-copy freeze (BRA-71): the module is part of the frozen
 * closure, at its relative position, so the frozen entry's import
 * resolves exactly as the live one did. */
export function resolveAgenttsModule(source: string, workflowDir: string): string | null {
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

/**
 * The workflow file plus its transitive RELATIVE imports (library
 * workflows like JudgeFixLoop live in imported files — their trap
 * calls must extract too). The agentts module itself is excluded:
 * its internal trap() calls are the module implementation, not
 * workflow trap calls (fixed types resolve from it separately).
 * Non-relative and node_modules imports are excluded.
 */
export function collectWorkflowFiles(entryAbs: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (fileAbs: string): void => {
    const abs = path.resolve(fileAbs);
    if (seen.has(abs) || !fs.existsSync(abs)) return;
    seen.add(abs);
    out.push(abs);
    const source = fs.readFileSync(abs, "utf8");
    const probe = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, false);
    for (const st of probe.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      if (!spec.startsWith(".")) continue;
      if (spec.includes("agentts")) continue;
      const resolved = ts.resolveModuleName(spec, abs, GATE_COMPILER_OPTIONS, ts.sys);
      const target = resolved.resolvedModule?.resolvedFileName;
      if (!target || target.includes("node_modules")) continue;
      walk(target);
    }
  };
  walk(entryAbs);
  return out;
}

/**
 * The frozen closure (BRA-105): the workflow's transitive relative
 * imports (collectWorkflowFiles) PLUS the transitive literal targets
 * of `run({ workflow: "..." })` calls — a child workflow is code
 * the parent may execute, so it is pinned with the parent at submit
 * (BRA-71) exactly like an imported library file: an edit of the
 * child after the parent is submitted cannot change what the child
 * run executes. The walk recurses into every collected file, so a
 * child that itself imports or run-calls further files pulls them
 * in too. Only `run` calls imported from the agentts module count —
 * a local helper named `run` is not a trap call (same rule as the
 * extractor's importedWrappers), including under an import alias
 * (`import { run as runChild }`). A missing or non-literal target is
 * skipped here; the extractor fails loudly on it at gate time, and
 * the dispatch fails loudly if the frozen copy lacks the child.
 *
 * This is the FREEZE file set only. Extraction and checking walk
 * the program (imports only): a run target's trap sites belong to
 * the child's own extraction/checker pass when the child run
 * starts, not to the parent's — merging them would invent
 * one-key-one-contract conflicts between two runs.
 */
export function collectClosureFiles(entryAbs: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (fileAbs: string): void => {
    const abs = path.resolve(fileAbs);
    if (seen.has(abs) || !fs.existsSync(abs)) return;
    seen.add(abs);
    out.push(abs);
    const source = fs.readFileSync(abs, "utf8");
    const probe = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, false);
    let importsRun = false;
    // Local name -> imported (canonical) wrapper name, so an alias
    // (`import { run as runChild }`) still counts as a run call.
    const wrapperAliases = new Map<string, string>();
    for (const st of probe.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      if (spec.includes("agentts")) {
        const clause = st.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            wrapperAliases.set(el.name.text, el.propertyName?.text ?? el.name.text);
            if ((el.propertyName?.text ?? el.name.text) === "run") importsRun = true;
          }
        }
      }
      if (!spec.startsWith(".")) continue;
      if (spec.includes("agentts")) continue;
      const resolved = ts.resolveModuleName(spec, abs, GATE_COMPILER_OPTIONS, ts.sys);
      const target = resolved.resolvedModule?.resolvedFileName;
      if (!target || target.includes("node_modules")) continue;
      walk(target);
    }
    if (!importsRun) return;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        // Resolve an import alias: `run as runChild` is still a run call.
        (wrapperAliases.get(node.expression.text) ?? node.expression.text) === "run" &&
        node.arguments.length > 0
      ) {
        const workflow = literalProp(node.arguments[0], "workflow");
        if (workflow !== null && (workflow.startsWith(".") || path.isAbsolute(workflow))) {
          walk(path.resolve(path.dirname(abs), workflow));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(probe);
  };
  walk(entryAbs);
  return out;
}

/** Combined hash of the workflow's relative imports (contents, sorted
 * by path) — null when there are none. */
export function depHashFor(files: string[], entryAbs: string): string | null {
  const deps = files.filter((f) => path.resolve(f) !== path.resolve(entryAbs)).sort();
  if (!deps.length) return null;
  const h = crypto.createHash("sha256");
  for (const f of deps) {
    h.update(path.relative(path.dirname(entryAbs), f));
    h.update("\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
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
  // Library files: a change there must invalidate the cache even
  // when the workflow source is unchanged.
  const workflowFiles = collectWorkflowFiles(abs);
  const depHash = depHashFor(workflowFiles, abs);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${sourceHash}.json`);
  // The agentts module this workflow imports — resolved from every
  // file in the closure, not just the entry: a workflow that only
  // calls a library (BRA-106: the trap calls live in the lib) never
  // imports agentts itself, so entry-only resolution falls back to
  // the module beside this file, which is NOT in the extraction
  // program when the entry is a frozen copy — and the pre-check then
  // fails to resolve the fixed types (DecideSpec, ...). First hit
  // wins; every file in one closure resolves to the same module.
  let importedModule = resolveAgenttsModule(source, path.dirname(abs));
  if (!importedModule) {
    for (const f of workflowFiles) {
      if (path.resolve(f) === abs) continue;
      importedModule = resolveAgenttsModule(fs.readFileSync(f, "utf8"), path.dirname(f));
      if (importedModule) break;
    }
  }
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
        entry.depHash === depHash &&
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

  // Walk the PROGRAM's SourceFiles, not fresh parses: the checker can
  // only resolve types from nodes that belong to the program — nodes
  // from a standalone createSourceFile resolve to `any`, which the
  // pre-check would (correctly but uselessly) reject. The walk covers
  // the workflow file AND its transitive relative imports (library
  // workflows): a trap call in an imported library file is a trap
  // call of this workflow, with its contract types declared there.
  const problems: string[] = [];
  let importsAgentts = false;

  interface FileCtx {
    sf: ts.SourceFile;
    fileAbs: string;
    importedWrappers: Set<string>;
    /** Local name -> imported (canonical) wrapper name, per file.
     * An import alias (`import { run as runChild }`) binds the
     * wrapper under its LOCAL name; the call-site walk resolves
     * through this map so an aliased call extracts exactly like
     * the canonical name. propertyName is the imported name, name
     * is the local binding. */
    wrapperAliases: Map<string, string>;
    localNames: Set<string>;
  }
  function fileCtx(fileAbs: string): FileCtx | null {
    const sf = program.getSourceFile(fileAbs);
    if (!sf) return null;
    // Which names are the agentts module's wrappers in this file: the
    // names imported from a module specifier containing "agentts".
    const importedWrappers = new Set<string>();
    const wrapperAliases = new Map<string, string>();
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.includes("agentts")) {
        importsAgentts = true;
        const clause = st.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            importedWrappers.add(el.name.text);
            wrapperAliases.set(el.name.text, el.propertyName?.text ?? el.name.text);
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
    return { sf, fileAbs, importedWrappers, wrapperAliases, localNames };
  }

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
    /** BRA-106: when this site's trap call sits inside a generic
     * function, the enclosing generic function (its declaration +
     * file + type-parameter names), recorded by pushSite so the
     * specialization pass can re-resolve the site per instantiation.
     * Absent for concrete sites. */
    genericFn?: { decl: ts.FunctionLikeDeclaration; file: string; paramNames: string[] };
    /** BRA-106: for a specialized site, the parameter-name ->
     * concrete-type substitution from one instantiation, used by the
     * pre-check to walk the resolved (unsubstituted) type with its
     * type parameters replaced. Absent for concrete sites. */
    subst?: Map<string, ts.Type>;
    /** BRA-106: for a specialized site, the synthetic alias the
     * schema generator must generate per side (name + alias file),
     * because the generator resolves root types by declaration name.
     * The site's inputType/outputType keep the specialized TEXT (the
     * human-meaningful contract name); the alias is only the
     * generator's entry point. One side carries a gen entry only when
     * its type mentions a parameter; the other side keeps its
     * original file and no alias. */
    inputGen?: { file: string; name: string };
    outputGen?: { file: string; name: string };
  }
  const found: FoundSite[] = [];

  function pushSite(
    ctx: FileCtx,
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
    const { line, character } = ctx.sf.getLineAndCharacterOfPosition(node.getStart(ctx.sf));
    // BRA-106: the enclosing generic function, if any — the
    // specialization pass re-resolves this site per instantiation of
    // that function. Walk up past non-generic thunks (e.g. the `all()`
    // branch callbacks) to the nearest function-like declaration that
    // declares type parameters.
    let genericFn: FoundSite["genericFn"];
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
      if (
        (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur) || ts.isMethodDeclaration(cur)) &&
        cur.typeParameters &&
        cur.typeParameters.length > 0
      ) {
        genericFn = { decl: cur, file: ctx.fileAbs, paramNames: cur.typeParameters.map((p) => p.name.text) };
        break;
      }
      cur = cur.parent;
    }
    found.push({ key, kind, line: line + 1, column: character + 1, inputType, outputType, inputFile, outputFile, inputNode, outputNode, genericFn });
  }

  function visit(ctx: FileCtx, node: ts.Node): void {
    const { sf, fileAbs, importedWrappers, localNames, wrapperAliases } = ctx;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      // BRA-105: resolve an import alias to the wrapper's canonical
      // name before matching — `run as runChild` is still a run
      // call. `trap` is a global, never an import alias, so it keeps
      // the local name.
      const resolved = wrapperAliases.get(name ?? "") ?? name ?? "";
      if (name !== null && (name === "trap" || WRAPPER_NAMES.has(resolved))) {
        const where = `${fileAbs}:${loc(sf, node)}`;
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
              // BRA-105: a direct trap("run", ...) keys on the child
              // workflow literal, like a job keys on its spec.
              if (trapType === "run") {
                const workflow = literalProp(argExpr, "workflow");
                if (workflow !== null) key = `run:${workflow}`;
              }
              pushSite(ctx, node, key, "trap", inputType, outputType, fileAbs, fileAbs, inputNode, outputNode);
            }
          }
        } else if (importedWrappers.has(name)) {
          // Module wrapper call (name is the local binding; resolved
          // is the canonical wrapper name — see above).
          if (resolved === "job") {
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
              pushSite(ctx, node, `job:${spec}`, "job", inputType, outputType, fileAbs, fileAbs, args[0], args[1]);
            }
          } else if (resolved === "decide") {
            if (args.length !== 1) {
              problems.push(
                `${where}: decide(...) has ${args.length} type argument(s) — it must carry exactly one, <Output>, a concrete, named type`,
              );
            }
            const outputType = readTypeArg(args[0], "output", where, problems);
            if (outputType) {
              // Input DecideSpec lives in the module; the output type
              // is declared in the workflow.
              pushSite(ctx, node, "decide", "decide", "DecideSpec", outputType, modulePath, fileAbs, undefined, args[0]);
            }
          } else if (resolved === "run") {
            // BRA-105: like job, two type arguments and a literal
            // identity — here the child workflow path, not a spec.
            // The key is run:<workflow-literal>, so the dispatch
            // key (siteKeyFor, from the runtime arg) matches the
            // static key exactly. The literal must name a file that
            // exists (resolved against the call-site file's
            // directory): a missing child fails loudly at first run,
            // not mid-run at dispatch.
            if (args.length !== 2) {
              problems.push(
                `${where}: run(...) has ${args.length} type argument(s) — it must carry exactly two, <Input, Output>, both concrete, named types`,
              );
            }
            const inputType = readTypeArg(args[0], "input", where, problems);
            const outputType = readTypeArg(args[1], "output", where, problems);
            const workflow = literalProp(node.arguments[0], "workflow");
            if (workflow === null) {
              problems.push(
                `${where}: run workflow must be a string literal so the host can map the trap to its contract (run:<workflow>) and pin the child file at submit — write run<...>({ workflow: "./child.ts", input: ... })`,
              );
            } else if (!fs.existsSync(path.resolve(path.dirname(fileAbs), workflow))) {
              problems.push(
                `${where}: run workflow ${JSON.stringify(workflow)} does not exist (resolved against ${path.dirname(fileAbs)}) — the child file must exist when the parent run is submitted`,
              );
            }
            if (inputType && outputType && workflow !== null) {
              pushSite(ctx, node, `run:${workflow}`, "run", inputType, outputType, fileAbs, fileAbs, args[0], args[1]);
            }
          } else {
            // Fixed-result wrappers: no type args, types from the module.
            if (args.length !== 0) {
              problems.push(
                `${where}: ${name}(...) carries ${args.length} type argument(s) — it carries none; its result type is fixed by the trap type (${FIXED_WRAPPER_TYPES[resolved][1]} from the agentts module)`,
              );
            } else {
              const [inputType, outputType] = FIXED_WRAPPER_TYPES[resolved];
              pushSite(ctx, node, resolved, resolved, inputType, outputType, modulePath, modulePath);
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
      // BRA-47: a decisionCascade(...) call synthesizes the four tier
      // sites. The extractor walks the workflow file and its relative
      // imports but EXCLUDES the agentts module (its internal trap()
      // calls are the implementation, not workflow trap calls) — so
      // the trap calls inside decisionCascade never extract on their
      // own, and without these sites dispatch would fail loudly ("no
      // extracted schema"). One cascade call synthesizes all four
      // tier sites, with the contracts from the module's own types
      // (resolved from modulePath, the same way the fixed-wrapper
      // types resolve). The job tier's spec is the literal
      // "decision" jobspec (see decisionCascade in agentts.ts). Two
      // cascade calls in one workflow synthesize identical sites —
      // the byKey dedupe keeps the first; a direct decide<Other> (or
      // a direct job<"decision"> with different types) for the same
      // key is the usual one-key-one-contract extraction conflict.
      // A decisionCascade that is NOT imported from the agentts
      // module (a local helper sharing the name) synthesizes nothing.
      if (name !== null && resolved === "decisionCascade" && importedWrappers.has(name)) {
        pushSite(ctx, node, "exec", "exec", "ExecSpec", "ExecResult", modulePath, modulePath);
        pushSite(ctx, node, "decide", "decide", "DecideSpec", "DecideTierResult", modulePath, modulePath);
        pushSite(ctx, node, "job:decision", "job", "DecisionJobInput", "DecisionJobResult", modulePath, modulePath);
        pushSite(ctx, node, "gate", "gate", "GateSpec", "GateResult", modulePath, modulePath);
      }
    }
    ts.forEachChild(node, (child) => visit(ctx, child));
  }
  // BRA-106 specialization: trap sites inside generic functions are
  // re-resolved per instantiation of that function, so a generic
  // library workflow can call traps directly. The checker fully
  // resolves generics at instantiation sites — the extractor just
  // never asked there: it resolved each trap site in place, where the
  // type parameters are still unresolved. This pass asks at the call
  // sites instead: for each generic function with trap calls, enumerate
  // its call sites in the workflow closure, read the concrete type
  // arguments there, and re-resolve the inner trap sites under that
  // substitution. Boundaries (loud, never silent):
  //  - explicit type arguments are required at the call site: the
  //    checker's instantiation mapping is not retrievable for inferred
  //    calls through the public API (verified by probe, TS 5.9.3), so
  //    an inferred call is a loud problem telling the author to pass
  //    explicit type arguments;
  //  - nested generics (a generic function called from generic
  //    context) do not specialize transitively: the specialized text
  //    still mentions a parameter and the pre-check rejects it loudly.
  function specializeGenericSites(checker: ts.TypeChecker): void {
    function fnName(decl: ts.FunctionLikeDeclaration): string {
      if (ts.isFunctionDeclaration(decl) && decl.name) return decl.name.text;
      const parent = decl.parent;
      if (
        (ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) &&
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name)
      ) {
        return parent.name.text;
      }
      return "anonymous";
    }
    function fnSymbol(decl: ts.FunctionLikeDeclaration): ts.Symbol | null {
      if (ts.isFunctionDeclaration(decl) && decl.name) {
        return checker.getSymbolAtLocation(decl.name) ?? null;
      }
      const parent = decl.parent;
      if (
        (ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) &&
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name)
      ) {
        return checker.getSymbolAtLocation(parent.name) ?? null;
      }
      return null;
    }
    // Call sites of one generic function in the workflow closure:
    // call expressions whose callee resolves (through import aliases)
    // to the function's symbol. Property-access calls (ns.fn) are not
    // enumerated — library workflows are called by bare name.
    function findCallSites(decl: ts.FunctionLikeDeclaration): { call: ts.CallExpression; file: string }[] {
      const sym = fnSymbol(decl);
      if (!sym) return [];
      const out: { call: ts.CallExpression; file: string }[] = [];
      for (const fileAbs of workflowFiles) {
        const sf = program.getSourceFile(fileAbs);
        if (!sf) continue;
        const visitCall = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const calleeSym = checker.getSymbolAtLocation(node.expression);
            if (calleeSym) {
              const target =
                calleeSym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(calleeSym) : calleeSym;
              if (target === sym) out.push({ call: node, file: fileAbs });
            }
          }
          ts.forEachChild(node, visitCall);
        };
        visitCall(sf);
      }
      return out;
    }
    // The file declaring a top-level named type: the library file
    // first (the base type lives there), then the caller file (the
    // concrete arguments usually live there), then the rest of the
    // workflow closure, then the agentts module. Lib types (Array,
    // Date, ...) are ambient and need no import — null when not found.
    // Also reports whether the declaration is exported: the alias
    // imports the name, so a non-exported type would silently resolve
    // to `any` under skipTypeCheck and surface only as a cryptic
    // unconstrained-part schema error. Fail loudly here instead.
    function findDeclaringFile(
      name: string,
      libFile: string,
      callerFile: string,
    ): { file: string; exported: boolean } | null {
      const ordered = [libFile, callerFile, ...workflowFiles.filter((f) => f !== libFile && f !== callerFile), modulePath];
      for (const fileAbs of ordered) {
        const sf = program.getSourceFile(fileAbs);
        if (!sf) continue;
        for (const st of sf.statements) {
          if (
            (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) &&
            st.name?.text === name
          ) {
            const modified =
              ts.canHaveModifiers(st) &&
              ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
            const listed = sf.statements.some(
              (s) =>
                ts.isExportDeclaration(s) &&
                !s.moduleSpecifier &&
                s.exportClause &&
                ts.isNamedExports(s.exportClause) &&
                s.exportClause.elements.some((e) => e.propertyName?.text === name || e.name.text === name),
            );
            return { file: fileAbs, exported: Boolean(modified || listed) };
          }
        }
      }
      return null;
    }
    // Replace whole-word occurrences of each parameter name in a type
    // text with its concrete text from one instantiation.
    function substituteText(text: string, byName: Map<string, string>): string {
      let out = text;
      for (const [param, concrete] of byName) {
        out = out.replace(new RegExp(`\\b${param}\\b`, "g"), concrete);
      }
      return out;
    }
    // Synthetic alias for one specialized type, in the extraction
    // cache dir (derived data, like the JSON entries): the schema
    // generator resolves root types by declaration name, so a
    // parameterized name (JudgeInput<FixItem, FixRubric>) cannot be
    // generated directly — the alias names the instantiation.
    const aliasCache = new Map<string, { file: string; name: string }>();
    function aliasFor(specializedText: string, callerFile: string, libFile: string): { file: string; name: string } {
      const key = `${specializedText}\0${callerFile}`;
      const hit = aliasCache.get(key);
      if (hit) return hit;
      const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
      const name = `__bra106_${hash}`;
      const file = path.join(cacheDir, `${name}.ts`);
      const imports = new Map<string, Set<string>>();
      for (const m of specializedText.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)) {
        const ident = m[0];
        if (ident === name) continue;
        const declaring = findDeclaringFile(ident, libFile, callerFile);
        if (!declaring || declaring.file === file) continue;
        if (!declaring.exported) {
          throw new Error(
            `type '${ident}' (used as a generic argument for specialized trap contract '${specializedText}' in ${callerFile}) ` +
              `is declared in ${declaring.file} but not exported — the specialization alias must import it by name; export the type`,
          );
        }
        let rel = path.relative(path.dirname(file), declaring.file).replace(/\.tsx?$/, "").replace(/\.d$/, "");
        if (!rel.startsWith(".")) rel = `./${rel}`;
        if (!imports.has(rel)) imports.set(rel, new Set());
        imports.get(rel)!.add(ident);
      }
      const lines: string[] = [
        `// Derived by the BRA-106 specialization pass: a concrete alias for a`,
        `// generic trap contract, so the schema generator (which resolves root`,
        `// types by declaration name) can generate the instantiated schema.`,
        `// Regenerated on every extraction; keyed by content hash.`,
      ];
      for (const [rel, names] of [...imports.entries()].sort()) {
        lines.push(`import type { ${[...names].sort().join(", ")} } from "${rel}";`);
      }
      lines.push(`export type ${name} = ${specializedText};`);
      fs.writeFileSync(file, lines.join("\n") + "\n");
      const entry = { file, name };
      aliasCache.set(key, entry);
      return entry;
    }
    // Group sites by their enclosing generic function.
    const byFn = new Map<ts.FunctionLikeDeclaration, FoundSite[]>();
    for (const site of found) {
      if (!site.genericFn) continue;
      const list = byFn.get(site.genericFn.decl) ?? [];
      list.push(site);
      byFn.set(site.genericFn.decl, list);
    }
    // Usable instantiations per function: one entry per call site
    // with explicit type arguments of the right arity.
    interface Instantiation {
      byName: Map<string, string>;
      subst: Map<string, ts.Type>;
      callerFile: string;
    }
    const fnCalls = new Map<ts.FunctionLikeDeclaration, Instantiation[]>();
    for (const [decl, sites] of byFn) {
      const paramNames = sites[0].genericFn!.paramNames;
      const usable: Instantiation[] = [];
      for (const { call, file: callerFile } of findCallSites(decl)) {
        const typeArgs = call.typeArguments ?? [];
        if (typeArgs.length !== paramNames.length) {
          const sf = program.getSourceFile(callerFile);
          const at = sf
            ? (() => {
                const { line, character } = sf.getLineAndCharacterOfPosition(call.getStart(sf));
                return `${callerFile}:${line + 1}:${character + 1}`;
              })()
            : callerFile;
          problems.push(
            `${at}: generic function '${fnName(decl)}' called with ${typeArgs.length} explicit type argument(s) but declares ${paramNames.length} type parameter(s) — the extractor cannot specialize its trap calls; pass explicit type arguments matching the parameters`,
          );
          continue;
        }
        const byName = new Map<string, string>();
        const subst = new Map<string, ts.Type>();
        for (let i = 0; i < paramNames.length; i++) {
          byName.set(paramNames[i], typeArgs[i].getText());
          subst.set(paramNames[i], checker.getTypeFromTypeNode(typeArgs[i]));
        }
        usable.push({ byName, subst, callerFile });
      }
      fnCalls.set(decl, usable);
    }
    // Rewrite the site list: a site whose types mention no parameter
    // passes through untouched; a site that does is replaced by one
    // specialized copy per usable instantiation — or kept as-is when
    // the function is never called, so the pre-check rejects it
    // loudly with the unresolved-parameter error.
    const out: FoundSite[] = [];
    for (const site of found) {
      const g = site.genericFn;
      if (!g) {
        out.push(site);
        continue;
      }
      const mentions = (t: string | null): boolean =>
        t !== null && g.paramNames.some((p) => new RegExp(`\\b${p}\\b`).test(t));
      const calls = fnCalls.get(g.decl) ?? [];
      if ((!mentions(site.inputType) && !mentions(site.outputType)) || calls.length === 0) {
        out.push(site);
        continue;
      }
      for (const c of calls) {
        const inText = site.inputType ? substituteText(site.inputType, c.byName) : null;
        const outText = substituteText(site.outputType, c.byName);
        let inputGen: FoundSite["inputGen"];
        let outputGen: FoundSite["outputGen"];
        if (inText !== null && inText !== site.inputType) {
          inputGen = aliasFor(inText, c.callerFile, g.file);
        }
        if (outText !== site.outputType) {
          outputGen = aliasFor(outText, c.callerFile, g.file);
        }
        out.push({
          ...site,
          inputType: inText,
          outputType: outText,
          inputFile: inputGen ? inputGen.file : site.inputFile,
          outputFile: outputGen ? outputGen.file : site.outputFile,
          inputGen,
          outputGen,
          subst: c.subst,
        });
      }
    }
    found.splice(0, found.length, ...out);
  }

  for (const fileAbs of workflowFiles) {
    const ctx = fileCtx(fileAbs);
    if (!ctx) {
      throw new ExtractionError([`could not load ${fileAbs} into the type-checker program`]);
    }
    visit(ctx, ctx.sf);
  }

  // The entry function: the workflow file's default export. A file
  // with no exported entry function is refused (a global script).
  const workflowSf = program.getSourceFile(abs);
  let entryInfo: EntryInfo | null = null;
  if (!workflowSf) {
    problems.push(`could not load ${abs} into the type-checker program`);
  } else {
    entryInfo = findEntry(workflowSf, problems);
  }

  if (problems.length) throw new ExtractionError(problems);
  if (!entryInfo) throw new ExtractionError([`workflow must export a default entry function`]);

  // BRA-106 specialization: re-resolve trap sites inside generic
  // functions per instantiation, before the byKey dedupe (two
  // instantiations with different contracts for one key conflict
  // here, exactly as two concrete sites would). The checker is created
  // here — it is cached by the program, so the pre-check below reuses
  // the same instance.
  const checker = program.getTypeChecker();
  specializeGenericSites(checker);
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
        // BRA-106: a specialized site carries its instantiation's
        // substitution, so the pre-check walks the resolved type with
        // its type parameters replaced.
        checkJsonLikeType(checker, resolved, "$", label, new Set(), likeProblems, s.subst);
      }
    }
    // The entry function's input/output types get the same JSON-like
    // pre-check (the workflow boundary is a trap boundary too).
    for (const [side, typeName, node] of [
      ["input", entryInfo.inputType, entryInfo.inputNode],
      ["output", entryInfo.outputType, entryInfo.outputNode],
    ] as const) {
      if (!typeName) continue;
      const key = `${abs}\0${typeName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = `type \`${typeName}\` (the entry function's ${side}) cannot be validated`;
      const resolved = resolveContractType(checker, program, abs, typeName, node);
      if (!resolved) {
        likeProblems.push(`${label} — the type could not be resolved — simplify it to a concrete, named JSON-like type`);
        continue;
      }
      checkJsonLikeType(checker, resolved, "$", label, new Set(), likeProblems);
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
  // genName is the type the generator must generate: the type name
  // itself, except for BRA-106 specialized sites, where it is the
  // synthetic alias name in the alias file (the generator resolves
  // root types by declaration name, so a parameterized name cannot be
  // generated directly).
  function schemaFor(typeName: string, file: string, genName: string = typeName): any {
    const cacheKey = `${file}\0${genName}`;
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
      schema = gen.createSchema(genName);
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
      inputSchema: s.inputType && s.inputFile ? schemaFor(s.inputType, s.inputFile, s.inputGen?.name) : null,
      outputSchema: schemaFor(s.outputType, s.outputFile, s.outputGen?.name),
      callSites,
    };
  }

  const workflowEntry: WorkflowEntry = {
    name: entryInfo.name,
    inputType: entryInfo.inputType,
    outputType: entryInfo.outputType,
    inputSchema: entryInfo.inputType ? schemaFor(entryInfo.inputType, abs) : null,
    outputSchema: schemaFor(entryInfo.outputType, abs),
  };

  const entry: Extraction = {
    sourceHash,
    source,
    moduleHash: importsAgentts ? moduleHash : null,
    depHash,
    gate: opts?.onFirstRun && opts?.onExtracted
      ? { passed: true as const, checkedAt: new Date().toISOString(), compilerVersion: ts.version, checkerVersion: CHECKER_VERSION }
      : null,
    sites,
    entry: workflowEntry,
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
