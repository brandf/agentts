// checker — the M2 checker (BRA-29).
//
// The first-run gate (gate.ts) runs the TypeScript compiler: it
// catches every general type error (a mistyped literal, a wrong
// arity, a bad assignment). What it CANNOT catch is everything that
// is specific to AgentTS — the rules below. The checker is the
// gate's AgentTS-specific half: it runs on the same ts.Program the
// gate and the extractor share, after extraction, before the cache
// entry is written, and a failure refuses the run exactly like a
// type error (CheckerError carries the same structured-diagnostic
// shape as GateError, plus the rule that fired and a fix hint).
//
// Rules (each is something tsc cannot express):
//   M2-CLASS  — a trap contract type declared as a class (or
//               containing one). The extractor's schema generator
//               silently drops the class-ness (a data-only class
//               generates the same schema as the equivalent plain
//               interface), but the runtime does not: toJsonValue
//               rejects class instances at the boundary, and a
//               resumed result is a plain JSON object — methods and
//               the prototype do not survive. Verified live: a
//               `class DataOnly { score; label }` generates a clean
//               schema, and a `class WithMethod` loses `greet` from
//               its schema without error (functions:"fail" does not
//               fail on methods).
//   M2-EMPTY  — a trap OUTPUT contract type that is empty (or
//               contains an empty member): `interface Empty {}`
//               extracts to `{type:"object", additionalProperties:false}`
//               — a schema that admits ONLY `{}` — and nested, an
//               empty member constrains its slot to `{}` too. A
//               result that can carry no data is a degenerate
//               contract (BRA-45). The extractor's empty-subschema
//               check cannot see it: the schema is not `{}`.
//               Output-only, deliberately: an empty INPUT type is
//               the honest encoding of "this trap takes no input"
//               (the clock trap's `interface ClockInput {}` with
//               arg `{}`) — and it is self-limiting, since tsc's
//               excess-property check rejects any non-empty literal
//               passed against it.
//   M2-WIRING — where one stage's output flows into the next stage's
//               input, the declared output must match the declared
//               input — checked against the EXTRACTED SCHEMAS, the
//               contract the runtime actually enforces, not the
//               declared types. tsc already checks assignability of
//               the declared types, so the checker does NOT redo
//               that; what tsc cannot see is a value flowing through
//               an `any`/`unknown` intermediary, an `as` cast, or a
//               JSON round-trip — all of which erase the type while
//               the value keeps its origin. The checker traces the
//               origin (a variable bound to a trap result, an alias,
//               a property/element access, a cast, a
//               JSON.parse(JSON.stringify(x)) round-trip, a for-of
//               element, or a library-callback parameter whose type
//               resolves to exactly one trap site's output) and
//               compares the producer's output schema against the
//               consumer's input schema at the exact slot. A flow
//               whose origin cannot be established is skipped, never
//               guessed: the checker reports only edges it is sure
//               about.
//   M2-LAYER  — the layering boundary: core + host (layers 1–2)
//               never import Muse-specific things; the adapter is
//               the only place they appear. Two forms of one rule:
//               M2-LAYER-MUSE (no file outside layer 3 imports the
//               muse adapter or plugins/muse) and M2-LAYER-PLUGIN
//               (a workflow never imports anything under plugins/ —
//               adapters are loaded by the host, never imported by
//               a workflow). The CI import lint is the same rule in
//               another form: `agentts check --layering` runs it
//               over a tree.
//
//   M2-BUN    — a VALUE reference to the `Bun` global (BRA-58).
//               The gate program includes bun-types for
//               type-checking (gate.ts), so `Bun` in a TYPE position
//               (`Bun.BunFile`) passes the gate and is runtime-safe
//               (types erase). But the engine (dquickts) provides no
//               `Bun` global, so a value use (`Bun.sleepSync(...)`,
//               `const x = Bun`, `typeof Bun` as a value) would fail
//               at runtime — tsc cannot see that, because it only
//               knows the types. The checker refuses value uses with
//               a precise diagnostic. Type uses are allowed; a local
//               binding named `Bun` (a workflow's own object) is
//               not the global and is not flagged.
//
// What the checker deliberately does NOT do (hands-dirty decisions,
// recorded on BRA-29):
//   - It AUGMENTS tsc, it does not replace it. tsc stays the
//     general type-check (it catches the whole type-negatives
//     class); re-implementing assignability in the checker would
//     only duplicate tsc's diagnostics. The wiring rule is
//     schema-level for exactly that reason.
//   - It does not re-check what extraction already owns: concrete
//     named type arguments, unknown/any, unresolved type
//     parameters, function/Map/Set/Promise members. Those fail
//     loudly as ExtractionError before the checker runs.
//   - It does not trace origins through `all()`/Outcome
//     unwrapping or through arbitrary function calls: a flow the
//     tracer cannot establish is skipped (a possible false
//     negative), never guessed (a false positive would refuse a
//     good workflow).
//
// Cache: a cache entry is only trusted when it was written by a run
// that passed the checker — see CHECKER_VERSION in gate.ts and the
// gate.checkerVersion recorded on the extraction entry.

import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  GATE_COMPILER_OPTIONS,
  CHECKER_VERSION,
  assertCompilerVersion,
  runGate,
  type GateDiagnostic,
} from "./gate";
import { extractWorkflow, type Extraction } from "./extract";

/** One checker finding: the GateDiagnostic shape, plus the rule
 * that fired and a fix hint, so the authoring agent can act on it
 * without guessing. `code` is the rule id (M2-*); the TS error
 * code, when the finding restates one, is not applicable. */
export interface CheckerDiagnostic {
  file: string;
  line: number;
  column: number;
  /** Rule id, e.g. "M2-WIRING". */
  code: string;
  rule: string;
  message: string;
  expected: string | null;
  actual: string | null;
  /** What to do about it, in one sentence. */
  fix: string | null;
  /** The other end of a wiring edge (producer site), when the rule
   * relates two call sites. */
  related?: { file: string; line: number; column: number; site: string };
}

export class CheckerError extends Error {
  readonly diagnostics: CheckerDiagnostic[];
  constructor(workflowPath: string, diagnostics: CheckerDiagnostic[]) {
    super(
      `M2 checker: ${workflowPath} failed ${diagnostics.length} check(s):\n` +
        diagnostics
          .map(
            (d) =>
              `  ${d.file}:${d.line}:${d.column}: error ${d.code}: ${d.message}` +
              (d.fix ? `\n    fix: ${d.fix}` : ""),
          )
          .join("\n"),
    );
    this.name = "CheckerError";
    this.diagnostics = diagnostics;
  }
}

