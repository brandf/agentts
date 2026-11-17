// BRA-90 keyframes: long accumulating run (briefing shape, extended).
// __PAPERS__ fetch/refine pairs (2 suspensions each); drafts + brief
// held live, nothing dropped, so the heap grows ~4 KB per paper and
// the delta grows monotonically since the base/keyframe — the shape
// the keyframe interval is tuned against.
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface FetchResult { title: string; body: string; }
interface RefineResult { notes: string; }

export default function run(): { papers: number; briefChars: number } {
  const drafts: string[] = [];
  const notes: string[] = [];
  let brief = "";
  for (let i = 0; i < __PAPERS__; i++) {
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
