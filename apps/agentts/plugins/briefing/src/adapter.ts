// briefing adapter plugin (BRA-55 / BRA-56 workaround).
//
// The direct adapter hardcodes its worker registry (judge/fix/
// aggregate/rubric-update) and the CLI constructs it with no config,
// so a new workflow's job specs have no CLI path to a worker. This
// plugin is the sanctioned workaround via the Host.loadAdapter seam
// (`--adapter briefing`): it returns a DirectAdapter with the briefing
// workers registered, and a MockAdapter wrapper with deterministic
// fixture answers for the same specs when AGENTTS_BRIEFING_MOCK=1
// (the built-in mock returns a generic {score:0.5} for unknown specs,
// which fails validation against the briefing's concrete types).
//
//   direct (real): bun src/cli.ts run workflows/daily-ai-briefing.ts \
//       --adapter briefing --state-dir <scratch>
//   mock (fixtures): AGENTTS_BRIEFING_MOCK=1 bun src/cli.ts run \
//       workflows/daily-ai-briefing.ts --adapter briefing \
//       --state-dir <scratch>
//
// The worker script is resolved relative to this file (staged tree),
// falling back to the agentts-host working tree, so the plugin works
// whether the CLI runs from the working dir or the staged tree.

import * as fs from "node:fs";
import * as path from "node:path";
import { HOLD, type Adapter, type TrapAnswer, type TrapContext } from "../../../src/adapter";
import { DirectAdapter } from "../../../src/adapters/direct-adapter";
import { MockAdapter } from "../../../src/adapters/mock-adapter";

const BRIEFING_SPECS = [
  "briefing-discover",
  "briefing-read",
  "briefing-relate",
  "briefing-render",
  "briefing-write",
];

