// Generic-library consumer for BRA-106: the concrete workflow that
// calls the generic lib `scoreOne<X>` with explicit type arguments.
// The item type is exported: the extractor's specialization alias
// imports it by name.

import { scoreOne, type Score } from "./lib-bra106-generic";

declare function print(...args: unknown[]): void;

export interface Bra106Item {
  text: string;
}

export interface Bra106Input {
  item: Bra106Item;
}

export interface Bra106Output {
  score: number;
  label: string;
}

export default function run(input: Bra106Input): Bra106Output {
  const s: Score = scoreOne<Bra106Item>(input.item, 1);
  print("score:", JSON.stringify(s));
  return { score: s.score, label: s.label };
}
