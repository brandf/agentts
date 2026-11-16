// decision-model — the LOCAL decision model (BRA-44, v0).
//
// decide() is job's cheap/fast/narrow counterpart: no agent session,
// no worker spawn — a deterministic model that reads the decision
// inputs out of the question and picks an option. v0 is deliberately
// narrow: workflows phrase decide questions with machine-readable
// signals (scores, thresholds, counts) and the model compares them.
// It is a REAL model in the sense that it computes from the question
// content — it does not return a canned answer per test — but it is
// NOT a general reasoner: a question carrying no parseable signal
// falls back to the first option at low confidence, and the fallback
// is journaled by the host as a decide event like any other, so the
// fallback is visible, never silent. BRA-47 owns the canonical
// Decision shape; until then workflows name their own decide result
// type at the call site and this model returns {choice, confidence}.
//
// Signals parsed (in order):
//  1. "mean score X" + "threshold Y" (JudgeFixLoop convergence /
//     revise questions): choice is the option matching
//     /converge|keep|accept/i when X >= Y, else the option matching
//     /revise|continue|change/i; confidence from the margin.
//  2. "misses: N" + "update ... if misses >= M" (rubric questions):
//     choice is the option matching /update/i when N >= M, else the
//     option matching /keep/i.
//  3. "score X" + "threshold Y" (generic): same rule as (1).
//  4. Keyword scoring fallback: each option scores +1 per positive
//     keyword in the question ("good", "ready", "pass", "yes") and -1
//     per negative ("bad", "fail", "missing", "weak") when the option
//     itself matches /yes|accept|keep|converge|pass/i (and the reverse
//     for /no|reject|revise|continue/i); ties break to the first
//     option. Confidence 0.5 — the caller can see it is a guess.

export interface DecisionResult {
  choice: string;
  confidence: number;
}

function numAfter(text: string, re: RegExp): number | null {
  const m = text.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function pickByPattern(options: string[], re: RegExp, fallback: string): string {
  return options.find((o) => re.test(o)) ?? fallback;
}

export function decideLocal(question: string, options?: string[]): DecisionResult {
  const opts = options && options.length ? options : ["yes", "no"];
  const q = question;

  const mean = numAfter(q, /mean score\s+([0-9]*\.?[0-9]+)/i) ?? numAfter(q, /score\s+([0-9]*\.?[0-9]+)/i);
  const threshold = numAfter(q, /threshold\s+([0-9]*\.?[0-9]+)/i);
  if (mean !== null && threshold !== null) {
    const margin = Math.abs(mean - threshold);
    const confidence = Math.min(0.99, 0.55 + margin);
    if (mean >= threshold) {
      return { choice: pickByPattern(opts, /converg|keep|accept|pass|yes/i, opts[0]), confidence };
    }
    return { choice: pickByPattern(opts, /revise|continue|change|no|reject/i, opts[opts.length - 1] ?? opts[0]), confidence };
  }

  const misses = numAfter(q, /misses[:\s]+([0-9]+)/i);
  const missThreshold = numAfter(q, /misses\s*>=\s*([0-9]+)/i);
  if (misses !== null && missThreshold !== null) {
    if (misses >= missThreshold) {
      return { choice: pickByPattern(opts, /update/i, opts[0]), confidence: 0.8 };
    }
    return { choice: pickByPattern(opts, /keep/i, opts[opts.length - 1] ?? opts[0]), confidence: 0.8 };
  }

  // Keyword fallback — a guess, and the confidence says so.
  const positive = (q.match(/\b(good|ready|pass|passed|strong|clear|complete)\b/gi) ?? []).length;
  const negative = (q.match(/\b(bad|fail|failed|missing|weak|unclear|incomplete)\b/gi) ?? []).length;
  const net = positive - negative;
  if (net !== 0) {
    const affirmative = pickByPattern(opts, /yes|accept|keep|converg|pass/i, opts[0]);
    const negativeOpt = pickByPattern(opts, /no|reject|revise|continue|change/i, opts[opts.length - 1] ?? opts[0]);
    return { choice: net > 0 ? affirmative : negativeOpt, confidence: 0.55 };
  }
  return { choice: opts[0], confidence: 0.5 };
}
