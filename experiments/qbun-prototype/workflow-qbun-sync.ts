// Sync-style workflow under qbun: qbun modules used SYNCHRONOUSLY
// (node:fs sync APIs, node:child_process execSync) plus the durable
// step() builtin, called from sync top-level code. No top-level await.
//
// RESULT (2026-11-15): step() THROWS "TypeError: this call cannot be
// suspended" — even with no top-level await and no imports at all.
// The module's top-level frame is an async function frame (the engine
// runs module code via js_async_function_call), and JS_SuspendCall
// requires every frame on the chain to be a normal function down to a
// HOST frame. See README.md for the full root cause. The fs/child
// lines above DO run; only the step() call fails.
import { writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

declare function step(input: { op: string; value: number }): {
  score: number;
  label: string;
};

writeFileSync("/tmp/qbun-wf-input.txt", "item 7\n");
console.log("fs read back:", JSON.stringify(readFileSync("/tmp/qbun-wf-input.txt", "utf8")));
console.log("child said:", JSON.stringify(execSync("echo 7").toString().trim()));

const a = step({ op: "score", value: 7 });
console.log("step 1 ->", JSON.stringify(a));
const b = step({ op: "score", value: 3 });
console.log("step 2 ->", JSON.stringify(b));
console.log("workflow done");
