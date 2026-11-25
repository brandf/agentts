/**
 * Snapshot converter (BRA-134) — `agentts snapshot convert`.
 *
 * Converts a suspended run's snapshot (SNAP_FORMAT_VERSION 11) from
 * one dquickts engine build to another, by strip-and-recompile: the
 * old snapshot's bytecode cells are recompiled from their recorded
 * sources with the NEW engine's compile helper, the new code is
 * re-linked into the old snapshot (atoms, cpool, frame pcs), and the
 * state dir is rewritten under the new engine version + format
 * identity. The run then resumes under the new engine with the same
 * result it would have had under the old one.
 *
 * Provenance: a faithful TypeScript port of the BRA-115 prototype
 * (~/workspace/bra115/snapparse.py + convert.py, which proved the
 * algorithm end to end). The form decision (recorded in the BRA-134
 * brief header): TS port, not a C tool — the parser/writer is the
 * bulk of the work and ports near-mechanically to TS (Buffer/DataView,
 * LEB/zigzag-sleb); a C port would be 2–3x the code with manual memory
 * management in exactly the code whose job is byte-exactness. The
 * only engine-native operation is recompilation, isolated in the
 * 104-line compile helper (packages/durablets/compile-helper.c),
 * built per target engine with one `cc` invocation. The opcode table
 * is parsed from the target tree's quickjs-opcode.h at runtime.
 *
 * Split of ownership (from the BRA-115 findings): this module owns
 * the byte-level conversion (engine-format knowledge, driven by the
 * target tree's artifacts) and the state-dir surgery (AgentTS-owned
 * layout). No Python ships.
 *
 * Refusal semantics (the fault matrix): every refusal is a
 * ConvertRefusalError carrying the prototype's exact message; the CLI
 * prints `CONVERT REFUSED: <msg>` to stderr and exits 2, with no
 * output written and no state touched. Conversion happens fully in
 * memory; the state-dir surgery runs only after the converted bytes
 * are complete and verified. A snapshot already at the target version
 * (its build signature equals the new engine's) is reported as
 * already-converted, not rewritten. Parse failures are ParseError
 * (exit 1), never refusals.
 *
 * The two converter bugs stay fixed: the checkpoint is validated up
 * front, before any parse/compile/output; the pc-remap bound is
 * `<= byte_code_len` (a suspended frame's pc may equal the code
 * length — the return address one past the last instruction).
 *
 * One deliberate divergence from the prototype, found while proving
 * byte-identity against it: the prototype's strings-table interning
 * decodes lossily (errors="replace") and re-encodes, so a binary
 * string literal is not recognised as already present and is appended
 * as a U+FFFD-corrupted duplicate (the probe's captureTrapSite
 * constant: the prototype appended a 226-byte corrupted copy of the
 * 160-byte original). This port matches strings byte-exact on
 * (wide, raw bytes), reuses the true entry, and appends nothing for
 * it. The converted bytes therefore differ from the prototype's
 * output exactly there (34,884 bytes vs the prototype's 35,198) — the
 * TS output is the correct one: its cpool STRING points at the
 * original bytes, the prototype's at the corrupted copy.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatIdentityFor,
  parseHostNativeNames,
  prefixFor,
} from "./host";

/** A snapshot that cannot be parsed (truncated, bad magic, trailing data). */
export class ParseError extends Error {}
/** A conversion refusal (the fault matrix): exit 2, no output, no state touched. */
export class ConvertRefusalError extends Error {}

export const SNAPSHOT_MAGIC = "QJSSNAP\n";
export const SNAPSHOT_FORMAT_VERSION = 11;

const CELL_TYPES = ["context", "object", "var_ref", "frame", "module", "bytecode", "resolved"] as const;
type CellType = (typeof CELL_TYPES)[number];
// SNAP_ATOM_* enum order in quickjs-snapshot.c: STRING, GLOBAL_SYMBOL,
// SYMBOL, SYMBOL_NO_DESC, PRIVATE. Only SYMBOL_NO_DESC (3) has no string.
const SYMBOL_NO_DESC = 3;
// SNAP_VAL_* enum order in quickjs-snapshot.c
const SNAP_VAL = [
  "UNDEFINED", "NULL", "FALSE", "TRUE", "UNINITIALIZED", "INT32",
  "FLOAT64", "CATCH_OFFSET", "STRING", "SYMBOL", "BIG_INT",
  "OBJECT", "MODULE", "BYTECODE", "DEAD",
] as const;
// BCTagEnum in quickjs.c (1-based)
const BC_TAG: Record<number, string> = {
  1: "NULL", 2: "UNDEFINED", 3: "BOOL_FALSE", 4: "BOOL_TRUE",
  5: "INT32", 6: "FLOAT64", 7: "STRING", 8: "OBJECT", 9: "ARRAY",
  10: "BIG_INT", 11: "TEMPLATE_OBJECT", 12: "FUNCTION_BYTECODE",
  13: "MODULE", 14: "TYPED_ARRAY", 15: "ARRAY_BUFFER",
  16: "SHARED_ARRAY_BUFFER", 17: "DATE", 18: "OBJECT_VALUE",
  19: "OBJECT_REFERENCE", 20: "REGEXP", 21: "MAP", 22: "SET",
  23: "SYMBOL", 24: "PY_OBJECT",
};
const BC_TAG_FUNCTION_BYTECODE = 12;
const BC_TAG_MODULE = 13;
// pc2line encoding (quickjs.c:850)
const PC2LINE_BASE = -1;
const PC2LINE_RANGE = 5;
const PC2LINE_OP_FIRST = 1;
const FIRST_ATOM = 262; // JS_ATOM_END: predefined atoms 0..261 (quickjs-atom.h)
const PREDEFINED_ATOMS: ReadonlyArray<string | null> = [null, "null", "false", "true", "if", "else", "return", "var", "this", "delete", "void", "typeof", "new", "in", "instanceof", "do", "while", "for", "break", "continue", "switch", "case", "default", "throw", "try", "catch", "finally", "function", "debugger", "with", "class", "const", "enum", "export", "extends", "import", "super", "implements", "interface", "let", "package", "private", "protected", "public", "static", "yield", "await", "", "keys", "size", "length", "fileName", "lineNumber", "columnNumber", "message", "error", "suppressed", "cause", "errors", "stack", "stackTraceLimit", "prepareStackTrace", "name", "toString", "toLocaleString", "valueOf", "eval", "prototype", "constructor", "configurable", "writable", "enumerable", "value", "get", "set", "of", "using", "__proto__", "undefined", "number", "boolean", "string", "object", "symbol", "integer", "unknown", "arguments", "callee", "caller", "<eval>", "<ret>", "<var>", "<arg_var>", "<with>", "<using_value>", "<using_method>", "<using_await>", "lastIndex", "target", "index", "input", "defineProperties", "apply", "join", "concat", "split", "construct", "getPrototypeOf", "setPrototypeOf", "isExtensible", "preventExtensions", "has", "deleteProperty", "defineProperty", "getOwnPropertyDescriptor", "ownKeys", "add", "done", "next", "values", "source", "flags", "global", "unicode", "raw", "rawJSON", "new.target", "this.active_func", "<home_object>", "<computed_field>", "<static_computed_field>", "<class_fields_init>", "<brand>", "#constructor", "as", "from", "meta", "accessor", "*default*", "*", "Module", "then", "resolve", "reject", "promise", "proxy", "revoke", "async", "exec", "groups", "indices", "status", "reason", "globalThis", "bigint", "-0", "Infinity", "-Infinity", "NaN", "hasIndices", "ignoreCase", "multiline", "dotAll", "sticky", "unicodeSets", "not-equal", "timed-out", "ok", "toISOString", "alphabet", "lastChunkHandling", "omitPadding", "toJSON", "maxByteLength", "Object", "Array", "Error", "Number", "String", "Boolean", "Symbol", "Arguments", "Math", "JSON", "Date", "Function", "GeneratorFunction", "ForInIterator", "RegExp", "ArrayBuffer", "SharedArrayBuffer", "Uint8ClampedArray", "Int8Array", "Uint8Array", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "BigInt64Array", "BigUint64Array", "Float16Array", "Float32Array", "Float64Array", "DataView", "BigInt", "WeakRef", "FinalizationRegistry", "DOMException", "CallSite", "Map", "Set", "WeakMap", "WeakSet", "Iterator", "Iterator Helper", "Iterator Concat", "Iterator Wrap", "Iterator Zip", "Array From Async", "Map Iterator", "Set Iterator", "Array Iterator", "String Iterator", "RegExp String Iterator", "Generator", "Proxy", "Promise", "PromiseResolveFunction", "PromiseRejectFunction", "AsyncFunction", "AsyncFunctionResolve", "AsyncFunctionReject", "AsyncGeneratorFunction", "AsyncGenerator", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "InternalError", "AggregateError", "SuppressedError", "DisposableStack", "AsyncDisposableStack", "<brand>", "Symbol.toPrimitive", "Symbol.iterator", "Symbol.match", "Symbol.matchAll", "Symbol.replace", "Symbol.search", "Symbol.split", "Symbol.toStringTag", "Symbol.isConcatSpreadable", "Symbol.hasInstance", "Symbol.species", "Symbol.unscopables", "Symbol.asyncIterator", "Symbol.dispose", "Symbol.asyncDispose", "Symbol.metadata"];

