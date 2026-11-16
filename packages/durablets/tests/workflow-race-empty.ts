// race([]) never settles (Linear BRA-26): the builtin suspends on a
// 0-branch fork and the driver has nothing to spawn or join, so the
// run stays suspended. There is no direct reference: a straight-through
// run cannot complete either. The test drives it boundedly and checks
// it neither resolves nor crashes — the print below must never run.

declare function race(thunks: (() => string)[]): string;
declare function print(...args: unknown[]): void;

const v = race([]);
print("resolved:", v);