/** The extraction shape the checker reads: only the site table.
 * Structural, so the host's Extraction and the mock plugin's
 * Extraction both satisfy it without importing each other's types. */
export interface CheckerExtraction {
  sites: Record<
    string,
    {
      key: string;
      inputType: string | null;
      outputType: string;
      inputSchema: any | null;
      outputSchema: any;
    }
  >;
}

const WRAPPER_NAMES = new Set(["job", "decide", "exec", "gate", "sleep", "cron"]);
const FIXED_WRAPPER_TYPES: Record<string, [string, string]> = {
  exec: ["ExecSpec", "ExecResult"],
  gate: ["GateSpec", "GateResult"],
  sleep: ["SleepSpec", "SleepResult"],
  cron: ["CronSpec", "CronResult"],
};

function loc(sf: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, column: character + 1 };
}

function diag(
  file: string,
  line: number,
  column: number,
  code: string,
  message: string,
  fix: string | null,
  expected: string | null = null,
  actual: string | null = null,
  related?: CheckerDiagnostic["related"],
): CheckerDiagnostic {
  return { file, line, column, code, rule: code, message, expected, actual, fix, ...(related ? { related } : {}) };
}

/** The workflow file plus its transitive RELATIVE imports (same
 * rule as the extractor's collectWorkflowFiles, re-implemented
 * here so the checker does not depend on the extractor's walk:
 * the checker walks these files for trap sites and origins, the
 * extractor walks them for contracts — two walks over the same
 * file set, kept in sync by this comment, not by sharing code the
 * swap test freezes). The agentts module itself is excluded. */
export function collectCheckerFiles(entryAbs: string): string[] {
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

/** The agentts module a workflow imports (its own import specifier
 * decides), falling back to the module beside this file. Fixed
 * contract types (DecideSpec, ExecResult, ...) resolve from it. */
function resolveAgenttsModule(workflowPath: string): string | null {
  const source = fs.readFileSync(workflowPath, "utf8");
  const probe = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, false);
  for (const st of probe.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.includes("agentts")) {
      const resolved = ts.resolveModuleName(
        st.moduleSpecifier.text,
        path.join(path.dirname(path.resolve(workflowPath)), "probe.ts"),
        GATE_COMPILER_OPTIONS,
        ts.sys,
      );
      if (resolved.resolvedModule) return resolved.resolvedModule.resolvedFileName;
    }
  }
  const beside = path.join(import.meta.dir, "agentts.ts");
  return fs.existsSync(beside) ? beside : null;
}

// ------------------------------------------------------------ trap sites

interface TrapSiteRecord {
  key: string;
  kind: string;
  call: ts.CallExpression;
  file: string;
  line: number;
  column: number;
  /** The expression whose value is the input contract (job: the
   * `input` property value; everything else: the arg itself). */
  inputValue: ts.Expression | undefined;
  inputTypeNode: ts.TypeNode | undefined;
  outputTypeNode: ts.TypeNode | undefined;
  inputTypeName: string | null;
  outputTypeName: string | null;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

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

/** The `input` property value of a job arg object literal. */
function jobInputValue(arg: ts.Expression | undefined): ts.Expression | undefined {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return arg;
  for (const p of arg.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "input") return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === "input") return p.name;
  }
  return arg;
}

function typeArgName(arg: ts.TypeNode | undefined): string | null {
  if (!arg || !ts.isTypeReferenceNode(arg)) return null;
  return arg.getText();
}

/** Declared result type of a direct trap() call with no type args
 * (`as` cast or receiving variable annotation). */
function declaredResultType(call: ts.CallExpression): { type: string | null; node: ts.TypeNode | null } {
  const parent = call.parent;
  if (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
    const t = parent.type;
    return ts.isTypeReferenceNode(t) ? { type: t.getText(), node: t } : { type: null, node: null };
  }
  if (ts.isVariableDeclaration(parent) && parent.type && ts.isTypeReferenceNode(parent.type)) {
    return { type: parent.type.getText(), node: parent.type };
  }
  return { type: null, node: null };
}

/** Walk the workflow files and record every trap/wrapper call
 * site the checker reasons about. Mirrors the extractor's walk in
 * shape (same callee detection, same site keys) but records the
 * nodes the checker needs: the input value expression and the
 * contract TypeNodes. A call the extractor would reject (wrong
 * arity, missing spec) is recorded with null types and skipped by
 * the checker's rules — extraction fails loudly first, so the
 * checker never has to diagnose those. */
