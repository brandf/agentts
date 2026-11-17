// BRA-83 test workflow: completes in one slice with no traps, so
// the only C-host filesystem write is the run result
// (<snap>.result.json via write_result_json). 0-arg, like the core
// reference workflows.
export interface RunResult {
  value: string;
}

export default function run(): RunResult {
  return { value: "bra83-result" };
}
