// workflow-bra111-render — minimal briefing workflow for the BRA-111
// test (tests/test-bra111.ts, section B). One briefing-relate job +
// one briefing-render job with fixture input: pure computation, no
// network, so the test proves the adapter/path mechanism
// deterministically (direct adapter + workers-config through the
// queue drive + delivery), while the real-day trial with live arXiv
// fetches runs once outside run.sh (see ~/workspace/bra111-trial.sh).

import { job } from "../../src/agentts";

export interface Bra111Paper {
  id: string;
  title: string;
  authors: string;
  submitted: string;
  abstract: string;
  numbers: string[];
  method: string[];
  caveats: string[];
  topics: string[];
  fullText: boolean;
}

export interface Bra111PriorWork {
  id: string;
  title: string;
  date: string;
}

export interface Bra111RenderInput {
  paper: Bra111Paper;
  priorWork: Bra111PriorWork[];
  date: string;
  dateLabel: string;
  scopeNote: string;
}

export interface Bra111Relation {
  priorId: string;
  priorTitle: string;
  priorDate: string;
  basis: string;
  note: string;
}

export interface Bra111RelateResult {
  paperId: string;
  relations: Bra111Relation[];
  threadNote: string;
}

export interface Bra111RenderPaper {
  id: string;
  title: string;
  authors: string;
  submitted: string;
  abstract: string;
  numbers: string[];
  method: string[];
  caveats: string[];
  relations: Bra111Relation[];
  threadNote: string;
  topics: string[];
  fullText: boolean;
}

export interface Bra111RenderInputJob {
  date: string;
  dateLabel: string;
  papers: Bra111RenderPaper[];
  mustReadId: string;
  scopeNote: string;
}

export interface Bra111Meta {
  date: string;
  must_read: string;
  papers: string[];
  slug: string;
  title: string;
}

export interface Bra111RenderResult {
  markdown: string;
  meta: Bra111Meta;
  paperCount: number;
  mustReadId: string;
}

export interface Bra111RelateInput {
  paper: {
    id: string;
    title: string;
    abstract: string;
    authors: string;
    topics: string[];
  };
  priorWork: Bra111PriorWork[];
}

export interface Bra111Output {
  paperId: string;
  relations: number;
  threadNote: string;
  markdownHasTitle: boolean;
  markdownHasMustRead: boolean;
  mustReadId: string;
  paperCount: number;
  metaPapers: string[];
}

export default function bra111Render(input: Bra111RenderInput): Bra111Output {
  const rel = job<Bra111RelateInput, Bra111RelateResult>({
    spec: "briefing-relate",
    input: {
      paper: {
        id: input.paper.id,
        title: input.paper.title,
        abstract: input.paper.abstract,
        authors: input.paper.authors,
        topics: input.paper.topics,
      },
      priorWork: input.priorWork,
    },
  });
  const rendered = job<Bra111RenderInputJob, Bra111RenderResult>({
    spec: "briefing-render",
    input: {
      date: input.date,
      dateLabel: input.dateLabel,
      papers: [
        {
          id: input.paper.id,
          title: input.paper.title,
          authors: input.paper.authors,
          submitted: input.paper.submitted,
          abstract: input.paper.abstract,
          numbers: input.paper.numbers,
          method: input.paper.method,
          caveats: input.paper.caveats,
          relations: rel.relations,
          threadNote: rel.threadNote,
          topics: input.paper.topics,
          fullText: input.paper.fullText,
        },
      ],
      mustReadId: input.paper.id,
      scopeNote: input.scopeNote,
    },
  });
  return {
    paperId: input.paper.id,
    relations: rel.relations.length,
    threadNote: rel.threadNote,
    markdownHasTitle: rendered.markdown.includes(input.paper.title),
    markdownHasMustRead: rendered.markdown.includes("Must-read"),
    mustReadId: rendered.mustReadId,
    paperCount: rendered.paperCount,
    metaPapers: rendered.meta.papers,
  };
}