function collectTrapSites(program: ts.Program, files: string[]): TrapSiteRecord[] {
  const out: TrapSiteRecord[] = [];
  for (const fileAbs of files) {
    const sf = program.getSourceFile(fileAbs);
    if (!sf) continue;
    const importedWrappers = new Set<string>();
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.includes("agentts")) {
        const clause = st.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) importedWrappers.add(el.name.text);
        }
      }
    }
    const localNames = new Set<string>();
    (function collectLocals(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name) localNames.add(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) localNames.add(node.name.text);
      ts.forEachChild(node, collectLocals);
    })(sf);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        if (name !== null && (name === "trap" || WRAPPER_NAMES.has(name))) {
          const { line, column } = loc(sf, node);
          const args = node.typeArguments ?? [];
          const push = (
            key: string,
            kind: string,
            inputValue: ts.Expression | undefined,
            inputTypeNode: ts.TypeNode | undefined,
            outputTypeNode: ts.TypeNode | undefined,
          ): void => {
            out.push({
              key,
              kind,
              call: node,
              file: fileAbs,
              line,
              column,
              inputValue,
              inputTypeNode,
              outputTypeNode,
              inputTypeName: inputTypeNode ? typeArgName(inputTypeNode) : null,
              outputTypeName: outputTypeNode ? typeArgName(outputTypeNode) : null,
            });
          };
          if (name === "trap") {
            const first = node.arguments[0];
            const trapType = first && ts.isStringLiteral(first) ? first.text : null;
            if (trapType !== null) {
              let key = trapType;
              if (trapType === "job") {
                const spec = literalProp(node.arguments[1], "spec") ?? literalProp(node.arguments[1], "op");
                key = spec !== null ? `job:${spec}` : trapType;
              }
              if (args.length === 2) {
                push(key, "trap", node.arguments[1], args[0], args[1]);
              } else if (args.length === 0) {
                const declared = declaredResultType(node);
                push(
                  key,
                  "trap",
                  node.arguments[1],
                  undefined,
                  declared.node ?? undefined,
                );
                const rec = out[out.length - 1];
                rec.outputTypeName = declared.type;
              }
              // Wrong arity: the extractor fails loudly; skip.
            }
          } else if (importedWrappers.has(name)) {
            if (name === "job") {
              if (args.length === 2) {
                const spec = literalProp(node.arguments[0], "spec");
                push(spec !== null ? `job:${spec}` : "job", "job", jobInputValue(node.arguments[0]), args[0], args[1]);
              }
            } else if (name === "decide") {
              if (args.length === 1) push("decide", "decide", node.arguments[0], undefined, args[0]);
            } else if (args.length === 0) {
              push(name, name, node.arguments[0], undefined, undefined);
            }
          } else if (!localNames.has(name)) {
            // Not imported and not local: the extractor fails loudly.
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

// ------------------------------------------------------- contract rules

function isLibDate(t: ts.Type): boolean {
  const sym = t.getSymbol() ?? t.aliasSymbol;
  if (!sym || sym.getName() !== "Date") return false;
  const decls = sym.getDeclarations() ?? [];
  return decls.some((d) => /\/lib\.[^/]*\.d\.ts$/.test(d.getSourceFile().fileName));
}

function declarationsIncludeClass(t: ts.Type): boolean {
  for (const sym of [t.getSymbol(), t.aliasSymbol]) {
    if (!sym) continue;
    for (const d of sym.getDeclarations() ?? []) {
      if (ts.isClassDeclaration(d)) return true;
    }
  }
  return false;
}

/** Resolve a contract type by declaration name in a file (the
 * module's fixed types, which have no call-site TypeNode). */
function resolveContractTypeByName(
  checker: ts.TypeChecker,
  program: ts.Program,
  file: string,
  name: string,
): ts.Type | null {
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

function checkContractType(
  checker: ts.TypeChecker,
  t: ts.Type,
  typePath: string,
  label: string,
  ancestors: Set<ts.Type>,
  problems: CheckerDiagnostic[],
  at: { file: string; line: number; column: number },
  checkEmpty: boolean,
): void {
  const flags = t.getFlags();
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return; // extraction owns these
  if (flags & ts.TypeFlags.Undefined) return; // optional members: the union walk below drops undefined
  if (flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean | ts.TypeFlags.Null |
    ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral |
    ts.TypeFlags.EnumLiteral | ts.TypeFlags.Enum | ts.TypeFlags.Void)) return; // leaf
  if (isLibDate(t)) return; // Date is the sanctioned conversion
  if (t.getCallSignatures().length > 0) return; // function: extraction owns it
  if (declarationsIncludeClass(t)) {
    const name = checker.typeToString(t);
    problems.push(
      diag(
        at.file, at.line, at.column, "M2-CLASS",
        `${label} at ${typePath}: type \`${name}\` is a class — class instances cannot cross a trap boundary (the prototype and methods do not survive JSON; the runtime rejects class instances)`,
        "use a plain interface or type alias for the contract type",
        null, name,
      ),
    );
    return;
  }
  if (ancestors.has(t)) return; // recursive — already being checked
  ancestors.add(t);
  try {
    if (t.isUnion()) {
      for (const m of t.types) {
        if (m.getFlags() & ts.TypeFlags.Undefined) continue;
        checkContractType(checker, m, typePath, label, ancestors, problems, at, checkEmpty);
      }
      return;
    }
    if (t.isIntersection()) {
      for (const m of t.types) checkContractType(checker, m, typePath, label, ancestors, problems, at, checkEmpty);
      return;
    }
    if (checker.isArrayType(t)) {
      const el = (t as ts.TypeReference).typeArguments?.[0];
      if (el) checkContractType(checker, el, `${typePath}[]`, label, ancestors, problems, at, checkEmpty);
      return;
    }
    if (checker.isTupleType(t)) {
      const els = (t as ts.TypeReference).typeArguments ?? [];
      els.forEach((el, i) => checkContractType(checker, el, `${typePath}[${i}]`, label, ancestors, problems, at, checkEmpty));
      return;
    }
    if (flags & ts.TypeFlags.Object) {
      const props = checker.getPropertiesOfType(t);
      const strIdx = t.getStringIndexType();
      const numIdx = t.getNumberIndexType();
      if (props.length === 0 && !strIdx && !numIdx) {
        // Output-only (see the M2-EMPTY rule): an empty input type
        // is the honest "takes no input" encoding. Still return:
        // there is nothing below an empty type to check.
        if (checkEmpty) {
          problems.push(
            diag(
              at.file, at.line, at.column, "M2-EMPTY",
              `${label} at ${typePath}: type \`${checker.typeToString(t)}\` is empty — it carries no data (an empty interface extracts to a schema that admits only \`{}\`); a contract that can carry no data is degenerate`,
              "add fields to the type, or use a concrete type that carries the data",
              null, checker.typeToString(t),
            ),
          );
        }
        return;
      }
      for (const prop of props) {
        const decl = prop.valueDeclaration ?? prop.getDeclarations()?.[0];
        const pt = checker.getTypeOfSymbolAtLocation(prop, decl ?? (t as unknown as ts.Node));
        if (pt.isUnion()) {
          for (const m of pt.types) {
            if (m.getFlags() & ts.TypeFlags.Undefined) continue;
            checkContractType(checker, m, `${typePath}.${prop.getName()}`, label, ancestors, problems, at, checkEmpty);
          }
          continue;
        }
        checkContractType(checker, pt, `${typePath}.${prop.getName()}`, label, ancestors, problems, at, checkEmpty);
      }
      if (strIdx) checkContractType(checker, strIdx, `${typePath}[string]`, label, ancestors, problems, at, checkEmpty);
      else if (numIdx) checkContractType(checker, numIdx, `${typePath}[number]`, label, ancestors, problems, at, checkEmpty);
      return;
    }
  } finally {
    ancestors.delete(t);
  }
}

// ------------------------------------------------------------ layering

/** A file is layer 3 (allowed to touch Muse) when it is the muse
 * adapter itself or lives under plugins/muse/. Everything else —
 * the module (layer 1), the host (layer 2), workflows and their
 * libraries — is not. */
function isLayer3File(file: string): boolean {
  return file.includes("/plugins/muse/") || file.endsWith("/plugins/muse/src/muse-adapter.ts");
}

function isMuseTarget(spec: string, resolvedAbs: string | null): boolean {
  if (spec.includes("muse-adapter") || spec.includes("plugins/muse")) return true;
  if (!resolvedAbs) return false;
  return resolvedAbs.includes("/plugins/muse/") || resolvedAbs.endsWith("/plugins/muse/src/muse-adapter.ts");
}

/** The layering boundary over a list of files (AST-only, no
 * program needed): M2-LAYER-MUSE for a non-layer-3 file importing
 * a Muse-specific module; M2-LAYER-PLUGIN for a workflow or the
 * agentts module importing anything under plugins/. Dynamic
 * import() (the host's plugin loader) is not a static import
 * declaration and is not flagged. */
export function checkLayeringFiles(files: string[]): CheckerDiagnostic[] {
  const diagnostics: CheckerDiagnostic[] = [];
  for (const file of files) {
    if (!fs.existsSync(file) || !file.endsWith(".ts")) continue;
    const source = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const layer3 = isLayer3File(file);
    const isWorkflowOrModule =
      file.endsWith("/agentts.ts") || file.includes("/workflows/") || file.includes("/tests/workflows/");
    // A file that itself lives under plugins/ is plugin code, not a
    // workflow: its relative imports resolve to siblings under the
    // same plugin (e.g. the mock plugin's test workflows importing
    // its own agentts module) — that is not "importing from
    // plugins/". The PLUGIN rule applies to workflows and the
    // module outside plugins/.
    const sourceUnderPlugins = file.includes("/plugins/");
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      let resolvedAbs: string | null = null;
      if (spec.startsWith(".")) {
        const resolved = ts.resolveModuleName(spec, file, GATE_COMPILER_OPTIONS, ts.sys);
        resolvedAbs = resolved.resolvedModule?.resolvedFileName ?? null;
      }
      const { line, column } = loc(sf, st);
      if (isMuseTarget(spec, resolvedAbs) && !layer3) {
        diagnostics.push(
          diag(
            file, line, column, "M2-LAYER-MUSE",
            `layering violation: ${path.basename(file)} imports Muse-specific module \`${spec}\` — only the adapter (layer 3) may touch Muse (subagent/chat APIs); core + host never import them`,
            "move the Muse interaction behind the adapter seam (plugins/muse/src/muse-adapter.ts), and call it through the adapter interface",
            null, spec,
          ),
        );
      }
      if (
        isWorkflowOrModule &&
        !sourceUnderPlugins &&
        ((resolvedAbs && resolvedAbs.includes("/plugins/")) || spec.includes("plugins/"))
      ) {
        diagnostics.push(
          diag(
            file, line, column, "M2-LAYER-PLUGIN",
            `layering violation: ${path.basename(file)} imports from plugins/ (\`${spec}\`) — workflows never import adapters; the host loads them`,
            "remove the import — the workflow talks to traps only, and the host supplies the adapter",
            null, spec,
          ),
        );
      }
    }
  }
  return diagnostics;
}

// --------------------------------------------------- schema compatibility

/** The layering boundary for one workflow (AST-only, no program
 * needed): collect its files and check them. Runs BEFORE tsc in
 * the gate — a forbidden import is the violation, and requiring
 * the forbidden module to type-check first in order to report it
 * would be backwards. (The parenthetical in the original BRA-29
 * note — that the muse adapter "does not type-check under the
 * gate's flags because it uses the `Bun` global" — is stale since
 * BRA-58: the gate program now includes bun-types when resolvable.
 * The ordering still stands on its own: layering is a property of
 * the import, not of the imported module's types.) */
export function checkLayeringForWorkflow(workflowPath: string): CheckerDiagnostic[] {
  return checkLayeringFiles(collectCheckerFiles(path.resolve(workflowPath)));
}

/** Whether `node` sits inside a type node: walk up the parent
 * chain — a `Bun` inside a TypeReferenceNode / TypeQueryNode / any
 * other TypeNode is a TYPE use (erased at runtime), never a value
 * use. Parent pointers require a bound program: the checker walks
 * program source files (runChecker), never a fresh
 * createSourceFile parse. */
function isInTypeNode(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isTypeNode(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

/** Whether the identifier is in a NAME position, not a value
 * reference: a property name (`x.Bun`, `{ Bun: 1 }`), a declaration
 * name (`const Bun = …`, `function Bun() {}`), an import/export
 * specifier, a parameter or binding name. Those resolve to a
 * property / a local binding, never to the `Bun` global — except
 * `globalThis.Bun`, which IS the global reached through globalThis
 * and is handled by the caller. */
function isNamePosition(node: ts.Identifier): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p)) &&
    p.name === node
  )
    return true;
  if ((ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) && p.name === node) return true;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isModuleDeclaration(p)) &&
    (p as { name?: ts.Node }).name === node
  )
    return true;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p))
    return true;
  if (ts.isParameter(p) && p.name === node) return true;
  if (ts.isBindingElement(p) && p.name === node) return true;
  return false;
}

