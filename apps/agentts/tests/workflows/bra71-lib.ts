// BRA-71 test lib: its TYPE flows into the workflow's output schema
// (workflow-bra71 returns LibInfo), so editing this file mid-run
// changes the schemas a resumed run validates against — unless the
// frozen closure is used. The test edits this file mid-run and
// restores the original in a finally block (and writes the original
// at startup, so a leftover edit from a killed run is repaired).
export interface LibInfo {
  value: string;
}

export function libMarker(): LibInfo {
  return { value: "original-lib" };
}
