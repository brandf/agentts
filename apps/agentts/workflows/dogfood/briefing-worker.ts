#!/usr/bin/env bun
/**
 * briefing-worker — job worker for the daily AI research briefing workflow
 * (BRA-55). One worker process per job trap, spawned by the direct adapter
 * with `bun briefing-worker.ts '<json {spec, input}>'`; the result JSON is
 * the last stdout line. All work here is GENUINE computation over the real
 * input — live arXiv API / arXiv.org / ar5iv fetches, real scoring and
 * extraction — not canned answers. (The mock path lives in the briefing
 * plugin adapter, which answers these specs with fixtures; this file is
 * the real path.)
 *
 * Specs:
 *   briefing-discover — arXiv discovery over the briefing's categories,
 *     window-filtered, deduped against the seen list (read from disk),
 *     topic-scored. Primary source is the arxiv.org/list past-week
 *     pages (fast, un-rate-limited); the arXiv API is the fallback
 *     (it 429s on this VM's shared egress IP). Never invents papers:
 *     every candidate comes from a fetched listing/feed.
 *   briefing-read — fetch the paper's abs page (verification) + ar5iv
 *     full text; extract number sentences, method sentences and caveat
 *     sentences from the fetched text. Abstract-only when ar5iv fails.
 *   briefing-relate — match a paper against the prior-work index by
 *     title-token overlap (+ author-surname bonus); relations are
 *     computed, with the shared terms shown as the basis.
 *   briefing-render — render the dated markdown edition + meta.json from
 *     the read papers and relations, in the live format. Every factual
 *     sentence is an extracted sentence from fetched paper text; the
 *     template adds structure only, never claims.
 *   briefing-write — write the rendered markdown + meta.json to the
 *     scratch edition dir.
 *
 * Rules: no other console output (the adapter parses the last stdout
 * line as JSON); all outputs are clean JSON (no undefined, no Date
 * objects); fetches carry timeouts and fall back rather than hanging.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  selectAbstractFetch,
  selectSupplement,
  ABSTRACT_FETCH_BATCH_IDS,
} from "../library/pool-promotion";

/** BRA-179: a job payload over the inline argv cap arrives as
 * `agentts-file:<path>` (the spawning side writes the JSON to a
 * scratch file and passes the marker — Linux caps any single argv
 * string at 128KB). Small payloads still arrive inline. The marker
 * starts with `a`, which no JSON document starts with, so it can
 * never collide with an inline payload. A missing or unreadable
 * file fails LOUDLY (the path named) instead of running with an
 * empty input. (Marker + 64KB threshold shared with
 * RESULT_ARG_INLINE_MAX_BYTES / RESULT_ARG_FILE_PREFIX in
 * src/host.ts — BRA-171; keep the two in sync, per the BRA-88
 * verbatim-copy rule.) */