/** M2-BUN (BRA-58): value-position references to the `Bun` global
 * over a workflow's files. A `Bun` identifier is flagged only when
 * all three hold: it is not inside a type node (type uses are
 * legal), it is not in a name position (a property / local binding
 * is not the global — except `globalThis.Bun`, which is the
 * global), and it resolves through the type checker to a
 * declaration in bun-types (the ambient `Bun` global). A local
 * `const Bun = …` resolves to the workflow's own declaration and
 * is not flagged; an unresolved `Bun` (bun-types missing) never
 * reaches the checker — tsc refuses it first with TS2867. The
 * checker reports only references it is sure are the global, never
 * guessed: a flow it cannot establish is skipped. */
export function checkBunUsage(program: ts.Program, files: string[]): CheckerDiagnostic[] {
  const diagnostics: CheckerDiagnostic[] = [];
  const checker = program.getTypeChecker();
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf || sf.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "Bun") {
        const viaGlobalThis =
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node &&
          ts.isIdentifier(node.parent.expression) &&
          node.parent.expression.text === "globalThis";
        if (!isInTypeNode(node) && (viaGlobalThis || !isNamePosition(node))) {
          const sym = checker.getSymbolAtLocation(node);
          const decls = sym?.getDeclarations() ?? [];
          const isBunGlobal =
            decls.length > 0 &&
            decls.every((d) => {
              const df = d.getSourceFile();
              return df.isDeclarationFile && df.fileName.includes("bun-types");
            });
          if (isBunGlobal) {
            const { line, column } = loc(sf, node);
            diagnostics.push(
              diag(
                file,
                line,
                column,
                "M2-BUN",
                `workflow references the Bun global (\`Bun\` in a value position) — the engine (dquickts) provides no Bun global, so this would fail at runtime; the gate type-checks Bun types only`,
                "move the Bun.* use into an adapter (layer 3) or a host-side helper — workflows may use Bun types (e.g. Bun.BunFile) but never call Bun.* at runtime",
                null,
                "Bun",
              ),
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return diagnostics;
}

/** The first-run gate's first step: layering, then tsc. The host,
 * the mock plugin, and `agentts check` all call this from the
 * onFirstRun hook, so a layering violation is refused with
 * CheckerError before the compiler ever looks at the forbidden
 * module. */
export function runGateWithLayering(program: ts.Program, workflowPath: string): void {
  const layering = checkLayeringForWorkflow(workflowPath);
  if (layering.length) throw new CheckerError(workflowPath, layering);
  runGate(program, workflowPath);
}

function resolveRef(schema: any, root: any): any {
  let cur = schema;
  const seen = new Set<any>();
  while (cur && typeof cur === "object" && typeof cur.$ref === "string" && !seen.has(cur)) {
    seen.add(cur);
    const ref: string = cur.$ref;
    const m = ref.match(/^#\/(definitions|\$defs)\/(.+)$/);
    if (!m) return cur;
    const key = decodeURIComponent(m[2]).replace(/~1/g, "/").replace(/~0/g, "~");
    const defs = root?.[m[1]];
    if (!defs || !(key in defs)) return cur;
    cur = defs[key];
  }
  return cur;
}

/** Descend a schema by path segments (".prop", "[]"). Returns the
 * sub-schema, or null when the path does not exist in the schema
 * (the caller treats that as "cannot verify", not a mismatch). */
export function descendSchema(schema: any, root: any, segments: string[]): any | null {
  let cur = resolveRef(schema, root);
  for (const seg of segments) {
    if (!cur || typeof cur !== "object") return null;
    cur = resolveRef(cur, root);
    if (seg === "[]") {
      if (cur.items && typeof cur.items === "object") {
        cur = cur.items;
        continue;
      }
      if (Array.isArray(cur.prefixItems) && cur.prefixItems.length) {
        cur = cur.prefixItems[0];
        continue;
      }
      return null;
    }
    const prop = seg.startsWith(".") ? seg.slice(1) : seg;
    if (cur.properties && typeof cur.properties === "object" && prop in cur.properties) {
      cur = cur.properties[prop];
      continue;
    }
    if (cur.additionalProperties && typeof cur.additionalProperties === "object") {
      cur = cur.additionalProperties;
      continue;
    }
    return null;
  }
  return resolveRef(cur, root);
}

function typeCompatible(producerType: string | string[] | undefined, consumerType: string | string[] | undefined): boolean {
  if (!producerType || !consumerType) return true;
  const p = Array.isArray(producerType) ? producerType : [producerType];
  const c = Array.isArray(consumerType) ? consumerType : [consumerType];
  // The producer must be able to supply every type the consumer accepts
  // — no: the producer supplies ONE of its types; the consumer must
  // accept it. Compatible when some producer type is accepted by the
  // consumer (integer counts as number).
  return p.some((pt) => c.some((ct) => pt === ct || (pt === "integer" && ct === "number")));
}

/**
 * Is every value the producer schema admits also admitted by the
 * consumer schema, at this path? Returns a mismatch message, or
 * null when compatible (or when compatibility cannot be proven —
 * an unconstrained producer `{}` never fails, and formats are
 * annotation-only, as in validate.ts). Structural, recursive:
 * type, required properties, shared properties, array items,
 * anyOf/oneOf (some branch must fit), allOf (every branch must
 * fit). A missing required property on the producer side is the
 * common failure: the consumer needs a field the producer never
 * supplies.
 */
export function verifySchemaCompatibility(
  producer: any,
  consumer: any,
  jsonPath: string,
  producerRoot: any = producer,
  consumerRoot: any = consumer,
): string | null {
  const p = resolveRef(producer, producerRoot);
  const c = resolveRef(consumer, consumerRoot);
  if (c === true) return null;
  if (c === false) return `${jsonPath}: consumer schema admits nothing`;
  if (!c || typeof c !== "object") return null;
  if (!p || typeof p !== "object") return null;
  if (Object.keys(p).length === 0) return null; // unconstrained producer: cannot prove a mismatch
  if (p === true) return null;
  if (p === false) return `${jsonPath}: producer schema admits nothing`;
  if (typeof c.type === "string" || Array.isArray(c.type)) {
    if (typeof p.type === "string" || Array.isArray(p.type)) {
      if (!typeCompatible(p.type, c.type)) {
        return `${jsonPath}: producer type ${JSON.stringify(p.type)} cannot satisfy consumer type ${JSON.stringify(c.type)}`;
      }
    }
  }
  if (Array.isArray(c.required)) {
    for (const req of c.required) {
      const hasProp = p.properties && typeof p.properties === "object" && req in p.properties;
      const openEnded =
        (p.additionalProperties && typeof p.additionalProperties === "object") ||
        p.additionalProperties === true ||
        (p.patternProperties && typeof p.patternProperties === "object");
      if (!hasProp && !openEnded) {
        return `${jsonPath}: consumer requires property '${req}' but the producer never supplies it`;
      }
    }
  }
  if (c.properties && typeof c.properties === "object" && p.properties && typeof p.properties === "object") {
    for (const prop of Object.keys(c.properties)) {
      if (!(prop in p.properties)) continue; // optional on the producer side: only `required` above fails
      const hit = verifySchemaCompatibility(
        p.properties[prop],
        c.properties[prop],
        `${jsonPath}.${prop}`,
        producerRoot,
        consumerRoot,
      );
      if (hit) return hit;
    }
  }
  if (c.items && typeof c.items === "object" && p.items && typeof p.items === "object") {
    const hit = verifySchemaCompatibility(p.items, c.items, `${jsonPath}[]`, producerRoot, consumerRoot);
    if (hit) return hit;
  }
  if (Array.isArray(c.anyOf) || Array.isArray(c.oneOf)) {
    const branches = c.anyOf ?? c.oneOf;
    const fits = branches.some(
      (b: any) => verifySchemaCompatibility(p, b, jsonPath, producerRoot, consumerRoot) === null,
    );
    if (!fits) return `${jsonPath}: producer schema fits none of the consumer's ${c.anyOf ? "anyOf" : "oneOf"} branches`;
  }
  if (Array.isArray(c.allOf)) {
    for (const b of c.allOf) {
      const hit = verifySchemaCompatibility(p, b, jsonPath, producerRoot, consumerRoot);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------- wiring

interface Origin {
  /** Producer site key, or null for a library-callback parameter
   * (resolved to a site later, by output-type identity). */
  siteKey: string | null;
  /** The checker type of the value at the current position. */
  type: ts.Type;
  /** The type of the ROOT value the flow started from (the trap
   * output type, or the callback parameter's type). Property
   * accesses and casts change `type` but never `rootType`: the
   * producer is matched on the root, not on the accessed slot. */
  rootType: ts.Type;
  /** Path within the producer's output schema (".prop", "[]"). */
  path: string[];
  /** The flow crossed an `as` cast, an any/unknown annotation, or
   * a JSON round-trip — the places TypeScript cannot check it. */
  blind: boolean;
}

function isOutcomeType(checker: ts.TypeChecker, t: ts.Type): boolean {
  return checker.typeToString(t).startsWith("Outcome<");
}

/** Declaration identity of a type: "<file>#<name>", for matching a
 * callback parameter's type against a trap site's output type.
 * Arrays unwrap to their element type; unions try each member. */
function typeDeclIdentities(checker: ts.TypeChecker, t: ts.Type): string[] {
  if (t.isUnion()) {
    return t.types.flatMap((m) => typeDeclIdentities(checker, m));
  }
  if (checker.isArrayType(t)) {
    const el = (t as ts.TypeReference).typeArguments?.[0];
    return el ? typeDeclIdentities(checker, el) : [];
  }
  const sym = t.getSymbol() ?? t.aliasSymbol;
  if (!sym) return [];
  const decl = (sym.getDeclarations() ?? [])[0];
  if (!decl) return [];
  return [`${decl.getSourceFile().fileName}#${sym.getName()}`];
}

/** Declaration identity WITHOUT array unwrapping: an array type
 * has no identity of its own — the nested walk must descend into
 * its element (path `[]`) rather than match the array itself. */
function rawTypeIdentities(checker: ts.TypeChecker, t: ts.Type): string[] {
  if (t.isUnion()) {
    return t.types.flatMap((m) => rawTypeIdentities(checker, m));
  }
  const sym = t.getSymbol() ?? t.aliasSymbol;
  if (!sym) return [];
  const decl = (sym.getDeclarations() ?? [])[0];
  if (!decl) return [];
  return [`${decl.getSourceFile().fileName}#${sym.getName()}`];
}

/** Find the single trap site whose output type is the given type
 * (declaration identity). Zero or several matches = ambiguous, and
 * the edge is skipped rather than guessed. The match is direct
 * (the output type IS the type, e.g. a JudgeVerdict parameter
 * against the judge site) or nested (the type occurs at a path
 * inside an output type, e.g. a PaperCandidate parameter against
 * the discovery site at `.candidates[]`) — the fan-out `.map((c) =>
 * job({paper: c}))` pattern needs the nested form. The returned
 * path is the prefix within the producer's output schema the
 * parameter's value sits at. */
function findProducerSiteForType(
  checker: ts.TypeChecker,
  program: ts.Program,
  moduleFile: string | null,
  sites: TrapSiteRecord[],
  extraction: CheckerExtraction,
  type: ts.Type,
): { site: TrapSiteRecord; path: string[]; arrayWrap: boolean } | null {
  const want = new Set(typeDeclIdentities(checker, type));
  if (!want.size) return null;
  // The parameter's value is an array of the matched type (one
  // level, e.g. `verdicts: JudgeVerdict[]` against the judge site):
  // the producer schema for the comparison is the ARRAY of the
  // output schema, not the bare output schema.
  let arrayWrap = false;
  if (checker.isArrayType(type)) {
    const el = (type as ts.TypeReference).typeArguments?.[0];
    arrayWrap = !!el && !checker.isArrayType(el);
  }
  const candidates: { site: TrapSiteRecord; path: string[] }[] = [];
  const walkNested = (
    t: ts.Type,
    typePath: string[],
    depth: number,
    ancestors: Set<ts.Type>,
  ): void => {
    if (depth > 4 || ancestors.has(t)) return;
    if (rawTypeIdentities(checker, t).some((id) => want.has(id))) {
      candidates.push({ site: currentSite!, path: typePath });
      return;
    }
    ancestors.add(t);
    try {
      if (t.isUnion()) {
        for (const m of t.types) walkNested(m, typePath, depth + 1, ancestors);
        return;
      }
      if (checker.isArrayType(t)) {
        const el = (t as ts.TypeReference).typeArguments?.[0];
        if (el) walkNested(el, [...typePath, "[]"], depth + 1, ancestors);
        return;
      }
      if (t.getFlags() & ts.TypeFlags.Object) {
        for (const prop of checker.getPropertiesOfType(t)) {
          const decl = prop.valueDeclaration ?? prop.getDeclarations()?.[0];
          const pt = checker.getTypeOfSymbolAtLocation(prop, decl ?? (t as unknown as ts.Node));
          walkNested(pt, [...typePath, `.${prop.getName()}`], depth + 1, ancestors);
        }
      }
    } finally {
      ancestors.delete(t);
    }
  };
  let currentSite: TrapSiteRecord | null = null;
  for (const s of sites) {
    if (!s.outputTypeName) continue;
    let outType: ts.Type | null = null;
    if (s.outputTypeNode) outType = checker.getTypeFromTypeNode(s.outputTypeNode);
    else if (moduleFile) outType = resolveContractTypeByName(checker, program, moduleFile, s.outputTypeName);
    if (!outType) continue;
    currentSite = s;
    walkNested(outType, [], 0, new Set());
  }
  currentSite = null;
  const keys = [...new Set(candidates.map((c) => `${c.site.key}\0${c.path.join("")}`))];
  if (keys.length !== 1) return null;
  const found = candidates.find((c) => `${c.site.key}\0${c.path.join("")}` === keys[0]) ?? null;
  return found ? { ...found, arrayWrap } : null;
}

function checkWiring(
  checker: ts.TypeChecker,
  program: ts.Program,
  files: string[],
  sites: TrapSiteRecord[],
  extraction: CheckerExtraction,
  moduleFile: string | null,
  problems: CheckerDiagnostic[],
): void {
  const siteByNode = new Map<ts.Node, TrapSiteRecord>();
  for (const s of sites) siteByNode.set(s.call, s);

  for (const fileAbs of files) {
    const sf = program.getSourceFile(fileAbs);
    if (!sf) continue;
    // Origin maps, populated in source order as the walk meets
    // declarations. Symbols are the keys: one variable, one origin.
    const origins = new Map<ts.Symbol, Origin>();
    const paramTypes = new Map<ts.Symbol, ts.Type>();

    const originOfExpr = (expr: ts.Expression): Origin | null => {
      if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
        return originOfExpr(expr.expression as ts.Expression);
      }
      if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
        const inner = originOfExpr(expr.expression);
        return inner ? { ...inner, blind: true } : null;
      }
      if (ts.isCallExpression(expr)) {
        const site = siteByNode.get(expr);
        if (site && site.outputTypeName) {
          const outType = site.outputTypeNode
            ? checker.getTypeFromTypeNode(site.outputTypeNode)
            : moduleFile
              ? resolveContractTypeByName(checker, program, moduleFile, site.outputTypeName)
              : null;
          if (!outType) return null;
          return { siteKey: site.key, type: outType, rootType: outType, path: [], blind: false };
        }
        // JSON.parse(JSON.stringify(x)) — the round-trip erases the
        // type (any) but the value keeps its origin. stringify
        // preserves the origin for the parse; parse preserves it
        // for the consumer.
        if (
          ts.isPropertyAccessExpression(expr.expression) &&
          ts.isIdentifier(expr.expression.expression) &&
          expr.expression.expression.text === "JSON" &&
          (expr.expression.name.text === "parse" || expr.expression.name.text === "stringify") &&
          expr.arguments.length === 1
        ) {
          const inner = originOfExpr(expr.arguments[0] as ts.Expression);
          return inner ? { ...inner, blind: true } : null;
        }
        return null;
      }
      if (ts.isIdentifier(expr)) {
        const sym = checker.getSymbolAtLocation(expr);
        if (!sym) return null;
        const traced = origins.get(sym);
        if (traced) return traced;
        const pt = paramTypes.get(sym);
        if (pt) return { siteKey: null, type: pt, rootType: pt, path: [], blind: false };
        return null;
      }
      if (ts.isPropertyAccessExpression(expr)) {
        const base = originOfExpr(expr.expression);
        if (!base) return null;
        // Outcome<T>.value unwraps to T: the schema has no Outcome
        // in it, so the path does not extend.
        if (expr.name.text === "value" && isOutcomeType(checker, checker.getTypeAtLocation(expr.expression))) {
          return base;
        }
        return { ...base, type: checker.getTypeAtLocation(expr), path: [...base.path, `.${expr.name.text}`] };
      }
      if (ts.isElementAccessExpression(expr)) {
        const base = originOfExpr(expr.expression);
        if (!base) return null;
        const arg = expr.argumentExpression;
        const seg = ts.isStringLiteral(arg) ? `.${arg.text}` : "[]";
        return { ...base, type: checker.getTypeAtLocation(expr), path: [...base.path, seg] };
      }
      return null;
    };

    const recordVar = (decl: ts.VariableDeclaration): void => {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) return;
      const sym = checker.getSymbolAtLocation(decl.name);
      if (!sym) return;
      const origin = originOfExpr(decl.initializer);
      if (!origin) return;
      // A variable annotated `any`/`unknown` erases the type at
      // its declaration: tsc cannot check flows out of it, so the
      // flow out of it counts as blind (the checker traced the
      // origin instead).
      const varType = checker.getTypeAtLocation(decl.name);
      origins.set(
        sym,
        varType.getFlags() & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
          ? { ...origin, blind: true }
          : origin,
      );
    };

    // Walk the file once: record origins, then check each trap
    // site's input for values with a traced origin.
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) recordVar(node);
      if (ts.isForOfStatement(node)) {
        const origin = originOfExpr(node.expression);
        if (origin && ts.isVariableDeclarationList(node.initializer)) {
          const decl = node.initializer.declarations[0];
          if (decl && ts.isIdentifier(decl.name)) {
            const sym = checker.getSymbolAtLocation(decl.name);
            if (sym) origins.set(sym, { ...origin, path: [...origin.path, "[]"] });
          }
        }
      }
      if (
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) &&
        node.parameters
      ) {
        for (const p of node.parameters) {
          if (ts.isIdentifier(p.name)) {
            const sym = checker.getSymbolAtLocation(p.name);
            if (sym) paramTypes.set(sym, checker.getTypeAtLocation(p));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    // Consumer pass: each trap site's input value, walked for
    // traced expressions. Only the OUTERMOST traced expression at
    // each position is an edge (its children are part of the same
    // value, not separate edges).
    for (const consumer of sites.filter((s) => s.file === fileAbs)) {
      if (!consumer.inputValue) continue;
      const consumerSite = extraction.sites[consumer.key];
      if (!consumerSite || !consumerSite.inputSchema) continue;
      let consumerInputType: ts.Type | null = null;
      if (consumer.inputTypeNode) consumerInputType = checker.getTypeFromTypeNode(consumer.inputTypeNode);
      else if (consumer.inputTypeName && moduleFile) {
        consumerInputType = resolveContractTypeByName(checker, program, moduleFile, consumer.inputTypeName);
      }

      const seenEdges = new Set<string>();
      // `blindSeen` tracks casts the walk itself unwrapped: when
      // the walk descends through an `as` cast to reach the value,
      // the flow is blind even though originOfExpr on the inner
      // expression reports it as direct.
      const walkInput = (node: ts.Node, literalPath: string[], blindSeen = false): void => {
        if (ts.isObjectLiteralExpression(node)) {
          for (const prop of node.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
              walkInput(prop.initializer, [...literalPath, `.${prop.name.text}`], blindSeen);
            } else if (ts.isShorthandPropertyAssignment(prop)) {
              walkInput(prop.name, [...literalPath, `.${prop.name.text}`], blindSeen);
            } else if (ts.isSpreadAssignment(prop)) {
              walkInput(prop.expression, literalPath, blindSeen);
            }
          }
          return;
        }
        if (ts.isArrayLiteralExpression(node)) {
          for (const el of node.elements) walkInput(el, [...literalPath, "[]"], blindSeen);
          return;
        }
        if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
          walkInput(node.expression as ts.Expression, literalPath, true);
          return;
        }
        if (!ts.isExpression(node)) return;
        const traced = originOfExpr(node as ts.Expression);
        if (!traced) return;
        const origin: Origin = blindSeen ? { ...traced, blind: true } : traced;
        // Resolve the producer: a site origin names it directly; a
        // parameter origin resolves it by ROOT-type identity
        // (directly, or nested at a path inside the output type —
        // the fan-out `.map((c) => ...)` pattern). The producer
        // path is the nested prefix plus the access path on the
        // value itself; when the root value is an array of the
        // matched type, the comparison schema is the array of the
        // output schema.
        let producer: TrapSiteRecord | null = null;
        let producerPath = origin.path;
        let arrayWrap = false;
        if (origin.siteKey) {
          producer = sites.find((s) => s.key === origin.siteKey) ?? null;
        } else {
          const found = findProducerSiteForType(checker, program, moduleFile, sites, extraction, origin.rootType);
          if (!found) return;
          producer = found.site;
          producerPath = [...found.path, ...origin.path];
          arrayWrap = found.arrayWrap;
        }
        if (!producer) return;
        const producerSite = extraction.sites[producer.key];
        if (!producerSite) return;
        const edgeKey = `${producer.key}\0${consumer.key}\0${literalPath.join("")}\0${producerPath.join("")}`;
        if (seenEdges.has(edgeKey)) return;
        seenEdges.add(edgeKey);
        let producerSchema = descendSchema(producerSite.outputSchema, producerSite.outputSchema, producerPath);
        if (producerSchema !== null && arrayWrap) {
          producerSchema = { type: "array", items: producerSchema };
        }
        const consumerSchema = descendSchema(consumerSite.inputSchema, consumerSite.inputSchema, literalPath);
        if (producerSchema === null || consumerSchema === null) return; // cannot verify this edge: skip, never guess
        const jsonPath = literalPath.join("") || "$";
        const mismatch = verifySchemaCompatibility(
          producerSchema,
          consumerSchema,
          jsonPath,
          producerSite.outputSchema,
          consumerSite.inputSchema,
        );
        if (!mismatch) return;
        const { line, column } = loc(sf, node);
        const expectedStr = consumerInputType
          ? checker.typeToString(consumerInputType)
          : consumerSite.inputType ?? "?";
        problems.push(
          diag(
            fileAbs, line, column, "M2-WIRING",
            `wiring mismatch: the value flowing into \`${consumer.key}\` input at ${jsonPath} comes from \`${producer.key}\` (${checker.typeToString(origin.type)}) but does not match the input contract — ${mismatch}${origin.blind ? " (the flow crosses an `as` cast, an any/unknown value, or a JSON round-trip, so TypeScript could not check it — the checker traced the origin instead)" : ""}`,
            "make the producer's output match the consumer's input contract, or convert the value between the stages",
            `${expectedStr} at ${jsonPath}`,
            checker.typeToString(origin.type),
            { file: producer.file, line: producer.line, column: producer.column, site: producer.key },
          ),
        );
      };
      walkInput(consumer.inputValue, []);
    }
  }
}

// ------------------------------------------------------------------ entry

/** Run every M2 rule over a workflow program + its extraction.
 * Throws CheckerError when any rule fails. The program must be
 * bound (getSemanticDiagnostics called at least once — the gate
 * does that before the extractor runs, and extractWorkflow does it
 * before the onExtracted hook fires). */
export function runChecker(program: ts.Program, workflowPath: string, extraction: CheckerExtraction): void {
  const problems: CheckerDiagnostic[] = [];
  const files = collectCheckerFiles(path.resolve(workflowPath));
  const checker = program.getTypeChecker();
  const moduleFile = resolveAgenttsModule(workflowPath);
  const sites = collectTrapSites(program, files);

  // Layering over the workflow's own files.
  problems.push(...checkLayeringFiles(files));

  // M2-BUN over the workflow's own files: value uses of the Bun
  // global are refused here, after tsc (the gate program includes
  // bun-types, so tsc passes a value use — the checker is the half
  // that knows the engine has no Bun global).
  problems.push(...checkBunUsage(program, files));

  // Contract rules over every extracted site.
  for (const site of Object.values(extraction.sites)) {
    const record = sites.find((s) => s.key === site.key);
    const at = record
      ? { file: record.file, line: record.line, column: record.column }
      : { file: path.resolve(workflowPath), line: 1, column: 1 };
    for (const [side, typeName, typeNode] of [
      ["input", site.inputType, record?.inputTypeNode],
      ["output", site.outputType, record?.outputTypeNode],
    ] as const) {
      if (!typeName) continue;
      let resolved: ts.Type | null = null;
      if (typeNode) resolved = checker.getTypeFromTypeNode(typeNode);
      else if (moduleFile) resolved = resolveContractTypeByName(checker, program, moduleFile, typeName);
      if (!resolved) continue; // extraction owns unresolvable types
      // Point the diagnostic at the type argument when there is
      // one — that is where the author fixes it.
      const nodeAt = typeNode
        ? (() => {
            const sf = program.getSourceFile(record?.file ?? path.resolve(workflowPath));
            return sf ? { file: record?.file ?? path.resolve(workflowPath), ...loc(sf, typeNode) } : at;
          })()
        : at;
      checkContractType(
        checker,
        resolved,
        "$",
        `type \`${typeName}\` (used at ${site.key} (${side}))`,
        new Set(),
        problems,
        nodeAt,
        // M2-EMPTY is output-only: an empty input type is the
        // honest "takes no input" encoding. M2-CLASS applies to
        // both sides.
        side === "output",
      );
    }
  }

  // Wiring: producer output schemas vs consumer input schemas.
  checkWiring(checker, program, files, sites, extraction, moduleFile, problems);

  if (problems.length) throw new CheckerError(workflowPath, problems);
}

/** Refuse loudly when the TypeScript compiler is unavailable (or
 * not the pinned version): the checker needs it, and a silent skip
 * would reopen the hole the gate exists to close. AGENTTS_NO_COMPILER=1
 * forces this path (test hook). */
export function ensureCheckerCompiler(workflowPath: string): void {
  if (process.env.AGENTTS_NO_COMPILER === "1") {
    throw new CheckerError(workflowPath, [
      diag(
        workflowPath, 1, 1, "M2-COMPILER",
        "TypeScript compiler unavailable (AGENTTS_NO_COMPILER=1) — refusing to check the workflow rather than silently skipping the first-run gate",
        "install the pinned TypeScript compiler and re-run",
        null, null,
      ),
    ]);
  }
  assertCompilerVersion(workflowPath);
}

/**
 * Check a workflow file end to end without running it: tsc
 * (gate) → extract → M2 checker. The cache dir holds the
 * extraction; a cached entry skips the gate + checker exactly as
 * prepareRun does. Throws GateError / ExtractionError /
 * CheckerError, each carrying structured diagnostics. This is the
 * `agentts check` implementation and the write/check/fix loop's
 * check step.
 */
export function checkWorkflowFile(workflowPath: string, cacheDir: string): Extraction {
  ensureCheckerCompiler(workflowPath);
  return extractWorkflow(workflowPath, cacheDir, {
    onFirstRun: (program) => {
      runGateWithLayering(program, workflowPath);
    },
    onExtracted: (entry, program) => {
      runChecker(program, workflowPath, entry);
    },
  });
}

/** The checker version (gate.ts owns it: the extraction cache
 * trusts an entry only when it was written by this version). */
export function checkerVersion(): string {
  return CHECKER_VERSION;
}

/** Re-export for callers that format diagnostics generically. */
export type { GateDiagnostic };
