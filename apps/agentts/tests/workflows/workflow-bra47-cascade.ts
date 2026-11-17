// BRA-47 test workflow: one decisionCascade call. The DecisionSpec
// arrives as the run input; the Decision is the run output. The test
// (tests/test-bra47.ts) drives this workflow through the Host with a
// MockAdapter, queueing a different canned answer per tier per
// scenario — the cascade's escalation path is the mock answers, not
// the workflow code.
import { decisionCascade, type Decision, type DecisionSpec } from "../../src/agentts";

export default function run(input: DecisionSpec): Decision {
  return decisionCascade(input);
}