function readPayloadArg(raw: string | undefined): any {
  const text = raw ?? "{}";
  if (!text.startsWith("agentts-file:")) return JSON.parse(text);
  const filePath = text.slice("agentts-file:".length);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new Error(`briefing-worker: cannot read job payload file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const payload = readPayloadArg(process.argv[2]);
const spec: string = payload.spec;
const input: any = payload.input ?? {};

function log(...args: unknown[]): void {
  console.error("[briefing-worker]", ...args);
}

const UA = "AgentTS-briefing-dogfood/0.1 (mailto:research-test@example.invalid)";

// Fetching: curl first (proven reliable through this VM's egress proxy:
// export.arxiv.org via Bun fetch times out / 429s on the shared IP,
// while curl to arxiv.org answers in ~1s), Bun fetch as fallback.
// curl follows redirects (-L: ar5iv 301s) and has a hard --max-time.
async function fetchText(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string }> {
  // Two curl attempts (transient proxy failures happen), then Bun fetch.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = spawnSync(
        "curl",
        ["-s", "-L", "--max-time", String(Math.max(5, Math.ceil(timeoutMs / 1000))), "-A", UA, "-w", "\n%{http_code}", url],
        { encoding: "utf8", timeout: timeoutMs + 5000 },
      );
      if (r.status === 0 && typeof r.stdout === "string" && r.stdout.length > 0) {
        const m = r.stdout.match(/\n(\d{3})\s*$/);
        const status = m ? Number(m[1]) : 0;
        const text = m ? r.stdout.slice(0, m.index) : r.stdout;
        return { ok: status >= 200 && status < 300, status, text };
      }
      log(`fetchText: curl attempt ${attempt + 1} failed for ${url} (status=${r.status}, err=${String(r.stderr ?? "").slice(0, 120)})`);
    } catch (e) {
      log(`fetchText: curl spawn failed for ${url}:`, String(e).slice(0, 200));
    }
  }
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": UA },
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch {
    return { ok: false, status: 0, text: "" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ------------------------------------------------------------ topics
// Priority topics from the briefing goal (GOAL.md): LLM architecture,
// transformers/attention, context compression, vision/multimodal,
// diffusion, speculative decoding, quantization; standing high-interest
// thread: depth-axis looped/recurrent transformers (weight-tied depth
// recurrence, Huginn-style) — NOT time-axis latent CoT.
interface TopicRule {
  name: string;
  weight: number;
  terms: string[];
}
const TOPICS: TopicRule[] = [
  {
    name: "looped-recurrent",
    weight: 3,
    terms: [
      "looped", "looping", "weight-tied", "weight tied", "recurrent transformer",
      "depth recurrence", "depth-recurrent", "huginn", "iterative refinement",
      "fixed-point", "fixed point", "recurrent depth", "loop transformer",
    ],
  },
  {
    // Significance (BRA-124): papers that measure, challenge, or
    // re-examine existing claims — benchmark audits, replications,
    // diagnostics. Title-only topic scoring buried them (the Nov 18
    // must-read scored 2 on title alone: only "attention"). Weight 3,
    // same as the standing looped-recurrent thread: significance is a
    // first-class signal, not a tiebreaker. Deliberately NOT here:
    // "evaluation", "failure", "limitation" — too common in titles,
    // they would inflate everything.
    name: "significance",
    weight: 3,
    terms: [
      "benchmark", "audit", "replication", "reality check",
      "re-evaluat", "revisit", "diagnos", "debunk", "myth",
      "reproducib", "empirical study",
    ],
  },
  {
    name: "architecture-attention",
    weight: 2,
    terms: [
      "transformer", "attention", "sparse attention", "linear attention",
      "mixture of experts", "mixture-of-experts", "moe", "state space",
      "mamba", "architecture", "backbone",
    ],
  },
  {
    name: "context-compression",
    weight: 2,
    terms: [
      "context compression", "kv cache", "kv-cache", "long context",
      "context window", "retrieval", "kv quantization", "cache eviction",
      "context attribution",
    ],
  },
  {
    name: "vision-multimodal",
    weight: 2,
    terms: [
      "vision", "multimodal", "multi-modal", "image generation", "video",
      "vit ", "vision transformer", "vlm", "clip", "visual",
    ],
  },
  {
    name: "diffusion",
    weight: 2,
    terms: ["diffusion", "flow matching", "denoising", "distillation", "few-step", "text-to-image"],
  },
  {
    name: "speculative-decoding",
    weight: 2,
    terms: ["speculative decoding", "speculative", "draft model", "drafting"],
  },
  {
    name: "quantization",
    weight: 2,
    terms: [
      "quantiz", "int4", "int8", "fp4", "fp8", "mxfp4", "nvfp4", "ptq", "qat",
      "low-precision", "low precision", "rotation", "4-bit", "4 bit",
      "w4a", "microscaling",
    ],
  },
];

const STOPWORDS = new Set(
  "a an the and or of to in on for with by at from as is are was were be been it its this that these those we our you your they their he she his her not no do does did can could will would should may might than then when where which who whom what how why all any some more most other into over under between through during before after via per using use used based".split(" "),
);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\- ]/g, " ")
    .split(/[\s\-]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function topicScore(title: string, abstract: string): { score: number; topics: string[]; reason: string } {
  const hay = `${title} ${abstract}`.toLowerCase();
  let score = 0;
  const topics: string[] = [];
  const hits: string[] = [];
  for (const t of TOPICS) {
    let n = 0;
    for (const term of t.terms) {
      if (hay.includes(term)) n++;
    }
    if (n > 0) {
      topics.push(t.name);
      score += t.weight * Math.min(n, 3);
      hits.push(`${t.name}(${n})`);
    }
  }
  return { score, topics, reason: hits.join(", ") || "no topic terms" };
}

function readSeenIds(seenPath: string): Set<string> {
  try {
    const text = fs.readFileSync(seenPath, "utf8");
    return new Set((text.match(/\d{4}\.\d{4,5}/g) ?? []).filter((id) => /^\d{4}\.\d{4,5}$/.test(id)));
  } catch {
    return new Set();
  }
}

// ------------------------------------------------------------ discover
interface Candidate {
  id: string;
  title: string;
  authors: string;
  submitted: string;
  categories: string;
  abstract: string;
  score: number;
  topics: string[];
  reason: string;
}

function parseAtom(xml: string): Candidate[] {
  const out: Candidate[] = [];
  const entries = xml.split(/<entry>/).slice(1);
  for (const e of entries) {
    const idM = e.match(/<id>https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})v\d<\/id>/);
    const titleM = e.match(/<title>([\s\S]*?)<\/title>/);
    const sumM = e.match(/<summary>([\s\S]*?)<\/summary>/);
    const pubM = e.match(/<published>([^<]+)<\/published>/);
    const authors = [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1].trim());
    const cats = [...e.matchAll(/<category term="([^"]+)"/g)].map((m) => m[1]);
    if (!idM || !titleM || !sumM) continue;
    const title = titleM[1].replace(/\s+/g, " ").trim();
    const abstract = sumM[1].replace(/\s+/g, " ").trim();
    const { score, topics, reason } = topicScore(title, abstract);
    out.push({
      id: idM[1],
      title,
      authors: authors.join(", "),
      submitted: (pubM?.[1] ?? "").slice(0, 10),
      categories: cats.join(", "),
      abstract,
      score,
      topics,
      reason,
    });
  }
  return out;
}

function parseListHtml(html: string, category: string): Candidate[] {
  // arxiv.org/list/<cat>/pastweek pages: day groups headed by <h3>
  // ("Mon, 16 Nov 2026 ..."), each entry a <dt> (abs link) + <dd>
  // (title/authors). Attribute quoting/spacing varies; match loosely.
  const out: Candidate[] = [];
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  // Split into day groups: [header, body...] pairs.
  const groups = html.split(/<h3>/).slice(1);
  for (const g of groups) {
    const head = g.split(/<\/h3>/)[0] ?? "";
    const dm = head.match(/(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})/);
    const submitted = dm
      ? `${dm[3]}-${months[dm[2]]}-${dm[1].padStart(2, "0")}`
      : "";
    const body = g.split(/<\/h3>/)[1] ?? "";
    const blocks = body.split(/<dt>/).slice(1);
    for (const b of blocks) {
      const idM = b.match(/href\s*=\s*"\/abs\/(\d{4}\.\d{4,5})"/);
      if (!idM) continue;
      const dd = b.split(/<dd>/)[1] ?? "";
      const titleM = dd.match(/class=['"]list-title[^'"]*['"]>([\s\S]*?)<\/div>/);
      const authM = dd.match(/class=['"]list-authors[^'"]*['"]>([\s\S]*?)<\/div>/);
      const title = titleM
        ? titleM[1].replace(/<[^>]+>/g, "").replace(/^Title:\s*/i, "").replace(/\s+/g, " ").trim()
        : "";
      const authors = authM
        ? authM[1].replace(/<[^>]+>/g, "").replace(/^Authors:\s*/i, "").replace(/\s+/g, " ").trim()
        : "";
      if (!title) continue;
      // List pages carry no abstract; score on title + category text.
      const { score, topics, reason } = topicScore(title, category);
      out.push({
        id: idM[1],
        title,
        authors,
        submitted,
        categories: category,
        abstract: "",
        score,
        topics,
        reason,
      });
    }
  }
  return out;
}

async function discover(): Promise<any> {
  const seenPath: string = input.seenPath ?? "";
  const windowDays: number = typeof input.windowDays === "number" ? input.windowDays : 10;
  const maxResults: number = typeof input.maxResults === "number" ? input.maxResults : 300;
  // BRA-124: pre-judge pool size. The LLM judge re-ranks the pool by
  // consequence and cuts it to the candidate count, so discovery must
  // return a WIDER pool than the final candidates — the consequential
  // papers the keyword cut would drop (InfuseLoop, TPHC, Gemma KV,
  // SpecSearch in round 3) have to be IN the pool to be judged.
  // Default 18 preserves the old behavior for callers that do not
  // judge; the briefing workflow passes 40.
  const preJudgePool: number = typeof input.preJudgePool === "number" ? input.preJudgePool : 18;
  const categories: string[] = Array.isArray(input.categories) && input.categories.length
    ? input.categories
    : ["cs.LG", "cs.CL", "cs.CV", "cs.AI", "stat.ML", "cs.NE"];
  const endDate: string = input.endDate ?? "2026-11-16";
  const end = new Date(`${endDate}T00:00:00Z`);
  const start = new Date(end.getTime() - windowDays * 86400000);
  const windowStart = start.toISOString().slice(0, 10);
  const windowEnd = endDate;

  const seen = readSeenIds(seenPath);
  let scanned: Candidate[] = [];
  let source = "";
  let apiStatus = 0;
  // Primary: arxiv.org/list past-week pages (fast, ~1s each via curl,
  // and NOT rate-limited the way export.arxiv.org is on this shared
  // egress IP). They carry title/authors/date but no abstract, so
  // candidates are title-scored here and re-scored with the abstract
  // at read time. Fallback: one batched arXiv API query (abstracts
  // included), one retry after a 20s pause.
  for (const cat of categories) {
    const r = await fetchText(`https://arxiv.org/list/${cat}/pastweek?skip=0&show=1000`, 60000);
    if (r.ok) scanned.push(...parseListHtml(r.text, cat));
    else log(`discover: list fetch failed for ${cat} status=${r.status}`);
    await sleep(1000);
  }
  if (scanned.length >= 20) {
    source = "arxiv.org list pastweek";
  } else {
    log(`discover: list pages yielded ${scanned.length}; trying arXiv API`);
    const q = categories.map((c) => `cat:${c}`).join(" OR ");
    const apiUrl = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=${maxResults}`;
    let apiText = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetchText(apiUrl, 60000);
      apiStatus = r.status;
      if (r.ok && r.text.includes("<entry>")) {
        apiText = r.text;
        break;
      }
      log(`discover: arXiv API attempt ${attempt + 1} status=${r.status} ok=${r.ok}`);
      if (attempt === 0) await sleep(20000);
    }
    if (apiText) {
      scanned = parseAtom(apiText);
      source = "export.arxiv.org api";
    } else if (scanned.length > 0) {
      source = "arxiv.org list pastweek (partial)";
    } else {
      return {
        ok: false,
        error: `discover: both sources failed (apiStatus=${apiStatus})`,
        candidates: [],
        excludedSeen: [],
        scanned: 0,
        freshCount: 0,
        windowStart,
        windowEnd,
        source: "none",
        apiStatus,
        earliestScanned: "",
      };
    }
  }
  // Dedupe across categories (a paper can carry several).
  {
    const byId = new Map<string, Candidate>();
    for (const c of scanned) if (!byId.has(c.id)) byId.set(c.id, c);
    scanned = [...byId.values()];
  }

  // Window filter. List-sourced entries always carry a submitted date
  // from their day-group header; keep entries in the window.
  const inWindow = scanned.filter((c) => !c.submitted || (c.submitted >= windowStart && c.submitted <= windowEnd));
  const excludedSeen: string[] = [];
  const fresh: Candidate[] = [];
  for (const c of inWindow) {
    if (seen.has(c.id)) {
      if (!excludedSeen.includes(c.id)) excludedSeen.push(c.id);
    } else {
      fresh.push(c);
    }
  }
  fresh.sort((a, b) => b.score - a.score || b.submitted.localeCompare(a.submitted) || a.id.localeCompare(b.id));
  // Top 60% by score, then a diversity fill: top 2 per topic not already
  // included (looped-recurrent first — the standing high-interest
  // thread — so a strong looped paper is never crowded out by the
  // week's quantization pile). Cap preJudgePool candidates (the pool
  // the LLM judge re-ranks; the workflow cuts it to the final
  // candidate count by combined consequence-led score).
  const picked: Candidate[] = [];
  const pickedIds = new Set<string>();
  const topK = Math.max(1, Math.floor(preJudgePool * 0.6));
  for (const c of fresh) {
    if (picked.length >= topK) break;
    if (c.score <= 0) break;
    picked.push(c);
    pickedIds.add(c.id);
  }
  const topicOrder = ["looped-recurrent", "significance", "context-compression", "speculative-decoding", "architecture-attention", "diffusion", "vision-multimodal", "quantization"];
  for (const topic of topicOrder) {
    let added = 0;
    for (const c of fresh) {
      if (added >= 2 || picked.length >= preJudgePool) break;
      if (c.score > 0 && !pickedIds.has(c.id) && c.topics.includes(topic)) {
        picked.push(c);
        pickedIds.add(c.id);
        added++;
      }
    }
  }
  const candidates = picked;
  // BRA-124 pooling gap, second pass (abstract-informed supplement).
  // List-sourced candidates are title-scored, so a paper whose title
  // scores <= 2 but whose abstract is topic-strong never reaches the
  // pool (Nov 18: TPHC title 0 / abstract 7, Gemma title 2 /
  // abstract 4 — both in the cron's edition, neither in the trial
  // pool). Fetch abstracts for the most recent title-low fresh
  // candidates not in the pool (arXiv API id_list, batched) and
  // promote the abstract-strong ones as a SUPPLEMENT to the judge's
  // input — the pool itself is unchanged. Selection is pure (see
  // workflows/library/pool-promotion.ts for why a supplement, not
  // displacement, and for the known limit: this pass does NOT rescue
  // TPHC or Gemma on the Nov 18 data). Only when the primary source
  // is the list pages: API-sourced candidates already carry
  // abstracts (parseAtom scores them with topicScore). Any fetch
  // failure degrades to the title pool — the pass never fails
  // discovery.
  let abstractPass: { fetched: number; promoted: Candidate[] } = { fetched: 0, promoted: [] };
  const listSourced = source.startsWith("arxiv.org list pastweek");
  if (listSourced) {
    try {
      const fetchIds = selectAbstractFetch(fresh, pickedIds);
      if (fetchIds.length > 0) {
        const scored: Candidate[] = [];
        for (let i = 0; i < fetchIds.length; i += ABSTRACT_FETCH_BATCH_IDS) {
          const batch = fetchIds.slice(i, i + ABSTRACT_FETCH_BATCH_IDS);
          const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(batch.join(","))}&max_results=${batch.length}`;
          const r = await fetchText(url, 60000);
          if (r.ok && r.text.includes("<entry>")) scored.push(...parseAtom(r.text));
          else log(`discover: abstract pass batch ${i / ABSTRACT_FETCH_BATCH_IDS + 1} failed status=${r.status}`);
          await sleep(1000);
        }
        abstractPass.fetched = scored.length;
        abstractPass.promoted = selectSupplement(scored, pickedIds);
        if (abstractPass.promoted.length > 0) {
          log(
            `discover: abstract pass fetched=${scored.length} promoted=${abstractPass.promoted.map((c) => `${c.id}(ascore ${c.score})`).join(", ")}`,
          );
        }
      }
    } catch (e) {
      log(`discover: abstract pass failed (${String(e).slice(0, 200)}) — keeping the title pool`);
      abstractPass = { fetched: 0, promoted: [] };
    }
  }
  const earliestScanned = inWindow.reduce((m, c) => (c.submitted && (!m || c.submitted < m) ? c.submitted : m), "");
  return {
    ok: true,
    error: "",
    candidates,
    abstractPass,
    excludedSeen: excludedSeen.sort(),
    scanned: inWindow.length,
    freshCount: fresh.length,
    windowStart,
    windowEnd,
    source,
    apiStatus,
    earliestScanned,
  };
}