function briefingWorkerPath(): string {
  const here = import.meta.dir;
  const candidates = [
    path.resolve(here, "..", "..", "..", "workflows", "briefing-worker.ts"),
    path.resolve(here, "..", "..", "..", "..", "..", "agentts-host", "workflows", "briefing-worker.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `briefing adapter: worker script not found (tried ${candidates.join(", ")})`,
  );
}

export function createBriefingDirectAdapter(): Adapter {
  const worker = briefingWorkerPath();
  const direct = new DirectAdapter();
  for (const spec of BRIEFING_SPECS) direct.registerWorker(spec, worker);
  return direct;
}

// ------------------------------------------------------------ mock mode
// Deterministic fixture answers, valid against the workflow's
// concrete trap types. Fixture papers are clearly fake (2611.9000x);
// the one real ID that appears is 2611.13410 in excludedSeen, showing
// the dedupe field's shape. Mock proves the gate + trap flow + journal
// shape; it writes no files (the write fixture returns paths only).
function mockBriefingJob(arg: any): unknown {
  const spec: string = arg?.spec ?? "";
  const input: any = arg?.input ?? {};
  switch (spec) {
    case "briefing-discover": {
      const candidates = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        id: `2611.9000${n}`,
        title: `Mock paper ${n} on quantization and attention`,
        authors: "Mock Author",
        submitted: "2026-11-16",
        categories: "cs.LG",
        abstract: "Mock abstract. We propose a mock method that improves mock accuracy by 5% over the baseline.",
        score: 8 - n * 0.5,
        topics: ["quantization", "architecture-attention"],
        reason: "quantization(1), architecture-attention(1)",
      }));
      return {
        ok: true,
        error: "",
        candidates,
        excludedSeen: ["2611.13410"],
        scanned: 100,
        freshCount: 99,
        windowStart: "2026-11-09",
        windowEnd: "2026-11-16",
        source: "mock fixture",
        apiStatus: 0,
        earliestScanned: "2026-11-09",
      };
    }
    case "briefing-read": {
      const p: any = input.paper ?? {};
      return {
        ok: true,
        error: "",
        id: p.id ?? "2611.90001",
        title: p.title ?? "Mock paper",
        authors: p.authors ?? "Mock Author",
        submitted: p.submitted ?? "2026-11-16",
        abstract: p.abstract ?? "Mock abstract.",
        numbers: ["Mock result 42% vs baseline 40%, a 2 point gain."],
        method: ["We propose a mock method."],
        caveats: ["Mock limitation: nothing was tested at scale."],
        topics: Array.isArray(p.topics) ? p.topics : ["quantization"],
        score: typeof p.score === "number" ? p.score : 5,
        fullText: true,
        readChars: 500,
        absUrl: `https://arxiv.org/abs/${p.id ?? "2611.90001"}`,
        htmlUrl: `https://ar5iv.org/html/${p.id ?? "2611.90001"}`,
      };
    }
    case "briefing-relate": {
      const p: any = input.paper ?? {};
      return {
        paperId: p.id ?? "",
        relations: [
          {
            priorId: "2609.20751",
            priorTitle: "Mock prior paper on quantization",
            priorDate: "2026-09-25",
            basis: "quantization",
            note: "Mock relation (fixture): shares quantization with “Mock prior paper on quantization” (2026-09-25, arXiv:2609.20751).",
          },
        ],
        threadNote: "",
      };
    }
    case "briefing-render": {
      const papers: any[] = Array.isArray(input.papers) ? input.papers : [];
      const lines: string[] = [
        `# AI Research Briefing — ${input.dateLabel ?? input.date ?? ""}`,
        "",
        String(input.scopeNote ?? ""),
        "",
      ];
      papers.forEach((pp: any, i: number) => {
        lines.push("---", "", `## ${i + 1}. ${pp.title ?? ""}`, "");
        lines.push(
          `**arXiv: [${pp.id}](https://arxiv.org/abs/${pp.id})** · ${pp.authors ?? ""} · Submitted ${pp.submitted ?? ""}`,
          "",
          `**Why it matters:** ${String(pp.abstract ?? "").split(/(?<=[.!?])\s+/).slice(0, 2).join(" ")}`,
          "",
          "### Key findings",
          "",
          ...((pp.numbers ?? []).map((s: string) => `- ${s}`) as string[]),
          "",
          "### How it works",
          "",
          ...((pp.method ?? []).map((s: string) => `- ${s}`) as string[]),
          "",
          "### How it relates to other work",
          "",
          ...((pp.relations ?? []).map((r: any) => `- ${r.note}`) as string[]),
          "",
          "### Insights beyond the paper",
          "",
          "- Mock insight (fixture).",
          "",
          "### Honest limitations",
          "",
          ...((pp.caveats ?? []).map((s: string) => `- ${s}`) as string[]),
          "",
        );
      });
      lines.push("---", "");
      const must = papers.find((pp: any) => pp.id === input.mustReadId) ?? papers[0];
      lines.push(
        `**Must-read if you're short on time: ${must?.title ?? ""} (${must?.id ?? ""})** — mock must-read line (fixture).`,
      );
      const markdown = lines.join("\n");
      return {
        markdown,
        meta: {
          date: input.date ?? "",
          must_read: input.mustReadId ?? "",
          papers: papers.map((pp: any) => pp.id),
          slug: `ai-briefing-${input.date ?? ""}`,
          title: `AI Research Briefing ${input.date ?? ""}`,
        },
        paperCount: papers.length,
        mustReadId: input.mustReadId ?? "",
      };
    }
    case "briefing-write": {
      const date: string = input.date ?? "";
      const outDir: string = input.outDir ?? "";
      return {
        ok: true,
        error: "",
        markdownPath: `${outDir}/ai-briefing-${date}/${date}-ai-research-briefing.md`,
        metaPath: `${outDir}/ai-briefing-${date}/meta.json`,
        bytes: String(input.markdown ?? "").length,
      };
    }
    default:
      return undefined;
  }
}

class BriefingMockAdapter implements Adapter {
  readonly name = "briefing-mock";
  private mock = new MockAdapter({ gates: "auto" });

  answer(type: string, arg: any, ctx: TrapContext): TrapAnswer | typeof HOLD {
    if (type === "job" && typeof arg?.spec === "string" && BRIEFING_SPECS.includes(arg.spec)) {
      const value = mockBriefingJob(arg);
      if (value !== undefined) return { value };
    }
    return this.mock.answer(type, arg, ctx);
  }
}

export function createAdapter(): Adapter {
  if (process.env.AGENTTS_BRIEFING_MOCK === "1") {
    return new BriefingMockAdapter();
  }
  return createBriefingDirectAdapter();
}

export default createAdapter;