export class Reader {
  readonly d: Buffer;
  p = 0;
  constructor(data: Buffer, pos = 0) {
    this.d = data;
    this.p = pos;
  }
  u8(): number {
    if (this.p >= this.d.length) throw new ParseError("truncated (u8)");
    return this.d[this.p++];
  }
  u16(): number {
    return this.bytes(2).readUInt16LE(0);
  }
  u32(): number {
    return this.bytes(4).readUInt32LE(0);
  }
  u64(): bigint {
    return this.bytes(8).readBigUInt64LE(0);
  }
  bytes(n: number): Buffer {
    const v = this.d.subarray(this.p, this.p + n);
    if (v.length !== n) throw new ParseError("truncated");
    this.p += n;
    return v;
  }
  leb(): number {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      v += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return v;
      shift += 7;
      if (shift > 63) throw new ParseError("leb too long");
    }
  }
  sleb(): number {
    // "sleb128" in THIS fork is ZIGZAG, not standard SLEB128:
    //   encode: leb((2*v) ^ -(v >> 31))   (quickjs.c:9482-9486)
    //   decode: (val >> 1) ^ -(val & 1)   (quickjs.c:9508-9520)
    // A standard-SLEB decoder reads zigzag bytes as ~2x the true
    // value (positive deltas double, negative deltas flip sign) — that
    // bug made pc2line lines go negative / past EOF and cols exceed
    // their lines. Verified against the engine's own dump_pc2line
    // output for the bra115 probe bundle (2026-11-19).
    const v = this.leb();
    return Math.floor(v / 2) ^ -(v & 1);
  }
  readString(): string {
    const n = this.leb();
    const wide = n & 1;
    const chars = n >> 1;
    const raw = this.bytes(chars << wide);
    return wide ? raw.toString("utf16le") : raw.toString("utf8");
  }
  readStringRaw(): [boolean, Buffer] {
    const n = this.leb();
    const wide = n & 1;
    const chars = n >> 1;
    return [wide === 1, this.bytes(chars << wide)];
  }
}

export function lebBytes(v: number): Buffer {
  const out: number[] = [];
  for (;;) {
    const b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) out.push(b | 0x80);
    else {
      out.push(b);
      return Buffer.from(out);
    }
  }
}

export function slebBytes(v: number): Buffer {
  // Zigzag encode, matching dbuf_put_sleb128 (quickjs.c:9482-9486):
  // leb((2*v) ^ -(v >> 31)), computed mod 2**32.
  const u = v >>> 0;
  const zz = (2 * u) ^ -(u >>> 31);
  return lebBytes(zz >>> 0);
}

export function encodeJsString(s: string): Buffer {
  // JS_WriteString: leb ((len<<1)|wide) + bytes. A string with lone
  // surrogates cannot round-trip through UTF-8 (Python raises
  // UnicodeEncodeError); it goes wide (UTF-16-LE) instead.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)) {
    const raw = Buffer.from(s, "utf16le");
    return Buffer.concat([lebBytes(((raw.length / 2) << 1) | 1), raw]);
  }
  const raw = Buffer.from(s, "utf8");
  return Buffer.concat([lebBytes(raw.length << 1), raw]);
}

// ---------------------------------------------------------------- pc2line

export type Pc2LineSegment = readonly [pc: number, line: number, col: number];

export function decodePc2line(buf: Buffer): {
  defLine: number;
  defCol: number;
  segments: Pc2LineSegment[];
} {
  const r = new Reader(buf);
  const defLine = r.leb() + 1;
  const defCol = r.leb() + 1;
  const segments: Pc2LineSegment[] = [[0, defLine, defCol]];
  let pc = 0;
  let line = defLine;
  let col = defCol;
  while (r.p < buf.length) {
    const op = r.u8();
    if (op === 0) {
      pc += r.leb();
      line += r.sleb();
    } else {
      const o = op - PC2LINE_OP_FIRST;
      pc += Math.floor(o / PC2LINE_RANGE);
      line += (o % PC2LINE_RANGE) + PC2LINE_BASE;
    }
    col += r.sleb();
    segments.push([pc, line, col]);
  }
  return { defLine, defCol, segments };
}

export function pcToLine(segments: readonly Pc2LineSegment[], pcValue: number): [number, number] {
  let line = segments[0][1];
  let col = segments[0][2];
  for (const [pc, ln, cl] of segments.slice(1)) {
    if (pcValue < pc) break;
    line = ln;
    col = cl;
  }
  return [line, col];
}

export function lineToPc(segments: readonly Pc2LineSegment[], targetLine: number): number | null {
  for (const [pc, ln] of segments) {
    if (ln === targetLine) return pc;
  }
  return null;
}

// ---------------------------------------------------------------- values

/** One atom-table entry: (kind, wide, raw bytes) — raw null only for SYMBOL_NO_DESC. */
export type AtomEntry = readonly [kind: number, wide: boolean, raw: Buffer | null];
/** One strings-table entry: (wide, raw bytes). */
export type StringEntry = readonly [wide: boolean, raw: Buffer];

export class AtomTable {
  constructor(readonly atoms: readonly AtomEntry[]) {}

  static decode(wide: boolean, raw: Buffer): string {
    return wide ? raw.toString("utf16le") : raw.toString("utf8");
  }

  resolve(v: number): string | null {
    // Atom ref (leb value) -> string, or null for JS_ATOM_NULL.
    if (v % 2 === 1) return String(Math.floor(v / 2)); // tagged-int atom (array index)
    const raw = Math.floor(v / 2);
    if (raw < FIRST_ATOM) return PREDEFINED_ATOMS[raw];
    const idx = raw - FIRST_ATOM;
    if (idx >= this.atoms.length) {
      throw new ParseError(`atom index ${raw} out of range (${this.atoms.length} file atoms)`);
    }
    const [, wide, rawb] = this.atoms[idx];
    if (rawb === null) return `<symbol#${idx}>`;
    return AtomTable.decode(wide, rawb);
  }

  indexOf(s: string | null): number | null {
    // String -> full atom value (predefined index, or file index +
    // FIRST_ATOM). null -> JS_ATOM_NULL (0).
    if (s === null) return 0;
    for (let i = 0; i < PREDEFINED_ATOMS.length; i++) {
      if (PREDEFINED_ATOMS[i] === s) return i;
    }
    for (let i = 0; i < this.atoms.length; i++) {
      const [, wide, raw] = this.atoms[i];
      if (raw !== null && AtomTable.decode(wide, raw) === s) return i + FIRST_ATOM;
    }
    return null;
  }
}

export type SnapValue =
  | "UNDEFINED" | "NULL" | "FALSE" | "TRUE" | "UNINITIALIZED" | "DEAD"
  | { readonly kind: "INT32"; readonly value: number }
  | { readonly kind: "CATCH_OFFSET"; readonly value: number }
  | { readonly kind: "FLOAT64"; readonly value: number }
  | { readonly kind: "STRING"; readonly index: number }
  | { readonly kind: "SYMBOL"; readonly name: string | null }
  | { readonly kind: "BIG_INT"; readonly bytes: Buffer }
  | { readonly kind: "ref"; readonly refKind: "object" | "module"; readonly index: number | null }
  | { readonly kind: "bytecode"; readonly index: number | null };

export type BcValue =
  | "NULL" | "UNDEFINED" | "BOOL_FALSE" | "BOOL_TRUE"
  | { readonly kind: "INT32"; readonly value: number }
  | { readonly kind: "FLOAT64"; readonly value: number }
  | { readonly kind: "STRING"; readonly value: string; readonly raw: Buffer; readonly wide: boolean }
  | { readonly kind: "SYMBOL"; readonly name: string | null }
  | { readonly kind: "BIG_INT"; readonly bytes: Buffer }
  | { readonly kind: "OBJECT"; readonly props: ReadonlyArray<readonly [string | null, BcValue]> }
  | { readonly kind: "ARRAY"; readonly items: readonly BcValue[] }
  | { readonly kind: "TEMPLATE_OBJECT"; readonly items: readonly BcValue[]; readonly raw: BcValue }
  | { readonly kind: "REGEXP"; readonly pattern: string; readonly flags: number }
  | {
      readonly kind: "MODULE";
      readonly name: string | null;
      readonly reqs: ReadonlyArray<readonly [string | null, BcValue]>;
      readonly exps: readonly unknown[];
      readonly stars: readonly number[];
      readonly imps: readonly unknown[];
      readonly hasTla: number;
      readonly func: BcValue;
    }
  | FuncInfo;

const SNAP_VAL_BARE = new Set(["UNDEFINED", "NULL", "FALSE", "TRUE", "UNINITIALIZED", "DEAD"]);

export function decodeSnapValue(r: Reader, atoms: AtomTable): SnapValue {
  const tag = r.u8();
  if (tag >= SNAP_VAL.length) throw new ParseError(`bad SNAP_VAL tag ${tag}`);
  const name = SNAP_VAL[tag];
  if (SNAP_VAL_BARE.has(name)) return name as SnapValue;
  if (name === "INT32" || name === "CATCH_OFFSET") return { kind: name, value: r.sleb() };
  if (name === "FLOAT64") return { kind: "FLOAT64", value: r.bytes(8).readDoubleLE(0) };
  if (name === "STRING") return { kind: "STRING", index: r.leb() };
  if (name === "SYMBOL") return { kind: "SYMBOL", name: atoms.resolve(r.leb()) };
  if (name === "BIG_INT") {
    const t = r.u8();
    if (t !== 10) throw new ParseError(`bigint without BC_TAG_BIG_INT, got tag ${t}`);
    const ln = r.leb();
    return { kind: "BIG_INT", bytes: r.bytes(ln) };
  }
  if (name === "OBJECT" || name === "MODULE") {
    const v = r.leb();
    return { kind: "ref", refKind: name.toLowerCase() as "object" | "module", index: v === 0 ? null : v - 1 };
  }
  if (name === "BYTECODE") {
    const v = r.leb();
    return { kind: "bytecode", index: v === 0 ? null : v - 1 };
  }
  throw new ParseError(`unhandled SNAP_VAL ${name}`);
}