// ------------------------------------------------------------ judge-consequence
// BRA-124: the LLM consequence judge (jobspec
// briefing-judge-consequence). MECHANISM GAP, stated plainly: this
// script CANNOT judge. It is a deterministic Bun process — it has no
// LLM in it, and a keyword implementation here would be the v0
// stem-coverage trap all over again, not judgment. The real judge is
// a pool worker (a Muse subagent) following the jobspec prose, which
// reads each abstract and scores consequence 0-10.
//
// So this handler only CARRIES recorded verdicts: the caller passes
// `judgments` (an array of {id, consequence, reasons, evidence}) or
// `judgmentsPath` (a JSON file with the same shape, produced by a
// real LLM reading the abstracts — in production the pool worker's
// completion, in a trial a recorded fixture with provenance). With
// neither, it FAILS LOUDLY — never a silent keyword fallback, never
// an invented score. It validates coverage (exactly one verdict per
// input paper) and range (0-10), and returns the verdicts for the
// workflow to rank by. The ranking itself lives in
// workflows/library/consequence-rank.ts, imported by the workflow.
// NOTE: this shape must stay exactly the declared ConsequenceVerdict
// in daily-ai-briefing.ts ({id, consequence, reasons, evidence?}) —
// the host validates the judge trap's output against the extracted
// schema, and an extra property (an `error` field was here) fails
// every score with "must NOT have additional properties" (first
// judge trial, Nov 19).
interface ConsequenceVerdict {
  id: string;
  consequence: number;
  reasons: string;
  evidence?: string;
}

