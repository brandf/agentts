// BRA-90 realistic workload 1: briefing-style accumulation.
// Six papers are fetched one at a time (trap "job" op "fetch"); each
// trap result carries a ~3 KB paper body, which the workflow stores in
// `drafts` and folds into a running `brief` string. A "refine" trap per
// paper returns editorial notes (~1 KB) that are appended to `notes`.
// Nothing is ever dropped: the live heap grows monotonically, the way
// a real daily-briefing run accumulates drafts across its traps.
// Suspensions: 12 (6 fetch + 6 refine).
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface FetchResult {
  title: string;
  body: string;
}
interface RefineResult {
  notes: string;
}

export default function run(): { papers: number; briefChars: number } {
  const drafts: string[] = [];
  const notes: string[] = [];
  let brief = "";
  for (let i = 0; i < 6; i++) {
    const paper = trap("job", { op: "fetch", paper: i }) as FetchResult;
    drafts.push(paper.body);
    brief += "\n## " + paper.title + "\n" + paper.body.slice(0, 400);
    const ref = trap("job", { op: "refine", paper: i }) as RefineResult;
    notes.push(ref.notes);
    brief += "\n> " + ref.notes.slice(0, 200);
  }
  print("papers:", drafts.length, "brief-chars:", brief.length);
  return { papers: drafts.length, briefChars: brief.length };
}