export function decodeBcValue(r: Reader, atoms: AtomTable, depth = 0): BcValue {
  if (depth > 32) throw new ParseError("bc value nesting too deep");
  const tag = r.u8();
  const name = BC_TAG[tag];
  if (name === undefined) throw new ParseError(`bad BC tag ${tag}`);
  if (name === "NULL" || name === "UNDEFINED" || name === "BOOL_FALSE" || name === "BOOL_TRUE") return name;
  if (name === "INT32") return { kind: "INT32", value: r.sleb() };
  if (name === "FLOAT64") return { kind: "FLOAT64", value: r.bytes(8).readDoubleLE(0) };
  if (name === "STRING") {
    // Carry the raw bytes alongside the decoded text: a string literal
    // can hold arbitrary bytes (the probe's captureTrapSite constant
    // is binary), and the strings table must be matched byte-exact,
    // not via a lossy UTF-8 decode (which corrupts it with U+FFFD).
    const [wide, raw] = r.readStringRaw();
    return { kind: "STRING", value: AtomTable.decode(wide, raw), raw, wide };
  }
  if (name === "FUNCTION_BYTECODE") {
    // parseFuncTag reads the tag itself (as in the snapshot path,
    // where the body starts at the tag) — back up one byte.
    r.p -= 1;
    return parseFuncTag(r, atoms, "bc", depth);
  }
  if (name === "MODULE") {
    r.p -= 1;
    return parseModuleTag(r, atoms, "bc", depth);
  }
  if (name === "SYMBOL") return { kind: "SYMBOL", name: atoms.resolve(r.leb()) };
  if (name === "BIG_INT") {
    const ln = r.leb();
    return { kind: "BIG_INT", bytes: r.bytes(ln) };
  }
  if (name === "OBJECT") {
    const n = r.leb();
    const props: Array<readonly [string | null, BcValue]> = [];
    for (let i = 0; i < n; i++) {
      props.push([atoms.resolve(r.leb()), decodeBcValue(r, atoms, depth + 1)]);
    }
    return { kind: "OBJECT", props };
  }
  if (name === "ARRAY" || name === "TEMPLATE_OBJECT") {
    const n = r.leb();
    const items: BcValue[] = [];
    for (let i = 0; i < n; i++) items.push(decodeBcValue(r, atoms, depth + 1));
    if (name === "TEMPLATE_OBJECT") {
      const raw = decodeBcValue(r, atoms, depth + 1);
      return { kind: "TEMPLATE_OBJECT", items, raw };
    }
    return { kind: "ARRAY", items };
  }
  if (name === "REGEXP") {
    const pat = r.readString();
    const flags = r.leb();
    return { kind: "REGEXP", pattern: pat, flags };
  }
  throw new ParseError(`BC tag ${name} cannot appear in a function constant pool here`);
}

// ---------------------------------------------------------------- function tags

export type Vardef = readonly [name: string | null, scopeNext: number, varRefIdx: number, flags: number];
export type ClosureVar = readonly [name: string | null, varIdx: number, flags: number];

export class FuncInfo {
  tag: number | null = null;
  flags = 0;
  jsMode = 0;
  funcName: string | null = null;
  argCount = 0;
  varCount = 0;
  definedArgCount = 0;
  stackSize = 0;
  varRefCount = 0;
  closureVarCount = 0;
  cpoolCount = 0;
  byteCodeLen = 0;
  vardefs: Vardef[] = [];
  closureVars: ClosureVar[] = [];
  code: Buffer = Buffer.alloc(0);
  hasDebug = false;
  filename: string | null = null;
  pc2lineBuf: Buffer = Buffer.alloc(0);
  defLine: number | null = null;
  defCol: number | null = null;
  segments: Pc2LineSegment[] = [];
  source: Buffer | null = null;
  cpool: Array<SnapValue | BcValue> = [];
  isPy = false;
  realm: number | null = null;

  /** (file, name, definition line) — the converter's match key. */
  get identity(): readonly [string | null, string | null, number | null] {
    return [this.filename, this.funcName, this.defLine];
  }
  get closureNames(): Array<string | null> {
    return this.closureVars.map(([name]) => name);
  }
  lineOfPc(pc: number): [number, number] {
    if (!this.segments.length) throw new ParseError("no pc2line table for pc lookup");
    return pcToLine(this.segments, pc);
  }
  pcOfLine(line: number): number {
    if (!this.segments.length) throw new ParseError("no pc2line table for line lookup");
    const pc = lineToPc(this.segments, line);
    if (pc === null) throw new ParseError(`line ${line} has no pc in pc2line table`);
    return pc;
  }
}

export function identityKey(ident: readonly [string | null, string | null, number | null]): string {
  return JSON.stringify(ident);
}

/** Python-tuple rendering of an identity, for refusal messages. */
export function fmtIdentity(ident: readonly [string | null, string | null, number | null]): string {
  const fmt = (v: string | number | null): string =>
    v === null ? "None" : typeof v === "number" ? String(v) : `'${v}'`;
  return `(${fmt(ident[0])}, ${fmt(ident[1])}, ${fmt(ident[2])})`;
}

function funcFlags(f: FuncInfo): FuncInfo {
  f.hasDebug = Boolean((f.flags >> 10) & 1);
  f.isPy = Boolean((f.flags >> 12) & 1);
  return f;
}

export function parseFuncTag(r: Reader, atoms: AtomTable, mode: "snap" | "bc", depth = 0): FuncInfo {
  const tag = r.u8();
  if (tag !== BC_TAG_FUNCTION_BYTECODE) {
    throw new ParseError(`expected FUNCTION_BYTECODE tag, got ${tag}`);
  }
  const f = new FuncInfo();
  f.tag = tag;
  f.flags = r.u16();
  f.jsMode = r.u8();
  f.funcName = atoms.resolve(r.leb());
  [f.argCount, f.varCount, f.definedArgCount, f.stackSize, f.varRefCount, f.closureVarCount, f.cpoolCount, f.byteCodeLen] = [
    r.leb(), r.leb(), r.leb(), r.leb(), r.leb(), r.leb(), r.leb(), r.leb(),
  ];
  funcFlags(f);
  const nvars = r.leb();
  if (nvars !== f.argCount + f.varCount) {
    throw new ParseError(`vardef count ${nvars} != arg+var ${f.argCount + f.varCount}`);
  }
  for (let i = 0; i < nvars; i++) {
    f.vardefs.push([atoms.resolve(r.leb()), r.leb(), r.leb(), r.u8()]);
  }
  for (let i = 0; i < f.closureVarCount; i++) {
    f.closureVars.push([atoms.resolve(r.leb()), r.leb(), r.u16()]);
  }
  f.code = r.bytes(f.byteCodeLen);
  if (f.hasDebug) {
    f.filename = atoms.resolve(r.leb());
    const ln = r.leb();
    f.pc2lineBuf = r.bytes(ln);
    const sln = r.leb();
    f.source = sln ? r.bytes(sln) : null;
    if (f.pc2lineBuf.length) {
      const { defLine, defCol, segments } = decodePc2line(f.pc2lineBuf);
      f.defLine = defLine;
      f.defCol = defCol;
      f.segments = segments;
    }
  }
  for (let i = 0; i < f.cpoolCount; i++) {
    f.cpool.push(mode === "snap" ? decodeSnapValue(r, atoms) : decodeBcValue(r, atoms, depth + 1));
  }
  return f;
}

export function parseModuleTag(r: Reader, atoms: AtomTable, mode: "snap" | "bc", depth = 0): BcValue {
  const tag = r.u8();
  if (tag !== BC_TAG_MODULE) throw new ParseError(`expected MODULE tag, got ${tag}`);
  const name = atoms.resolve(r.leb());
  const nreq = r.leb();
  const reqs: Array<readonly [string | null, BcValue]> = [];
  for (let i = 0; i < nreq; i++) {
    reqs.push([atoms.resolve(r.leb()), decodeBcValue(r, atoms, depth + 1)]);
  }
  const nexp = r.leb();
  const exps: unknown[] = [];
  for (let i = 0; i < nexp; i++) {
    const t = r.u8();
    if (t === 0) exps.push(["local", r.leb(), atoms.resolve(r.leb())]);
    else exps.push(["req", r.leb(), atoms.resolve(r.leb()), atoms.resolve(r.leb())]);
  }
  const nstar = r.leb();
  const stars: number[] = [];
  for (let i = 0; i < nstar; i++) stars.push(r.leb());
  const nimp = r.leb();
  const imps: unknown[] = [];
  for (let i = 0; i < nimp; i++) {
    imps.push([r.leb(), r.u8(), atoms.resolve(r.leb()), r.leb()]);
  }
  const hasTla = r.u8();
  const func = decodeBcValue(r, atoms, depth + 1);
  return { kind: "MODULE", name, reqs, exps, stars, imps, hasTla, func };
}

export function atomRef(atoms: AtomTable, name: string | null): number {
  // Atom ref encoding: (atom_value<<1), or (uint32<<1)|1 for tagged
  // ints. null encodes as JS_ATOM_NULL (0).
  if (name === null) return 0;
  if (/^(0|[1-9][0-9]*)$/.test(name)) {
    const iv = Number(name);
    if (iv < 2 ** 32) return (iv << 1) | 1;
  }
  const idx = atoms.indexOf(name);
  if (idx === null) throw new ParseError(`atom ${JSON.stringify(name)} not in snapshot atom table`);
  return idx << 1;
}

export function encodeFuncTag(f: FuncInfo, atoms: AtomTable, mode: "snap"): Buffer {
  if (mode !== "snap") throw new ParseError("encodeFuncTag only supports snapshot mode");
  const out: Buffer[] = [];
  out.push(Buffer.from([BC_TAG_FUNCTION_BYTECODE]));
  const flagsBuf = Buffer.alloc(2);
  flagsBuf.writeUInt16LE(f.flags, 0);
  out.push(flagsBuf);
  out.push(Buffer.from([f.jsMode]));
  out.push(lebBytes(atomRef(atoms, f.funcName)));
  for (const v of [f.argCount, f.varCount, f.definedArgCount, f.stackSize, f.varRefCount, f.closureVarCount, f.cpoolCount, f.byteCodeLen]) {
    out.push(lebBytes(v));
  }
  out.push(lebBytes(f.vardefs.length));
  for (const [name, scopeNext, varRefIdx, flags] of f.vardefs) {
    out.push(lebBytes(atomRef(atoms, name)));
    out.push(lebBytes(scopeNext));
    out.push(lebBytes(varRefIdx));
    out.push(Buffer.from([flags]));
  }
  for (const [name, varIdx, flags] of f.closureVars) {
    out.push(lebBytes(atomRef(atoms, name)));
    out.push(lebBytes(varIdx));
    const fb = Buffer.alloc(2);
    fb.writeUInt16LE(flags, 0);
    out.push(fb);
  }
  out.push(f.code);
  if (f.hasDebug) {
    out.push(lebBytes(atomRef(atoms, f.filename)));
    out.push(lebBytes(f.pc2lineBuf.length));
    out.push(f.pc2lineBuf);
    if (f.source) {
      out.push(lebBytes(f.source.length));
      out.push(f.source);
    } else {
      out.push(lebBytes(0));
    }
  }
  for (const v of f.cpool) out.push(encodeSnapValue(v as SnapValue, atoms));
  return Buffer.concat(out);
}

