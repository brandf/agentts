// Shared named types for the negative fixtures (each fixture must fail
// type-check for its own mistyped call, not for a missing type).
export interface ScoreInput {
  value: number;
}
export interface ScoreResult {
  score: number;
  label: string;
}
export interface DecideResult {
  choice: string;
  confidence: number;
}
