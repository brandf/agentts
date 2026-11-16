// Environment adapter interface — the layer BELOW the plugin (BRA-43).
//
// The plugin calls the adapter; the core never sees it. The adapter is
// the ONLY layer that knows about a particular environment (Muse,
// Claude Code, a plain shell, ...). Everything above it — the DurableTS
// core, the plugin protocol, the trap types, the scheduler, the agentts
// module, the workflow library, the journal format — is portable and
// must stay free of any environment-specific knowledge: no subagent
// APIs, no chat APIs, no environment-specific imports anywhere in
// packages/durablets.
//
// The swap test: swapping the adapter must not touch core / plugin /
// scheduler / workflows. The mock plugin (BRA-45, a later step) is the
// first proof of the boundary: it implements this interface with canned
// handlers, exactly as the reference plugin in driver.ts does today.
//
// The plugin observes timings/costs itself — the adapter does NOT
// report stats.
//
// This file is types only. The adapter itself is NOT built here; it
// comes with the host (BRA-44/48: adapters/muse-adapter now,
// adapters/claude-code-adapter later).

export interface JobHandle {
  /** Opaque handle the adapter understands; the plugin treats it as a token. */
  id: string;
}

export interface JobSpec {
  /** What to run — the trap's arg, carried through unchanged. */
  spec: unknown;
  /** The trap that requested the job, for the plugin's journal. */
  trapId: string;
  runId: string;
}

export interface JobResult {
  /** JSON-like value the trap call returns to the run. */
  value?: unknown;
  /** Error record { name, message } (or a raw value) the trap throws. */
  error?: unknown;
  /** True when the job was cancelled rather than completing. */
  cancelled?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface EnvironmentAdapter {
  /** Spawn a worker job in the right sandbox; returns a handle. */
  spawnJob(spec: JobSpec, input: unknown, workspace: string): Promise<JobHandle>;
  /** Collect a spawned job's result (blocks until it settles). */
  collectJob(handle: JobHandle): Promise<JobResult>;
  /** Cancel a spawned job. */
  cancelJob(handle: JobHandle, reason: string): Promise<void>;
  /** Run a shell command in the right sandbox. */
  runExec(command: string, args: string[], cwd: string): Promise<ExecResult>;
  /** Deliver a gate notification (a human answer is awaited). */
  deliverGate(trapId: string, runId: string, question: string): Promise<void>;
}