export function encodeSnapValue(v: SnapValue, atoms: AtomTable): Buffer {
  if (typeof v === "string") return Buffer.from([SNAP_VAL.indexOf(v)]);
  switch (v.kind) {
    case "INT32":
    case "CATCH_OFFSET":
      return Buffer.concat([Buffer.from([SNAP_VAL.indexOf(v.kind)]), slebBytes(v.value)]);
    case "FLOAT64": {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(v.value, 0);
      return Buffer.concat([Buffer.from([SNAP_VAL.indexOf("FLOAT64")]), b]);
    }
    case "STRING":
      return Buffer.concat([Buffer.from([SNAP_VAL.indexOf("STRING")]), lebBytes(v.index)]);
    case "SYMBOL":
      return Buffer.concat([Buffer.from([SNAP_VAL.indexOf("SYMBOL")]), lebBytes(atomRef(atoms, v.name))]);
    case "BIG_INT":
      return Buffer.concat([
        Buffer.from([SNAP_VAL.indexOf("BIG_INT"), 10]),
        lebBytes(v.bytes.length),
        v.bytes,
      ]);
    case "ref": {
      const idx = v.index;
      return Buffer.concat([
        Buffer.from([SNAP_VAL.indexOf(v.refKind.toUpperCase() as (typeof SNAP_VAL)[number])]),
        lebBytes(idx === null ? 0 : idx + 1),
      ]);
    }
    case "bytecode": {
      const idx = v.index;
      return Buffer.concat([Buffer.from([SNAP_VAL.indexOf("BYTECODE")]), lebBytes(idx === null ? 0 : idx + 1)]);
    }
  }
}

// ---------------------------------------------------------------- frames

export interface FrameBody {
  isCompleted: number;
  throwFlag: number;
  resolving: [SnapValue, SnapValue];
  bytecode: number | null;
  curFunc: SnapValue | null;
  this: SnapValue | null;
  argc: number | null;
  jsMode: number | null;
  pc: number | null;
  sp: number | null;
  stack: SnapValue[];
  isSuspended: number | null;
  newTarget: SnapValue | null;
  suspendedChild: number | null;
  pendingNative: number | null;
  pendingOpcode: number | null;
  pendingArgc: number | null;
}

export function parseFrameBody(body: Buffer, atoms: AtomTable): FrameBody {
  const r = new Reader(body);
  const fr: FrameBody = {
    isCompleted: r.u8(),
    throwFlag: r.u8(),
    resolving: [decodeSnapValue(r, atoms), decodeSnapValue(r, atoms)],
    bytecode: null, curFunc: null, this: null, argc: null, jsMode: null,
    pc: null, sp: null, stack: [], isSuspended: null, newTarget: null,
    suspendedChild: null, pendingNative: null, pendingOpcode: null, pendingArgc: null,
  };
  if (fr.isCompleted) {
    if (r.p !== body.length) throw new ParseError("completed frame body has trailing bytes");
    return fr;
  }
  const t = r.u8();
  if (t !== 13) throw new ParseError(`frame body: expected BYTECODE tag, got ${t}`);
  const bv = r.leb();
  fr.bytecode = bv === 0 ? null : bv - 1;
  fr.curFunc = decodeSnapValue(r, atoms);
  fr.this = decodeSnapValue(r, atoms);
  fr.argc = r.leb();
  fr.jsMode = r.leb();
  fr.pc = r.leb();
  fr.sp = r.leb();
  fr.stack = [];
  for (let i = 0; i < (fr.sp ?? 0); i++) fr.stack.push(decodeSnapValue(r, atoms));
  fr.isSuspended = r.u8();
  fr.newTarget = decodeSnapValue(r, atoms);
  const sc = r.leb();
  fr.suspendedChild = sc === 0 ? null : sc - 1;
  fr.pendingNative = r.u8();
  fr.pendingOpcode = r.u8();
  fr.pendingArgc = r.leb();
  if (r.p !== body.length) throw new ParseError("frame body has trailing bytes");
  return fr;
}

