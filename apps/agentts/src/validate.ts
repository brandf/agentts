// validate — AJV-style compiled validation against extracted schemas
// (BRA-46 correction, Brandon 19:36 PST).
//
// The plugin compiles each extracted output schema once (AJV) and
// validates every trap result against it BEFORE resuming the workflow.
// Order at the boundary is: JSON-clean check FIRST (json-clean.ts —
// can this even cross?), then schema validation here. A schema
// failure throws at the call site (ordinary try/catch in the
// workflow) with the precise error, journaled.
//
// Notes:
//  - `format` keywords (e.g. date-time, which ts-json-schema-generator
//    emits for Date) are annotation-only here: plain AJV does not
//    assert formats without ajv-formats, and the boundary rule only
//    needs the type check (the Date value already crossed as an ISO
//    string via the JSON-clean conversion). Deliberately not adding
//    ajv-formats: format strictness is the author's JSDoc concern,
//    not a boundary concern.
//  - AJV is constructed with strict:false: generator output is
//    standard draft-07, but strict mode rejects some of its idioms
//    (e.g. undeclared formats); the boundary validator must not fail
//    on the schema shape, only on the data.
//  - Compiled validators are cached per schema object identity within
//    a plugin instance (one compile per trap site per run).

import Ajv, { type ValidateFunction } from "ajv";

export interface SchemaIssue {
  /** JSON path: "$", "$.field", "$[0].x". */
  path: string;
  /** Precise AJV message (e.g. "must be number", "must have required property 'label'"). */
  message: string;
  /** The failing keyword, when AJV names one. */
  keyword?: string;
}

export function formatSchemaIssues(issues: SchemaIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join("; ");
}

function ajvPath(instancePath: string): string {
  if (!instancePath) return "$";
  return (
    "$" +
    instancePath
      .split("/")
      .filter(Boolean)
      .map((seg) => {
        const decoded = seg.replace(/~1/g, "/").replace(/~0/g, "~");
        return /^(0|[1-9][0-9]*)$/.test(decoded) ? `[${decoded}]` : `.${decoded}`;
      })
      .join("")
  );
}

export class SchemaValidator {
  private ajv = new Ajv({ allErrors: true, strict: false });
  private compiled = new Map<any, ValidateFunction>();

  /** Validate a (JSON-clean) value against a compiled schema. */
  validate(value: unknown, schema: any): SchemaIssue[] {
    let fn = this.compiled.get(schema);
    if (!fn) {
      fn = this.ajv.compile(schema);
      this.compiled.set(schema, fn);
    }
    if (fn(value)) return [];
    return (fn.errors ?? []).map((e) => ({
      path: ajvPath(e.instancePath ?? ""),
      message: e.message ?? "failed validation",
      keyword: e.keyword,
    }));
  }
}
