// Async-style workflow under qbun: an async qbun API is awaited BEFORE
// step() is called.
//
// RESULT (2026-11-15): step() THROWS "TypeError: this call cannot be
// suspended", as expected — but the await is not the cause. Even the
// sync workflow (no await at all) throws the same error: the module's
// top-level frame is itself an async function frame (the engine runs
// module code via js_async_function_call), and JS_SuspendCall requires
// every frame on the chain to be a normal function down to a HOST
// frame. See README.md for the full root cause.
declare function step(input: { op: string; value: number }): {
  score: number;
  label: string;
};

const text = await Bun.file("/tmp/qbun-wf-input.txt").text();
console.log("async read:", JSON.stringify(text));
const a = step({ op: "score", value: 7 });
console.log("step 1 ->", JSON.stringify(a));
console.log("workflow done");