export function encodeFrameBody(fr: FrameBody, atoms: AtomTable): Buffer {
  const out: Buffer[] = [];
  out.push(Buffer.from([fr.isCompleted, fr.throwFlag]));
  for (const v of fr.resolving) out.push(encodeSnapValue(v, atoms));
  if (fr.isCompleted) return Buffer.concat(out);
  out.push(Buffer.from([SNAP_VAL.indexOf("BYTECODE")]));
  out.push(lebBytes(fr.bytecode === null ? 0 : fr.bytecode + 1));
  out.push(encodeSnapValue(fr.curFunc as SnapValue, atoms));
  out.push(encodeSnapValue(fr.this as SnapValue, atoms));
  out.push(lebBytes(fr.argc ?? 0));
  out.push(lebBytes(fr.jsMode ?? 0));
  out.push(lebBytes(fr.pc ?? 0));
  out.push(lebBytes(fr.sp ?? 0));
  for (const v of fr.stack) out.push(encodeSnapValue(v, atoms));
  out.push(Buffer.from([fr.isSuspended ?? 0]));
  out.push(encodeSnapValue(fr.newTarget as SnapValue, atoms));
  out.push(lebBytes(fr.suspendedChild === null ? 0 : fr.suspendedChild + 1));
  out.push(Buffer.from([fr.pendingNative ?? 0, fr.pendingOpcode ?? 0]));
  out.push(lebBytes(fr.pendingArgc ?? 0));
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- snapshot

export interface CellHeader {
  [key: string]: number;
}

export class Snapshot {
  version = 11;
  kind = 0;
  snapId = 0n;
  sig = 0;
  classCount = 0;
  classTable: Array<readonly [reg: number, name: Buffer | null]> = [];
  cells: Array<readonly [type: CellType, fields: CellHeader]> = [];
  atoms: AtomEntry[] = [];
  strings: StringEntry[] = [];
  roots: Buffer = Buffer.alloc(0);
  bodies: Buffer[] = [];
  path: string | null = null;

  get atomsObj(): AtomTable {
    return new AtomTable(this.atoms);
  }
  bytecodeCells(): Array<readonly [idx: number, fields: CellHeader, body: Buffer]> {
    const out: Array<readonly [number, CellHeader, Buffer]> = [];
    this.cells.forEach(([t, f], i) => {
      if (t === "bytecode") out.push([i, f, this.bodies[i]]);
    });
    return out;
  }
  frameCells(): Array<readonly [idx: number, fields: CellHeader, body: Buffer]> {
    const out: Array<readonly [number, CellHeader, Buffer]> = [];
    this.cells.forEach(([t, f], i) => {
      if (t === "frame") out.push([i, f, this.bodies[i]]);
    });
    return out;
  }
  funcInfo(idx: number): FuncInfo {
    const [t] = this.cells[idx];
    if (t !== "bytecode") throw new ParseError(`cell ${idx} is ${t}, not bytecode`);
    const r = new Reader(this.bodies[idx]);
    const info = parseFuncTag(r, this.atomsObj, "snap");
    const realm = r.leb();
    info.realm = realm === 0 ? null : realm - 1;
    if (r.p !== this.bodies[idx].length) {
      throw new ParseError(`bytecode cell ${idx}: trailing bytes after realm ref`);
    }
    return info;
  }
}

export function parseSnapshotFile(filePath: string): Snapshot {
  return parseSnapshotBytes(fs.readFileSync(filePath), filePath);
}

export function parseSnapshotBytes(data: Buffer, filePath: string | null = null): Snapshot {
  const r = new Reader(data);
  const snap = new Snapshot();
  snap.path = filePath;
  if (!r.bytes(8).equals(Buffer.from(SNAPSHOT_MAGIC, "latin1"))) throw new ParseError("bad magic");
  snap.version = r.leb();
  if (snap.version !== 11) throw new ParseError(`unsupported snapshot version ${snap.version}`);
  snap.kind = r.u8();
  if (snap.kind !== 0) {
    throw new ParseError(`not a full snapshot (kind=${snap.kind}); convert a keyframe, or materialize the delta first`);
  }
  snap.snapId = r.u64();
  snap.sig = r.u32();
  snap.classCount = r.leb();
  for (let i = 105; i < snap.classCount; i++) {
    const reg = r.u8();
    if (reg) {
      const n = r.leb();
      snap.classTable.push([reg, r.bytes(n)]);
    } else {
      snap.classTable.push([reg, null]);
    }
  }
  const nCells = r.leb();
  for (let i = 0; i < nCells; i++) {
    const t = r.u8();
    if (t >= CELL_TYPES.length) throw new ParseError(`invalid cell type ${t}`);
    const f: CellHeader = {};
    if (t === 1) {
      f["class_id"] = r.leb();
    } else if (t === 3) {
      for (const k of ["arg_buf_len", "var_count", "stack_size", "var_ref_count"]) f[k] = r.leb();
    } else if (t === 5) {
      f["has_debug"] = r.u8();
      for (const k of ["arg_count", "var_count", "stack_size", "var_ref_count", "closure_var_count", "cpool_count", "local_count", "byte_code_len"]) {
        f[k] = r.leb();
      }
    }
    snap.cells.push([CELL_TYPES[t], f]);
  }
  const nAtoms = r.leb();
  for (let i = 0; i < nAtoms; i++) {
    const k = r.u8();
    if (k !== SYMBOL_NO_DESC) {
      const [wide, raw] = r.readStringRaw();
      snap.atoms.push([k, wide, raw]);
    } else {
      snap.atoms.push([k, false, null]);
    }
  }
  const nStrs = r.leb();
  for (let i = 0; i < nStrs; i++) snap.strings.push(r.readStringRaw());
  const rootsLen = r.leb();
  snap.roots = r.bytes(rootsLen);
  const nBodies = r.leb();
  if (nBodies !== nCells) throw new ParseError(`body count ${nBodies} != cell count ${nCells}`);
  for (let i = 0; i < nBodies; i++) {
    const ln = r.leb();
    snap.bodies.push(r.bytes(ln));
  }
  if (r.p !== data.length) throw new ParseError(`trailing data: pos ${r.p} != size ${data.length}`);
  return snap;
}

export function emitSnapshot(snap: Snapshot): Buffer {
  const out: Buffer[] = [];
  out.push(Buffer.from(SNAPSHOT_MAGIC, "latin1"));
  out.push(lebBytes(snap.version));
  out.push(Buffer.from([snap.kind]));
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(snap.snapId, 0);
  out.push(idBuf);
  const sigBuf = Buffer.alloc(4);
  sigBuf.writeUInt32LE(snap.sig >>> 0, 0);
  out.push(sigBuf);
  out.push(lebBytes(snap.classCount));
  for (const [reg, name] of snap.classTable) {
    out.push(Buffer.from([reg]));
    if (reg && name) {
      out.push(lebBytes(name.length));
      out.push(name);
    }
  }
  out.push(lebBytes(snap.cells.length));
  for (const [t, f] of snap.cells) {
    out.push(Buffer.from([CELL_TYPES.indexOf(t)]));
    if (t === "object") out.push(lebBytes(f["class_id"]));
    else if (t === "frame") {
      for (const k of ["arg_buf_len", "var_count", "stack_size", "var_ref_count"]) out.push(lebBytes(f[k]));
    } else if (t === "bytecode") {
      out.push(Buffer.from([f["has_debug"]]));
      for (const k of ["arg_count", "var_count", "stack_size", "var_ref_count", "closure_var_count", "cpool_count", "local_count", "byte_code_len"]) {
        out.push(lebBytes(f[k]));
      }
    }
  }
  out.push(lebBytes(snap.atoms.length));
  for (const [k, wide, raw] of snap.atoms) {
    out.push(Buffer.from([k]));
    if (k !== SYMBOL_NO_DESC && raw) {
      out.push(lebBytes(((raw.length / (wide ? 2 : 1)) << 1) | (wide ? 1 : 0)));
      out.push(raw);
    }
  }
  out.push(lebBytes(snap.strings.length));
  for (const [wide, raw] of snap.strings) {
    out.push(lebBytes(((raw.length / (wide ? 2 : 1)) << 1) | (wide ? 1 : 0)));
    out.push(raw);
  }
  out.push(lebBytes(snap.roots.length));
  out.push(snap.roots);
  out.push(lebBytes(snap.bodies.length));
  for (const b of snap.bodies) {
    out.push(lebBytes(b.length));
    out.push(b);
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- bc output (JS_WriteObject2, from the compile helper)
//
// Layout (quickjs.c, JS_WriteObjectAtoms + JS_WriteObject2):
//   u8  BC_VERSION, u32 checksum (over everything after the 5-byte header),
//   leb atom_count, atoms[], value bytes.
// Each atom: u8 kind; kind 0 (BC_ATOM_WELL_KNOWN_SYMBOL) is followed by a
// leb predefined-atom index, kinds 1..4 (STRING/GLOBAL_SYMBOL/SYMBOL/
// PRIVATE) by a JS string. Atom refs in the body use the same encoding
// as the snapshot (leb((idx + FIRST_ATOM) << 1), odd = tagged int),
// so the shared AtomTable resolves them.
const BC_ATOM_WELL_KNOWN_SYMBOL = 0;

export function collectFuncs(f: FuncInfo): FuncInfo[] {
  const out: FuncInfo[] = [f];
  for (const v of f.cpool) {
    if (v instanceof FuncInfo) out.push(...collectFuncs(v));
  }
  return out;
}

// ---------------------------------------------------------------- code atoms
//
// Bytecode carries atoms as u32 RUNTIME indexes (predefined 0..261,
// file atoms at 262 + file index) inside instructions whose format is
// one of atom / atom_u8 / atom_u16 / atom_label_u8 / atom_label_u16
// (quickjs.c: the atom is a u32 at the operand position; the operand
// starts at pos+1, after any u8/u16 prefix). The atom table a fresh
// compile produces (the .bc file's) is ordered differently from the
// target snapshot's, so transplanting code bytes verbatim points the
// operands at the wrong names (the probe resumed with result keys
// 'sliceToImmutable'/'transferToFixedLength' instead of
// 'verdict'/'total'). The remapper walks the code with the NEW
// engine's opcode table and rewrites each atom operand to the target
// snapshot's index for the same name.
const ATOM_FMTS: Readonly<Record<string, number>> = {
  // The atom is ALWAYS a u32 immediately after the opcode byte
  // (dump code: print_atom(get_u32(tab + pos)) with pos = opnd =
  // instruction start + 1, for every atom fmt). The _u8/_u16/_label
  // suffixes describe the operands AFTER the atom.
  atom: 1,
  atom_u8: 1,
  atom_u16: 1,
  atom_label_u8: 1,
  atom_label_u16: 1,
};

export interface OpcodeDef {
  name: string;
  size: number;
  fmt: string;
}

export function parseOpcodeTable(opcodeTablePath: string): OpcodeDef[] {
  const table: OpcodeDef[] = [];
  const re = /^\s*DEF\(\s*([A-Za-z0-9_]+)\s*,\s*(\d+)\s*,\s*\d+\s*,\s*\d+\s*,\s*([A-Za-z0-9_]+)\s*\)/;
  for (const line of fs.readFileSync(opcodeTablePath, "utf8").split("\n")) {
    const m = re.exec(line);
    if (m) table.push({ name: m[1], size: Number(m[2]), fmt: m[3] });
  }
  if (!table.length) throw new ParseError(`no DEF lines in opcode table ${opcodeTablePath}`);
  return table;
}

function decodeAtomEntry(entry: AtomEntry): string | null {
  const [, wide, raw] = entry;
  if (raw === null) return null;
  return AtomTable.decode(wide, raw);
}

export function resolveCodeAtom(a: number, atomList: readonly AtomEntry[]): string | null {
  if (a === 0) return null;
  if (a < FIRST_ATOM) return PREDEFINED_ATOMS[a];
  const idx = a - FIRST_ATOM;
  if (idx >= atomList.length) {
    throw new ParseError(`code atom index ${a} out of range (${atomList.length} file atoms)`);
  }
  return decodeAtomEntry(atomList[idx]);
}

export function targetCodeAtom(name: string | null, atomList: AtomEntry[]): number {
  if (name === null) return 0;
  for (let i = 0; i < PREDEFINED_ATOMS.length; i++) {
    if (PREDEFINED_ATOMS[i] === name) return i;
  }
  for (let i = 0; i < atomList.length; i++) {
    if (decodeAtomEntry(atomList[i]) === name) return i + FIRST_ATOM;
  }
  atomList.push([1, false, Buffer.from(name, "utf8")]);
  return atomList.length - 1 + FIRST_ATOM;
}

export function remapCodeAtoms(code: Buffer, opcodes: readonly OpcodeDef[], srcAtoms: readonly AtomEntry[], dstAtoms: AtomEntry[]): Buffer {
  const out = Buffer.from(code);
  let pos = 0;
  while (pos < code.length) {
    const op = code[pos];
    if (op >= opcodes.length) throw new ParseError(`unknown opcode ${op} at code offset ${pos}`);
    const { name, size, fmt } = opcodes[op];
    if (pos + size > code.length) throw new ParseError(`truncated opcode ${name} at code offset ${pos}`);
    if (fmt in ATOM_FMTS) {
      const off = pos + ATOM_FMTS[fmt];
      const a = code.readUInt32LE(off);
      const target = targetCodeAtom(resolveCodeAtom(a, srcAtoms), dstAtoms);
      out.writeUInt32LE(target, off);
    }
    pos += size;
  }
  if (pos !== code.length) throw new ParseError(`opcode walk ended at ${pos}, code is ${code.length} bytes`);
  return out;
}

export interface BcFile {
  bcVersion: number;
  top: FuncInfo;
  atoms: AtomEntry[];
}

export function parseBcFile(bcPath: string): BcFile {
  const data = fs.readFileSync(bcPath);
  const r = new Reader(data);
  const bcVersion = r.u8();
  r.u32(); // checksum (over everything after the 5-byte header)
  const nAtoms = r.leb();
  const atoms: Array<[number, boolean, Buffer | null, string | null]> = [];
  for (let i = 0; i < nAtoms; i++) {
    const k = r.u8();
    if (k === BC_ATOM_WELL_KNOWN_SYMBOL) {
      const idx = r.leb();
      atoms.push([k, false, null, PREDEFINED_ATOMS[idx] ?? null]);
    } else {
      const [wide, raw] = r.readStringRaw();
      atoms.push([k, wide, raw, null]);
    }
  }
  // AtomTable expects (kind, wide, raw) triples; well-known symbols
  // carry their resolved name in slot 3 instead.
  const tableAtoms: AtomEntry[] = [];
  for (const [k, wide, raw, name] of atoms) {
    if (name !== null) tableAtoms.push([k, false, Buffer.from(name, "utf8")]);
    else tableAtoms.push([k, wide, raw]);
  }
  const table = new AtomTable(tableAtoms);
  const top = decodeBcValue(r, table);
  if (r.p !== data.length) throw new ParseError(`bc file ${bcPath}: trailing data: pos ${r.p} != size ${data.length}`);
  if (!(top instanceof FuncInfo)) throw new ParseError(`bc file ${bcPath}: top value is not a function`);
  return { bcVersion, top, atoms: tableAtoms };
}

export function snapHash64(buf: Buffer): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of buf) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

export function recomputeId(outBytesWithNullId: Buffer): bigint {
  return snapHash64(outBytesWithNullId) | 1n;
}

// ---------------------------------------------------------------- cpool + pc remap

export class StringTable {
  readonly strings: StringEntry[];
  constructor(strings: StringEntry[]) {
    this.strings = strings;
  }
  indexOfRaw(wide: boolean, raw: Buffer): number {
    // Byte-exact: a .bc string literal can hold arbitrary bytes, so
    // the match is on (wide, raw bytes), never on lossy-decoded text.
    // Two entries with the same text in different encodings are
    // distinct here — that only ever appends a harmless duplicate.
    for (let i = 0; i < this.strings.length; i++) {
      const [w, r] = this.strings[i];
      if (w === wide && r.equals(raw)) return i;
    }
    this.strings.push([wide, raw]);
    return this.strings.length - 1;
  }
}

export function collectAtomStrings(v: BcValue | FuncInfo, out: Set<string>): void {
  if (v instanceof FuncInfo) {
    for (const s of [v.funcName, v.filename]) if (s !== null) out.add(s);
    for (const [name] of v.vardefs) if (name !== null) out.add(name);
    for (const [name] of v.closureVars) if (name !== null) out.add(name);
    for (const c of v.cpool) collectAtomStrings(c as BcValue, out);
    return;
  }
  if (typeof v !== "object" || v === null) return;
  if (v.kind === "SYMBOL" && typeof v.name === "string") out.add(v.name);
  else if (v.kind === "OBJECT") {
    for (const [k, x] of v.props) {
      if (typeof k === "string") out.add(k);
      collectAtomStrings(x, out);
    }
  } else if (v.kind === "ARRAY") {
    for (const x of v.items) collectAtomStrings(x, out);
  } else if (v.kind === "TEMPLATE_OBJECT") {
    for (const x of v.items) collectAtomStrings(x, out);
    collectAtomStrings(v.raw, out);
  }
}

export function transformCpool(
  v: BcValue,
  funcToCell: Map<string, number>,
  atoms: AtomTable,
  strings: StringTable,
): SnapValue | BcValue {
  // Rewrite a bc-parsed cpool value into snapshot form: FuncInfo ->
  // ('bytecode', target cell index); STRING str -> STRING strings-table
  // index; SYMBOL str stays a symbol (atom ref, handled by
  // encodeSnapValue). Inline OBJECT/ARRAY/TEMPLATE_OBJECT values
  // cannot appear in a snapshot cpool (snap_put_value writes those as
  // cell refs) — refuse loudly instead of inventing a cell.
  if (v instanceof FuncInfo) {
    const idx = funcToCell.get(identityKey(v.identity));
    if (idx === undefined) {
      throw new ConvertRefusalError(`nested function ${fmtIdentity(v.identity)} has no target cell`);
    }
    return { kind: "bytecode", index: idx };
  }
  if (typeof v === "object" && v !== null) {
    if (v.kind === "STRING" && typeof v.value === "string") {
      return { kind: "STRING", index: strings.indexOfRaw(v.wide, v.raw) };
    }
    if (
      v.kind === "OBJECT" || v.kind === "ARRAY" || v.kind === "TEMPLATE_OBJECT" ||
      v.kind === "REGEXP"
    ) {
      throw new ConvertRefusalError(
        `inline ${v.kind} value in a function constant pool cannot be represented as a snapshot cpool value (it needs an object cell) — refusing`,
      );
    }
    return v;
  }
  return v;
}

export function remapPc(oldFunc: FuncInfo, newFunc: FuncInfo, oldPc: number): number {
  // Old pc -> new pc at the same source position, preserving the
  // offset within the instruction: a suspended frame's pc is often
  // mid-instruction (e.g. the return address 1 byte into a call), so
  // mapping to the segment start alone would re-execute the call.
  // Exact (line, col) first; else the last new segment on the same
  // line at-or-before the old column; else refuse.
  if (oldPc < 0 || oldPc > oldFunc.byteCodeLen) {
    throw new ConvertRefusalError(
      `cannot remap pc ${oldPc} in ${fmtIdentity(oldFunc.identity)}: outside the code (0..${oldFunc.byteCodeLen}) — the frame's pc points at no instruction, refusing`,
    );
  }
  const segs = oldFunc.segments;
  let segPc = segs[0][0];
  let line = segs[0][1];
  let col = segs[0][2];
  for (const [pc, ln, cl] of segs.slice(1)) {
    if (oldPc < pc) break;
    segPc = pc;
    line = ln;
    col = cl;
  }
  const offset = oldPc - segPc;
  const nsegs = newFunc.segments;
  for (const [pc, ln, cl] of nsegs) {
    if (ln === line && cl === col) {
      const newPc = pc + offset;
      if (newPc > newFunc.byteCodeLen) {
        throw new ConvertRefusalError(
          `remapped pc ${newPc} in ${fmtIdentity(newFunc.identity)} is past the new code (${newFunc.byteCodeLen} bytes) — refusing`,
        );
      }
      return newPc;
    }
  }
  const sameLine = nsegs.filter(([, ln, cl]) => ln === line && cl <= col);
  if (sameLine.length) {
    const newPc = sameLine[sameLine.length - 1][0] + offset;
    if (newPc > newFunc.byteCodeLen) {
      throw new ConvertRefusalError(
        `remapped pc ${newPc} in ${fmtIdentity(newFunc.identity)} is past the new code (${newFunc.byteCodeLen} bytes) — refusing`,
      );
    }
    return newPc;
  }
  throw new ConvertRefusalError(
    `cannot remap pc ${oldPc} (line ${line}, col ${col}) in ${fmtIdentity(oldFunc.identity)}: new function has no segment on line ${line}`,
  );
}

// ---------------------------------------------------------------- engine + helper

/** Repo path of the compile helper source (shipped in the repo). */
export function compileHelperSourcePath(): string {
  return path.resolve(import.meta.dir, "..", "..", "..", "packages", "durablets", "compile-helper.c");
}

/** Repo path of durablets.c (default for the new-engine version/identity). */
export function defaultDurabletsCPath(): string {
  return path.resolve(import.meta.dir, "..", "..", "..", "packages", "durablets", "src", "durablets.c");
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Build the compile helper against the target engine tree. */
export function buildCompileHelper(dquicktsDir: string, workDir: string): string {
  const helperSrc = compileHelperSourcePath();
  const opcodeTable = path.join(dquicktsDir, "quickjs-opcode.h");
  const lib = path.join(dquicktsDir, "libquickjs.a");
  const header = path.join(dquicktsDir, "quickjs.h");
  for (const [p, what] of [
    [helperSrc, "compile helper source"],
    [opcodeTable, "target opcode table"],
    [lib, "target libquickjs.a"],
    [header, "target quickjs.h"],
  ] as const) {
    if (!fs.existsSync(p)) {
      throw new Error(`cannot build the compile helper: ${what} not found at ${p}`);
    }
  }
  fs.mkdirSync(workDir, { recursive: true });
  const out = path.join(workDir, "compile-helper");
  const r = spawnSync(
    "cc",
    ["-g", "-O2", `-I${dquicktsDir}`, helperSrc, lib, "-lm", "-lpthread", "-ldl", "-o", out],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`cannot build the compile helper against ${dquicktsDir}: ${r.stderr?.trim() ?? `cc exited ${r.status}`}`);
  }
  return out;
}

/** The dquickts upstream pin (first 12 hex) from a tree's VENDORED_FROM stamp. */
export function readTargetPin(dquicktsDir: string): string {
  const stampPath = path.join(dquicktsDir, "VENDORED_FROM");
  try {
    const stamp = fs.readFileSync(stampPath, "utf8");
    const m = stamp.match(/Pinned commit:\s*([0-9a-f]{7,40})/);
    if (m) return m[1].slice(0, 12);
  } catch {
    /* fall through */
  }
  throw new Error(`cannot read the dquickts pin: ${stampPath} is missing or has no "Pinned commit:" line`);
}

export interface TargetEngine {
  pin: string;
  durabletsHash: string;
  version: string;
  natives: string[];
  formatIdentity: string;
}

/** Compute the new engine version + format identity from the target
 * tree and durablets.c — the same recipe the host uses for its own
 * engineVersion(), scoped to the target instead of the current tree. */
export function computeTargetEngine(dquicktsDir: string, durabletsCPath: string, newSignature: number): TargetEngine {
  const pin = readTargetPin(dquicktsDir);
  if (!fs.existsSync(durabletsCPath)) {
    throw new Error(`cannot compute the target engine version: durablets.c not found at ${durabletsCPath}`);
  }
  const source = fs.readFileSync(durabletsCPath, "utf8");
  const durabletsHash = sha256Hex(Buffer.from(source, "utf8")).slice(0, 16);
  const natives = parseHostNativeNames(source);
  const version = `dquickts-${pin}+durablets-${durabletsHash}`;
  return { pin, durabletsHash, version, natives, formatIdentity: formatIdentityFor(newSignature, pin, natives) };
}

// ---------------------------------------------------------------- byte conversion

export interface ByteConvertOptions {
  oldBytes: Buffer;
  newSigBytes: Buffer;
  helperPath: string;
  opcodeTablePath: string;
  stateDir?: string;
  workDir: string;
  onProgress?: (line: string) => void;
}

export interface ByteConvertResult {
  bytes: Buffer;
  newSignature: number;
  atomsAppended: number;
  convertedCells: number;
  framesRemapped: number;
}

function classTablesEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.classTable.length !== b.classTable.length) return false;
  for (let i = 0; i < a.classTable.length; i++) {
    const [ra, na] = a.classTable[i];
    const [rb, nb] = b.classTable[i];
    if (ra !== rb) return false;
    if (na === null || nb === null) {
      if (na !== nb) return false;
    } else if (!na.equals(nb)) return false;
  }
  return true;
}

