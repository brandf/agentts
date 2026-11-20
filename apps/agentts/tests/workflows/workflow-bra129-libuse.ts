// BRA-129 fixture: entry importing the library helper whose trap sits
// inside a map callback — refused at extraction time.
import { libRunAll } from "./workflow-bra129-lib";

export interface LibUseInput {
  marker: string;
}

export interface LibUseOut {
  outs: string[];
}

export default function libUseCase(input: LibUseInput): LibUseOut {
  return { outs: libRunAll(["cb"]) };
}
