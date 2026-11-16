#!/usr/bin/env bun
/**
 * complete-job — one-shot complete-job for the true-subagent leg (BRA-48).
 *
 * Posts a job's result (or an exception) to the queue. The result
 * must be JSON-clean: plain JSON values only (a Date crosses as its
 * ISO string; undefined / functions / class instances are rejected
 * by the host's trap boundary, so do not send them — the server
 * accepts the JSON, the run then throws a ValidationError at the
 * call site, and the work is wasted). File effects go with the
 * completion as full file contents (see WORKER.md): pass
 * --files-dir <your per-job workspace> and every file in it (minus
 * input.json) is returned; the coordinator applies them after
 * review — they are never auto-applied.
 *
 *   bun plugins/muse/complete-job.ts --server http://127.0.0.1:18741 \
 *       --job-id job-1-abc --worker-id w1 --result '{"score":0.9}'
 *   bun plugins/muse/complete-job.ts ... --result-file result.json [--files-dir ./work]
 *   bun plugins/muse/complete-job.ts ... --error 'could not read the input' [--error-name JobError]
 *
 * A 409 means the job is no longer yours (cancelled, timed out and
 * re-queued, or already completed): STOP — do not retry the
 * completion, do not re-do the work. Exit code is 0 on 200, 3 on
 * 409, 1 otherwise.
 * Env: AGENTTS_WORKER_SERVER, AGENTTS_WORKER_ID.
 */
import * as fs from "node:fs";
import * as path from "node:path";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const ARGS = process.argv.slice(2);
const SERVER = (flag(ARGS, "--server") ?? process.env.AGENTTS_WORKER_SERVER ?? "http://127.0.0.1:18741").replace(/\/$/, "");
const JOB_ID = flag(ARGS, "--job-id") ?? "";
const WORKER_ID = flag(ARGS, "--worker-id") ?? process.env.AGENTTS_WORKER_ID ?? "";
const RESULT = flag(ARGS, "--result");
const RESULT_FILE = flag(ARGS, "--result-file");
const ERROR = flag(ARGS, "--error");
const ERROR_NAME = flag(ARGS, "--error-name") ?? "JobError";
const FILES_DIR = flag(ARGS, "--files-dir");

if (!JOB_ID || !WORKER_ID) {
  console.error("complete-job: --job-id and --worker-id are required");
  process.exit(2);
}
if (!RESULT && !RESULT_FILE && !ERROR) {
  console.error("complete-job: one of --result, --result-file, --error is required");
  process.exit(2);
}

let body: any = { jobId: JOB_ID, workerId: WORKER_ID };
if (ERROR) {
  body.error = { name: ERROR_NAME, message: ERROR };
} else {
  const raw = RESULT_FILE ? fs.readFileSync(RESULT_FILE, "utf8") : RESULT!;
  try {
    body.result = JSON.parse(raw);
  } catch {
    console.error("complete-job: --result / --result-file is not valid JSON");
    process.exit(2);
  }
}
if (FILES_DIR) {
  const dir = path.resolve(FILES_DIR);
  const files: { path: string; content: string }[] = [];
  let bytes = 0;
  const walk = (d: string, rel: string): void => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, r);
      else if (r !== "input.json") {
        const content = fs.readFileSync(p, "utf8");
        bytes += Buffer.byteLength(content, "utf8");
        if (bytes > 1_000_000) {
          console.error("complete-job: file effects exceed the 1MB cap — return fewer/smaller files");
          process.exit(2);
        }
        files.push({ path: r, content });
      }
    }
  };
  walk(dir, "");
  if (files.length) body.files = files;
}

const res = await fetch(`${SERVER}/complete-job`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(text);
process.exit(res.status === 200 ? 0 : res.status === 409 ? 3 : 1);