function resolveSource(recorded: string | null, stateDir?: string): string {
  if (recorded === null) {
    throw new ConvertRefusalError(
      "a function has no recorded source file (no debug info) — cannot recompile, refusing",
    );
  }
  if (stateDir) {
    const cand = path.join(stateDir, "slices", path.basename(recorded));
    if (fs.existsSync(cand)) return cand;
  }
  if (fs.existsSync(recorded)) return recorded;
  throw new ConvertRefusalError(
    `source file for '${recorded}' not found (tried state-dir slices/ and the recorded path)`,
  );
}

export function convertSnapshotBytes(opts: ByteConvertOptions): ByteConvertResult {
  const progress = opts.onProgress ?? (() => {});
  const old = parseSnapshotBytes(opts.oldBytes);
  const newsig = parseSnapshotBytes(opts.newSigBytes);
  if (!classTablesEqual(newsig, old)) {
    throw new ConvertRefusalError(
      "class table differs between old and new engine snapshots — engines differ structurally, refusing",
    );
  }
  if (newsig.version !== old.version) {
    throw new ConvertRefusalError(
      `snapshot format version differs: old ${old.version}, new ${newsig.version}`,
    );
  }

  // --- gather old bytecode identities
  const oldFuncs = new Map<string, { idx: number; info: FuncInfo }>();
  for (const [idx] of old.bytecodeCells()) {
    const info = old.funcInfo(idx);
    const key = identityKey(info.identity);
    if (oldFuncs.has(key)) {
      throw new ConvertRefusalError(
        `ambiguous old identity ${fmtIdentity(info.identity)} (cells ${oldFuncs.get(key)!.idx} and ${idx})`,
      );
    }
    oldFuncs.set(key, { idx, info });
  }

  // --- recompile each distinct source file with the new engine
  const opcodes = parseOpcodeTable(opts.opcodeTablePath);
  const files = [...new Set([...oldFuncs.values()].map(({ info }) => info.filename))].sort((a, b) =>
    (a ?? "").localeCompare(b ?? ""),
  );
  const newFuncs = new Map<string, FuncInfo>();
  const newBcAtoms = new Map<string, AtomEntry[]>();
  let expectedBcVersion: number | null = null;
  fs.mkdirSync(opts.workDir, { recursive: true });
  for (const recorded of files) {
    const src = resolveSource(recorded, opts.stateDir);
    const bcPath = path.join(opts.workDir, `bra134-${process.pid}-${path.basename(recorded ?? "bundle")}.bc`);
    let r = spawnSync(opts.helperPath, [src, recorded ?? "", bcPath], { encoding: "utf8" });
    if (r.status !== 0) {
      // A compile failure can mask a drift: the file on disk may differ
      // from what the snapshot recorded, and the match+verify loop below
      // would refuse on the excerpt — but it never runs if the recompile
      // throws first. A recorded excerpt that no longer appears in the
      // file is proof of drift (the excerpt check is a substring test,
      // so it cannot fire on an unmodified file), and the drift refusal
      // is the correct verdict even when the file no longer compiles
      // (e.g. an engine parser quirk rejecting valid JS at an exact
      // byte offset). If every recorded excerpt is still present, the
      // compile failure is genuine — keep it.
      const current = fs.readFileSync(src);
      const drifted = [...oldFuncs.values()].find(
        ({ info }) => info.filename === recorded && info.source !== null && !current.includes(info.source),
      );
      if (drifted) {
        throw new ConvertRefusalError(
          `source excerpt differs for ${fmtIdentity(drifted.info.identity)} (old ${drifted.info.source!.length}B, new unknown: compile helper failed)`,
        );
      }
      // Padded retry: the engine parser quirk rejects valid JS when a
      // construct lands at an exact absolute byte offset. A no-newline
      // block comment prepended to the source shifts every construct's
      // offset by k without changing any line number, any recorded
      // excerpt (each starts at a `function` keyword), or any bytecode
      // (comments generate none — verified on the probe bundle: a padded
      // compile yields byte-identical code, excerpts, and atom tables).
      // The debug filename stays `recorded`, so identities are
      // unaffected; the match+verify loop below still checks
      // excerpts/closures/vardefs/counts. Retry with escalating k (the
      // bad offsets are sparse exact positions); a genuinely broken
      // file fails at every k and keeps the compile error.
      const padBase = "/*bra134*/";
      let retried = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const pad = attempt === 0 ? padBase : `${padBase.slice(0, -2)}${"x".repeat(attempt)}*/`;
        const paddedPath = path.join(
          opts.workDir,
          `bra134-${process.pid}-${path.basename(recorded ?? "bundle")}.padded-${attempt}.js`,
        );
        fs.writeFileSync(paddedPath, pad + fs.readFileSync(src, "utf8"));
        progress(`recompile retry for ${recorded}: ${pad.length}B padding (attempt ${attempt + 1}/3)`);
        r = spawnSync(opts.helperPath, [paddedPath, recorded ?? "", bcPath], { encoding: "utf8" });
        retried = r.status === 0;
        try {
          fs.unlinkSync(paddedPath);
        } catch {
          /* best-effort cleanup */
        }
        if (retried) break;
      }
      if (!retried) {
        throw new ConvertRefusalError(`compile helper failed for ${recorded}: ${(r.stderr ?? "").trim()}`);
      }
    }
    const { bcVersion, top, atoms } = parseBcFile(bcPath);
    if (expectedBcVersion === null) expectedBcVersion = bcVersion;
    if (bcVersion !== expectedBcVersion) {
      throw new ConvertRefusalError(
        `helper produced bc version ${bcVersion}, expected ${expectedBcVersion} for ${recorded}`,
      );
    }
    try {
      fs.unlinkSync(bcPath);
    } catch {
      /* best-effort cleanup */
    }
    for (const f of collectFuncs(top)) {
      const key = identityKey(f.identity);
      if (newFuncs.has(key)) {
        throw new ConvertRefusalError(
          `ambiguous new identity ${fmtIdentity(f.identity)} from ${recorded} (two functions share file, name and definition line — cannot match)`,
        );
      }
      newFuncs.set(key, f);
      newBcAtoms.set(key, atoms);
    }
  }

  // --- match + verify every pair (exact set equality, both directions)
  const missing = [...oldFuncs.keys()].filter((k) => !newFuncs.has(k));
  const extra = [...newFuncs.keys()].filter((k) => !oldFuncs.has(k));
  if (missing.length) {
    throw new ConvertRefusalError(
      `new engine produced no function for old identities: [${missing.map((k) => fmtIdentity(JSON.parse(k))).join(", ")}]`,
    );
  }
  if (extra.length) {
    throw new ConvertRefusalError(
      `new engine produced extra functions with no old cell: [${extra.map((k) => fmtIdentity(JSON.parse(k))).join(", ")}]`,
    );
  }
  for (const [key, { info: oldF }] of oldFuncs) {
    const newF = newFuncs.get(key)!;
    if (oldF.source !== null && (newF.source === null || !newF.source.equals(oldF.source))) {
      throw new ConvertRefusalError(
        `source excerpt differs for ${fmtIdentity(oldF.identity)} (old ${oldF.source.length}B, new ${newF.source ? newF.source.length : 0}B)`,
      );
    }
    if (oldF.source === null && newF.source !== null) {
      throw new ConvertRefusalError(`old ${fmtIdentity(oldF.identity)} has no source but new compile does`);
    }
    if (JSON.stringify(oldF.closureNames) !== JSON.stringify(newF.closureNames)) {
      throw new ConvertRefusalError(
        `closure layout differs for ${fmtIdentity(oldF.identity)}: old ${JSON.stringify(oldF.closureNames)}, new ${JSON.stringify(newF.closureNames)}`,
      );
    }
    const oldVars = oldF.vardefs.map(([n]) => n);
    const newVars = newF.vardefs.map(([n]) => n);
    if (JSON.stringify(oldVars) !== JSON.stringify(newVars)) {
      throw new ConvertRefusalError(
        `local var layout differs for ${fmtIdentity(oldF.identity)}: old ${JSON.stringify(oldVars)}, new ${JSON.stringify(newVars)}`,
      );
    }
    if (oldF.argCount !== newF.argCount || oldF.varCount !== newF.varCount) {
      throw new ConvertRefusalError(`arg/var counts differ for ${fmtIdentity(oldF.identity)}`);
    }
  }

  // --- intern atoms the new bodies need (target table is append-only)
  const need = new Set<string>();
  for (const newF of newFuncs.values()) collectAtomStrings(newF, need);
  let atoms = old.atomsObj;
  let appended = 0;
  for (const s of [...need].sort()) {
    if (atoms.indexOf(s) === null) {
      old.atoms.push([1, false, Buffer.from(s, "utf8")]);
      appended += 1;
    }
  }
  atoms = old.atomsObj; // rebuild over the extended table
  progress(`atoms: ${old.atoms.length - appended} existing + ${appended} appended`);

  const funcToCell = new Map<string, number>();
  for (const [key, { idx }] of oldFuncs) funcToCell.set(key, idx);

  // --- remap code atom operands from each .bc table to the target
  // snapshot's table (the tables are ordered differently; verbatim
  // code bytes point the operands at the wrong names)
  for (const [key, newF] of newFuncs) {
    newF.code = remapCodeAtoms(newF.code, opcodes, newBcAtoms.get(key)!, old.atoms);
  }
  atoms = old.atomsObj; // rebuild over the extended table
  progress(`atoms after code remap: ${old.atoms.length}`);

  // --- substitute bytecode bodies + update cell headers
  const strings = new StringTable(old.strings);
  let converted = 0;
  for (const [key, { idx, info: oldF }] of oldFuncs) {
    const newF = newFuncs.get(key)!;
    const cpool = newF.cpool.map((v) => transformCpool(v as BcValue, funcToCell, atoms, strings));
    const g = newF;
    g.cpool = cpool as Array<SnapValue | BcValue>;
    let body = encodeFuncTag(g, atoms, "snap");
    // The realm ref comes from the OLD function: the .bc parse never
    // sets it (realm is read by Snapshot.funcInfo after the tag), so
    // the new function's realm is always null — writing leb(0) here
    // would strip the realm and the resumed code segfaults resolving
    // globals. The old realm (0 for every probe function) is the
    // snapshot's realm and survives the conversion unchanged.
    body = Buffer.concat([body, lebBytes(oldF.realm === null ? 0 : oldF.realm + 1)]);
    old.bodies[idx] = body;
    const hdr = old.cells[idx][1];
    hdr["has_debug"] = newF.hasDebug ? 1 : 0;
    hdr["arg_count"] = newF.argCount;
    hdr["var_count"] = newF.varCount;
    hdr["stack_size"] = newF.stackSize;
    hdr["var_ref_count"] = newF.varRefCount;
    hdr["closure_var_count"] = newF.closureVarCount;
    hdr["cpool_count"] = newF.cpoolCount;
    hdr["local_count"] = newF.vardefs.length;
    hdr["byte_code_len"] = newF.byteCodeLen;
    converted += 1;
  }
  progress(`bytecode cells converted: ${converted}`);

  // --- remap suspended frame pcs
  let remapped = 0;
  for (const [idx, , body] of old.frameCells()) {
    const fr = parseFrameBody(body, atoms);
    if (fr.isCompleted || fr.pc === null) continue;
    const oldF = old.funcInfo(fr.bytecode!);
    const newF = newFuncs.get(identityKey(oldF.identity))!;
    const newPc = remapPc(oldF, newF, fr.pc);
    if (newPc !== fr.pc) {
      progress(`frame ${idx}: pc ${fr.pc} -> ${newPc} (line ${oldF.lineOfPc(fr.pc)[0]})`);
    }
    fr.pc = newPc;
    old.bodies[idx] = encodeFrameBody(fr, atoms);
    remapped += 1;
  }
  progress(`frames remapped: ${remapped}`);

  // --- new header: signature from the new engine, fresh id
  old.sig = newsig.sig;
  old.snapId = 0n;
  const outBytes = Buffer.from(emitSnapshot(old));
  // id = FNV-1a-64 of the content with a null id, | 1; the id lives
  // right after the magic + version leb + kind byte.
  const idOff = 8 + lebBytes(old.version).length + 1;
  const newId = recomputeId(outBytes);
  outBytes.writeBigUInt64LE(newId, idOff);
  // verify the id round-trips through the parser's own check
  const checkSnap = parseSnapshotBytes(outBytes);
  if (checkSnap.snapId !== newId) throw new Error("id patch failed");
  progress(`converted snapshot (${outBytes.length} bytes, sig=0x${newsig.sig.toString(16)})`);
  return {
    bytes: outBytes,
    newSignature: newsig.sig,
    atomsAppended: appended,
    convertedCells: converted,
    framesRemapped: remapped,
  };
}

