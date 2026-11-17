// BRA-90 heap shape: mixed heap. __OBJ_COUNT__ small objects plus one
// 250 KB string, held across __SUSPENSIONS__ sleep traps; each
// suspension mutates one object. The middle of the shape axis: half
// the bytes in many cells, half in one cell.
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export default function run(): { objs: number; strLen: number } {
  const big: string = "ab".repeat(250000 / 2);
  const objs: Array<{ i: number; v: string }> = [];
  for (let i = 0; i < __OBJ_COUNT__; i++) objs.push({ i, v: "x".repeat(20) });
  for (let s = 0; s < __SUSPENSIONS__; s++) {
    objs[s % objs.length].v = "y".repeat(20);
    trap("sleep", { ms: 0 });
  }
  print("objs:", objs.length, "str-len:", big.length);
  return { objs: objs.length, strLen: big.length };
}