async function judgeConsequence(): Promise<any> {
  const papers: any[] = Array.isArray(input.papers) ? input.papers : [];
  if (papers.length === 0) {
    return { ok: false, error: "briefing-judge-consequence: no papers in input", scores: [] };
  }
  let judgments: any = input.judgments ?? null;
  if (!judgments && typeof input.judgmentsPath === "string" && input.judgmentsPath) {
    try {
      const raw = fs.readFileSync(input.judgmentsPath, "utf8");
      const parsed = JSON.parse(raw);
      judgments = Array.isArray(parsed) ? parsed : parsed.scores ?? null;
    } catch (e) {
      return {
        ok: false,
        error: `briefing-judge-consequence: cannot read judgments file ${input.judgmentsPath}: ${String(e).slice(0, 200)}`,
        scores: [],
      };
    }
  }
  if (!judgments) {
    return {
      ok: false,
      error:
        "briefing-judge-consequence: no LLM judge available under the direct adapter — pass judgments (recorded LLM verdicts) or judgmentsPath, or run through the worker pool (jobspec briefing-judge-consequence.md). This script cannot judge; a keyword fallback here would be stem-coverage, not judgment.",
      scores: [],
    };
  }
  if (!Array.isArray(judgments)) {
    return { ok: false, error: "briefing-judge-consequence: judgments must be an array", scores: [] };
  }
  const byId = new Map<string, ConsequenceVerdict>();
  for (const j of judgments) {
    if (typeof j?.id !== "string" || typeof j?.consequence !== "number") {
      return { ok: false, error: `briefing-judge-consequence: malformed verdict (need {id, consequence}): ${JSON.stringify(j).slice(0, 200)}`, scores: [] };
    }
    if (j.consequence < 0 || j.consequence > 10) {
      return { ok: false, error: `briefing-judge-consequence: consequence out of range 0-10 for ${j.id}: ${j.consequence}`, scores: [] };
    }
    if (typeof j?.reasons !== "string" || !j.reasons) {
      return { ok: false, error: `briefing-judge-consequence: verdict for ${j.id} carries no reasons — a score without evidence is not a judgment`, scores: [] };
    }
    byId.set(j.id, { id: j.id, consequence: j.consequence, reasons: j.reasons, evidence: j.evidence ?? "" });
  }
  const missing = papers.map((p: any) => p.id).filter((id: string) => !byId.has(id));
  if (missing.length > 0) {
    return { ok: false, error: `briefing-judge-consequence: no verdict for ${missing.length} paper(s): ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""} — incomplete coverage fails loudly, it is not padded with keyword scores`, scores: [] };
  }
  const scores: ConsequenceVerdict[] = papers.map((p: any) => byId.get(p.id)!);
  return { ok: true, error: "", scores };
}