// ---------------------------------------------------------------- state-dir surgery

function atomicWriteFile(filePath: string, data: Buffer | string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  const fd = fs.openSync(tmp, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/** Mirror the current file to <path>.bak before overwriting (the
 * BRA-77 queue / BRA-84 registry pattern: a kill at any point leaves
 * each file old or new, never torn, and the backup is never older
 * than the entry). */
function mirrorBackup(filePath: string): void {
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
}

interface CheckpointManifest {
  format: string;
  kind: string;
  keyframeHash: string;
  deltaHash: string | null;
  prevCheckpointHash: string | null;
  ordinal: number;
  sinceKeyframe: number;
  baseSize: number;
  lastDelta: unknown;
  trigger: string;
  [key: string]: unknown;
}

export interface ConvertStateDirOptions {
  stateDir: string;
  runId: string;
  dquicktsDir: string;
  newSigSnapPath: string;
  durabletsCPath?: string;
  workDir: string;
  onProgress?: (line: string) => void;
}

export interface ConvertStateDirResult {
  alreadyConverted: boolean;
  recordUpdated: boolean;
  newVersion: string;
  newFormatIdentity: string;
  newSignature: number;
  bytesLength: number;
  atomsAppended: number;
  convertedCells: number;
  framesRemapped: number;
}

/**
 * Validate the checkpoint up front (before any parse/compile/output —
 * the BRA-115 bug #1 lesson), convert the snapshot, then perform the
 * state-dir surgery: blob/slice/keyframe rewrite, manifest
 * keyframeHash/baseSize, engineVersion + formatIdentity in the
 * registry + queue entry. Refusals (ConvertRefusalError) leave no
 * output and no state touched: conversion happens fully in memory
 * first, and the surgery only runs after the converted bytes are
 * complete and verified.
 */
export function convertStateDir(opts: ConvertStateDirOptions): ConvertStateDirResult {
  const progress = opts.onProgress ?? (() => {});
  const prefix = prefixFor(opts.runId);
  const sd = opts.stateDir;
  const ckptPath = path.join(sd, "blobs", `${prefix}.checkpoint.json`);
  const blobPath = path.join(sd, "blobs", `${prefix}.snap`);
  const slicePath = path.join(sd, "slices", `${prefix}.snap`);
  const registryPath = path.join(sd, "runs", `${prefix}.json`);
  const queuePath = path.join(sd, "queue.json");

  // --- up-front checkpoint validation (before any parse/compile/output)
  if (!fs.existsSync(ckptPath)) {
    throw new ConvertRefusalError(
      `no checkpoint manifest at ${ckptPath} — the run is not suspended (it may have completed), refusing`,
    );
  }
  let ckpt: CheckpointManifest;
  try {
    ckpt = JSON.parse(fs.readFileSync(ckptPath, "utf8")) as CheckpointManifest;
  } catch (e) {
    throw new Error(`checkpoint manifest at ${ckptPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (ckpt.kind !== "base" || ckpt.deltaHash !== null) {
    throw new ConvertRefusalError(
      `checkpoint is not a base (kind=${ckpt.kind}, deltaHash=${ckpt.deltaHash}) — delta resolution is follow-up work, refusing`,
    );
  }
  if (!fs.existsSync(blobPath)) {
    throw new Error(`checkpoint manifest at ${ckptPath} names a blob that does not exist: ${blobPath}`);
  }
  const oldBytes = fs.readFileSync(blobPath);
  const blobHash = sha256Hex(oldBytes);
  if (blobHash !== ckpt.keyframeHash) {
    throw new ConvertRefusalError(
      `checkpoint keyframeHash ${ckpt.keyframeHash} does not match the blob ${blobPath} (sha256 ${blobHash}) — refusing`,
    );
  }
  if (!fs.existsSync(registryPath)) {
    throw new Error(`registry entry for ${opts.runId} does not exist: ${registryPath}`);
  }
  let queue: Array<Record<string, unknown>>;
  try {
    queue = JSON.parse(fs.readFileSync(queuePath, "utf8")) as Array<Record<string, unknown>>;
  } catch (e) {
    throw new Error(`queue at ${queuePath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!queue.some((e) => e["runId"] === opts.runId)) {
    throw new Error(`queue at ${queuePath} has no entry for ${opts.runId}`);
  }

  const durabletsC = opts.durabletsCPath ?? defaultDurabletsCPath();
  const newSigBytes = fs.readFileSync(opts.newSigSnapPath);
  const oldSnap = parseSnapshotBytes(oldBytes);
  const newSnap = parseSnapshotBytes(newSigBytes);
  const target = computeTargetEngine(opts.dquicktsDir, durabletsC, newSnap.sig);

  // --- already at the target version: report, don't rewrite the snapshot.
  if (oldSnap.sig === newSnap.sig) {
    let recordUpdated = false;
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as Record<string, unknown>;
    const queueEntry = queue.find((e) => e["runId"] === opts.runId)!;
    if (registry["engineVersion"] !== target.version || registry["formatIdentity"] !== target.formatIdentity) {
      mirrorBackup(registryPath);
      registry["engineVersion"] = target.version;
      registry["formatIdentity"] = target.formatIdentity;
      atomicWriteFile(registryPath, JSON.stringify(registry, null, 2));
      recordUpdated = true;
    }
    if (queueEntry["engineVersion"] !== target.version || queueEntry["formatIdentity"] !== target.formatIdentity) {
      mirrorBackup(queuePath);
      queueEntry["engineVersion"] = target.version;
      queueEntry["formatIdentity"] = target.formatIdentity;
      atomicWriteFile(queuePath, JSON.stringify(queue, null, 2));
      recordUpdated = true;
    }
    progress(`already converted: ${opts.runId} is already at ${target.version}${recordUpdated ? " (record updated)" : ""} — snapshot not rewritten`);
    return {
      alreadyConverted: true,
      recordUpdated,
      newVersion: target.version,
      newFormatIdentity: target.formatIdentity,
      newSignature: newSnap.sig,
      bytesLength: oldBytes.length,
      atomsAppended: 0,
      convertedCells: 0,
      framesRemapped: 0,
    };
  }

  // --- byte conversion (fully in memory; nothing written yet)
  const helperPath = buildCompileHelper(opts.dquicktsDir, opts.workDir);
  const result = convertSnapshotBytes({
    oldBytes,
    newSigBytes,
    helperPath,
    opcodeTablePath: path.join(opts.dquicktsDir, "quickjs-opcode.h"),
    stateDir: sd,
    workDir: opts.workDir,
    onProgress: progress,
  });

  // --- surgery
  const newHash = sha256Hex(result.bytes);
  const oldKey = path.join(sd, "blobs", "keyframes", `${ckpt.keyframeHash}.snap`);
  const newKey = path.join(sd, "blobs", "keyframes", `${newHash}.snap`);
  atomicWriteFile(blobPath, result.bytes);
  atomicWriteFile(slicePath, result.bytes);
  atomicWriteFile(newKey, result.bytes);
  if (fs.existsSync(oldKey) && oldKey !== newKey) fs.unlinkSync(oldKey);
  ckpt.keyframeHash = newHash;
  ckpt.baseSize = result.bytes.length;
  atomicWriteFile(ckptPath, JSON.stringify(ckpt));
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as Record<string, unknown>;
  mirrorBackup(registryPath);
  registry["engineVersion"] = target.version;
  registry["formatIdentity"] = target.formatIdentity;
  atomicWriteFile(registryPath, JSON.stringify(registry, null, 2));
  const queueEntry = queue.find((e) => e["runId"] === opts.runId)!;
  mirrorBackup(queuePath);
  queueEntry["engineVersion"] = target.version;
  queueEntry["formatIdentity"] = target.formatIdentity;
  atomicWriteFile(queuePath, JSON.stringify(queue, null, 2));
  progress(
    `state dir updated: blob/slice/keyframe rewritten, keyframe=${newHash.slice(0, 12)}..., engineVersion=${target.version}`,
  );
  return {
    alreadyConverted: false,
    recordUpdated: false,
    newVersion: target.version,
    newFormatIdentity: target.formatIdentity,
    newSignature: result.newSignature,
    bytesLength: result.bytes.length,
    atomsAppended: result.atomsAppended,
    convertedCells: result.convertedCells,
    framesRemapped: result.framesRemapped,
  };
}

/** Scratch dir for a convert run (mkdtemp under TMPDIR, never /tmp). */
export function makeConvertWorkDir(): string {
  const base = process.env.TMPDIR ?? path.join(os.homedir(), "tmp", "home-tmp");
  return fs.mkdtempSync(path.join(base, "bra134-convert-"));
}
