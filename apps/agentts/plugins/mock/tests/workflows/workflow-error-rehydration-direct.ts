// Straight-through reference for workflow-error-rehydration.ts: the
// same two throws, made locally instead of delivered by the plugin.
// Outputs must be byte-identical to the driven version.

declare function print(...args: unknown[]): void;

try {
  throw new Error("boom");
} catch (e) {
  print("caught is Error:", e instanceof Error);
  print("caught:", (e as Error).name + ": " + (e as Error).message);
}

try {
  throw "plain failure";
} catch (e) {
  print("plain is Error:", e instanceof Error);
  print("plain:", String(e));
}

print("done");