// ------------------------------------------------------------ read
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 40 && s.length < 600)
    .filter((s) => !/^(references|acknowledg|appendix|figure \d|table \d)/i.test(s));
}

function cleanLatex(s: string): string {
  // Light cleanup of LaTeX residue in extracted sentences: keep the
  // numbers/words, drop the markup. No words are added or changed.
  return s
    .replace(/\$(.+?)\$/g, "$1")
    .replace(/\\%/g, "%")
    .replace(/--/g, "–")
    .replace(/~/g, " ")
    .replace(/\\in\b/g, "in")
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isJunkSentence(s: string): boolean {
  return /^(comments|subjects|journal ref|report number|doi:|arxiv:)/i.test(s) ||
    /including references and appendices/i.test(s) ||
    /^\s*(figure|table|algorithm|equation)\s+\d/i.test(s) ||
    // Mangled hyperlink residue from ar5iv text ("this http URL ::mxf8f6f4").
    /https?:\/\/|::/.test(s);
}

// Generic words that would match nearly every paper and must not count
// as a relation basis or an edition-link overlap. Topic words
// (quantization, diffusion, decoding, ...) are deliberately NOT here:
// they are the reason two papers relate.
const GENERIC_RELATE = new Set(
  "model models framework frameworks approach approaches method methods paper papers study studies work works results result performance system systems task tasks data training evaluation evaluations novel efficient large language based using via new proposed present proposes presents introduce introduces one two three four five first second third without within between across through under over per toward towards against among around despite further lightweight mechanisms similarity selection quality methods reduction language sequence forward generation computational deployment matching computation aware step steps".split(" "),
);

// A prior-work title as quoted in a relation note: strip any markdown
// link / bracket-tag residue that survived index generation, so no
// link ever leaks into a rendered edition (it would inflate the
// builder's paper count).
function cleanPriorTitle(t: string): string {
  return t
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\s*\*\*\[[^\]]+\]\*\*\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickNumberSentences(text: string, n: number): string[] {
  const out: string[] = [];
  for (const s of sentences(text)) {
    if (isJunkSentence(s)) continue;
    if (!/\d/.test(s)) continue;
    // A number only counts with a comparison, a unit or a metric word
    // attached — bare digits ("Image-to-3D", "27 pages") are noise.
    const strong = /%|×|\bvs\.?\b|\bpoints?\b|\bpp\b|accuracy|perplexity|bleu|rouge|score|speedup|faster|slower|reduc|improv|gain|loss|latency|throughput|tokens?\/s|params|parameters|memory|energy|error rate|f1\b/i.test(s);
    if (strong) {
      const c = cleanLatex(s);
      if (!out.includes(c)) out.push(c);
    }
    if (out.length >= n) break;
  }
  return out;
}

function pickMethodSentences(text: string, n: number): string[] {
  const out: string[] = [];
  for (const s of sentences(text)) {
    if (isJunkSentence(s)) continue;
    if (/^(however|but|although|despite|while)\b/i.test(s)) continue;
    if (/(we propose|we present|we introduce|this paper proposes|proposes a|introduces a|presents a|our method|our approach|our framework|we design|we develop|we build|we construct)\b/i.test(s)) {
      const c = cleanLatex(s);
      if (!out.includes(c)) out.push(c);
    }
    if (out.length >= n) break;
  }
  return out;
}

function pickCaveatSentences(text: string, n: number): string[] {
  const out: string[] = [];
  for (const s of sentences(text)) {
    if (isJunkSentence(s)) continue;
    if (/\b(limitation|limitations|however|fails|failure|shortcoming|future work|remains open|does not|we do not|not evaluated|single seed|no variance)\b/i.test(s)) {
      const c = cleanLatex(s);
      if (!out.includes(c)) out.push(c);
    }
    if (out.length >= n) break;
  }
  return out;
}

async function read(): Promise<any> {
  const paper = input.paper ?? {};
  const id: string = paper.id ?? "";
  if (!id) return { ok: false, error: "read: no paper id", id: "" };
  const absUrl = `https://arxiv.org/abs/${id}`;
  const htmlUrl = `https://ar5iv.org/html/${id}`;
  const abs = await fetchText(absUrl, 25000);
  if (!abs.ok) {
    return { ok: false, error: `read: abs page fetch failed status=${abs.status}`, id };
  }
  // Verify title/authors from the abs page itself (the briefing's
  // verification standard: every paper verified on its own abs page).
  const absText = stripTags(abs.text);
  const titleM = abs.text.match(/<h1 class="title[^>]*>([\s\S]*?)<\/h1>/);
  const pageTitle = titleM ? stripTags(titleM[1]).replace(/^Title:\s*/i, "") : paper.title;
  const authM = abs.text.match(/<div class="authors[^>]*>([\s\S]*?)<\/div>/);
  const pageAuthors = authM ? stripTags(authM[1]).replace(/^Authors:\s*/i, "") : paper.authors;
  const absM = abs.text.match(/<blockquote class="abstract[^>]*>([\s\S]*?)<\/blockquote>/);
  const abstract = absM ? stripTags(absM[1]).replace(/^Abstract:\s*/i, "") : paper.abstract ?? "";
  const subM = abs.text.match(/\[Submitted on ([^\]]+)\]/);
  const submitted = subM ? subM[1].trim() : paper.submitted ?? "";

  const full = await fetchText(htmlUrl, 45000);
  let bodyText = abstract;
  let fullText = false;
  let readChars = abstract.length;
  if (full.ok && full.text.length > 3000) {
    // ar5iv for same-week papers is often thin (~5K chars); always
    // extract from the abstract too, abstract first, deduped.
    bodyText = `${abstract} ${stripTags(full.text)}`;
    fullText = true;
    readChars = bodyText.length;
  } else {
    log(`read ${id}: ar5iv unavailable (status=${full.status}, bytes=${full.text.length}); abstract-only`);
  }
  const numbers = pickNumberSentences(bodyText, 10);
  const method = pickMethodSentences(bodyText, 6);
  const caveats = pickCaveatSentences(bodyText, 4);
  const { score, topics } = topicScore(pageTitle, abstract);
  // BRA-124: the judge's consequence score rides on the paper from
  // discovery (via the candidate) and passes through the read
  // untouched — the read worker re-scores TOPIC only; it never
  // re-judges consequence. The workflow's rankScore uses it.
  const consequence = typeof paper.consequence === "number" ? paper.consequence : undefined;
  return {
    ok: true,
    error: "",
    id,
    title: pageTitle || paper.title,
    authors: pageAuthors || paper.authors,
    submitted: submitted || paper.submitted,
    abstract,
    numbers,
    method,
    caveats,
    topics,
    score,
    consequence,
    fullText,
    readChars,
    absUrl,
    htmlUrl,
  };
}

// ------------------------------------------------------------ relate
async function relate(): Promise<any> {
  const paper = input.paper ?? {};
  const priorWork: any[] = Array.isArray(input.priorWork) ? input.priorWork : [];
  const paperId: string = paper.id ?? "";
  const paperTokens = new Set(tokens(`${paper.title ?? ""} ${paper.abstract ?? ""}`));
  // Note: the prior-work index carries id/title/date only (no authors),
  // so matching is by title-token overlap; author matching is not
  // possible against this index and is not attempted.
  // Generic words that would match nearly every paper are excluded
  // from the overlap, so a relation needs a real shared term.
  const GENERIC = GENERIC_RELATE;
  const scored: { entry: any; score: number; shared: string[] }[] = [];
  for (const e of priorWork) {
    if (e.id === paperId) continue;
    const eTokens = tokens(cleanPriorTitle(e.title ?? "")).filter((t) => !GENERIC.has(t));
    const shared = eTokens.filter((t) => paperTokens.has(t) && !GENERIC.has(t));
    const uniq = [...new Set(shared)];
    // Distinctive shared terms count more; long terms (>=8 chars) x2.
    // A relation needs >= 4 points across >= 2 shared terms.
    let score = 0;
    for (const t of uniq) score += t.length >= 8 ? 2 : 1;
    if (score >= 4 && uniq.length >= 2) scored.push({ entry: e, score, shared: uniq });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.date.localeCompare(b.entry.date));
  const relations = scored.slice(0, 3).map((s) => ({
    priorId: s.entry.id,
    priorTitle: cleanPriorTitle(s.entry.title),
    priorDate: s.entry.date,
    basis: s.shared.slice(0, 6).join(", "),
    note: `Shares ${s.shared.slice(0, 6).join(", ")} with “${cleanPriorTitle(s.entry.title)}” (${s.entry.date}, arXiv:${s.entry.id}).`,
  }));
  // Standing-thread note, computed from the paper's own topic flags.
  const topics: string[] = Array.isArray(paper.topics) ? paper.topics : [];
  let threadNote = "";
  if (topics.includes("looped-recurrent")) {
    threadNote =
      "Belongs to Brandon's standing high-interest thread: depth-axis looped / recurrent transformers (weight-tied depth recurrence), not time-axis latent CoT.";
  }
  return { paperId, relations, threadNote };
}

// ------------------------------------------------------------ render
function render(): any {
  const date: string = input.date ?? "";
  const dateLabel: string = input.dateLabel ?? date;
  const papers: any[] = Array.isArray(input.papers) ? input.papers : [];
  const mustReadId: string = input.mustReadId ?? "";
  const scopeNote: string = input.scopeNote ?? "";
  const lines: string[] = [];
  lines.push(`# AI Research Briefing — ${dateLabel}`);
  lines.push("");
  lines.push(scopeNote);
  lines.push("");
  papers.forEach((p, i) => {
    const n = i + 1;
    lines.push("---");
    lines.push("");
    lines.push(`## ${n}. ${p.title}`);
    lines.push("");
    lines.push(
      `**arXiv: [${p.id}](https://arxiv.org/abs/${p.id})** · ${p.authors} · Submitted ${p.submitted}` +
        (p.fullText ? "" : " · abstract-only read"),
    );
    lines.push("");
    const why = (p.abstract ?? "").split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
    lines.push(`**Why it matters:** ${why}`);
    lines.push("");
    lines.push("### Key findings");
    lines.push("");
    const nums: string[] = Array.isArray(p.numbers) ? p.numbers : [];
    if (nums.length) {
      for (const s of nums.slice(0, 6)) lines.push(`- ${s}`);
    } else {
      lines.push("- No number-bearing sentences were extracted from the fetched text; the abstract's claims are quoted in “Why it matters” above.");
    }
    lines.push("");
    lines.push("### How it works");
    lines.push("");
    const method: string[] = Array.isArray(p.method) ? p.method : [];
    if (method.length) {
      for (const s of method.slice(0, 5)) lines.push(`- ${s}`);
    } else {
      lines.push("- The fetched text yielded no method sentences matching the extraction patterns; see the abstract above.");
    }
    lines.push("");
    lines.push("### How it relates to other work");
    lines.push("");
    const rels: any[] = Array.isArray(p.relations) ? p.relations : [];
    if (rels.length) {
      for (const r of rels) lines.push(`- ${r.note}`);
    }
    if (p.threadNote) lines.push(`- ${p.threadNote}`);
    // Computed cross-paper links inside this edition.
    const links: string[] = computeEditionLinks(p, papers);
    for (const l of links) lines.push(`- ${l}`);
    if (!rels.length && !p.threadNote && !links.length) {
      lines.push("- No prior-work match scored above threshold against the index of delivered editions; the topic threads above are the nearest context.");
    }
    lines.push("");
    lines.push("### Insights beyond the paper");
    lines.push("");
    const insights: string[] = [];
    const cvs: string[] = Array.isArray(p.caveats) ? p.caveats : [];
    if (cvs.length) insights.push(`Context from the paper's own text: ${cvs[0]}`);
    if (links.length) insights.push(`Read with ${links.length === 1 ? "its" : "the"} companion paper${links.length === 1 ? "" : "s"} in this edition — the shared-term links above name the concrete overlap; check whether it is a shared method or just shared vocabulary.`);
    if (!p.fullText) {
      insights.push("This entry is abstract-only (ar5iv did not serve the full text), so the numbers above come from the abstract; treat any figure without a baseline as provisional until a full read.");
    }
    if (!insights.length) {
      insights.push("No extracted caveat or cross-paper link applies to this paper; the findings and limitations sections above are the honest read.");
    }
    for (const s of insights) lines.push(`- ${s}`);
    lines.push("");
    lines.push("### Honest limitations");
    lines.push("");
    if (cvs.length) {
      for (const s of cvs.slice(0, 3)) lines.push(`- ${s}`);
    } else {
      lines.push("- No limitation sentences were extracted from the fetched paper text; the claims above are the authors' own and unchallenged here.");
    }
    lines.push("");
  });
  lines.push("---");
  lines.push("");
  const must = papers.find((p) => p.id === mustReadId) ?? papers[0];
  const mustWhy = must
    ? (must.abstract ?? "").split(/(?<=[.!?])\s+/).slice(0, 1).join(" ")
    : "";
  lines.push(`**Must-read if you're short on time: ${must?.title ?? ""} (${must?.id ?? ""})** — ${mustWhy}`);
  const markdown = lines.join("\n");
  const meta = {
    date,
    must_read: mustReadId,
    papers: papers.map((p) => p.id),
    slug: `ai-briefing-${date}`,
    title: `AI Research Briefing ${date}`,
  };
  return { markdown, meta, paperCount: papers.length, mustReadId };
}

function computeEditionLinks(p: any, papers: any[]): string[] {
  // Shared distinctive tokens between this paper's title+abstract and
  // another paper's in the same edition -> a computed companion link.
  const links: string[] = [];
  const mine = new Set(tokens(`${p.title ?? ""} ${p.abstract ?? ""}`).filter((t) => !GENERIC_RELATE.has(t)));
  papers.forEach((q, j) => {
    if (q.id === p.id) return;
    const theirs = tokens(`${q.title ?? ""} ${q.abstract ?? ""}`).filter((t) => !GENERIC_RELATE.has(t));
    const shared = [...new Set(theirs.filter((t) => mine.has(t) && t.length >= 7))].slice(0, 4);
    if (shared.length >= 2) {
      links.push(
        `Pairs with #${j + 1} (${q.id}): both papers turn on ${shared.join(", ")} — compare their numbers directly before trusting either.`,
      );
    }
  });
  return links.slice(0, 2);
}

// ------------------------------------------------------------ write
async function write(): Promise<any> {
  const markdown: string = input.markdown ?? "";
  const meta: any = input.meta ?? {};
  const outDir: string = input.outDir ?? "";
  const date: string = input.date ?? "";
  if (!markdown || !outDir || !date) {
    return { ok: false, error: "write: missing markdown/outDir/date", markdownPath: "", metaPath: "", bytes: 0 };
  }
  const dir = path.join(outDir, `ai-briefing-${date}`);
  fs.mkdirSync(dir, { recursive: true });
  const markdownPath = path.join(dir, `${date}-ai-research-briefing.md`);
  const metaPath = path.join(dir, "meta.json");
  fs.writeFileSync(markdownPath, markdown);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return { ok: true, error: "", markdownPath, metaPath, bytes: markdown.length };
}

// ------------------------------------------------------------ dispatch
let result: unknown;
try {
  switch (spec) {
    case "briefing-discover":
      result = await discover();
      break;
    case "briefing-judge-consequence":
      result = await judgeConsequence();
      break;
    case "briefing-read":
      result = await read();
      break;
    case "briefing-relate":
      result = await relate();
      break;
    case "briefing-render":
      result = render();
      break;
    case "briefing-write":
      result = await write();
      break;
    default:
      console.error(`briefing-worker: unknown spec "${spec}"`);
      process.exit(2);
  }
} catch (e) {
  console.error(`briefing-worker: ${spec} threw:`, e);
  process.exit(2);
}
console.log(JSON.stringify(result));
