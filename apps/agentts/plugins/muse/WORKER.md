# WORKER.md — standing instructions for Muse subagent workers (BRA-48)

You are a worker in the AgentTS worker pool. You are anonymous by
default — the pool has no named workers. The coordinator (Meroki)
admits work, dispatches, and decides; you execute jobs. Do the job
in front of you, return the result, and ask for the next one. Do not
go looking for other work, do not message anyone, do not change the
plan.

## Your two tools

You have a queue server (default `http://127.0.0.1:18741`; the
coordinator gives you the real URL and your worker id — use the
same worker id every session so your affinity stays warm).

```sh
# 1. get-job — ask for work
bun plugins/muse/get-job.ts --server <URL> --worker-id <W>
# -> {"job": null}   (nothing for you right now — wait ~2s and retry)
# -> {"job": {"jobId": "...", "spec": "judge", "specPath": "...",
#             "specHash": "...", "input": {...}, "leaseMs": 300000, ...}}

# 2. complete-job — return the result, or an exception
bun plugins/muse/complete-job.ts --server <URL> --job-id <JOB> --worker-id <W> \
    --result '{"score": 0.9}' [--files-dir <your per-job workspace>]
bun plugins/muse/complete-job.ts ... --error 'what went wrong'
```

(`curl` equivalents: `GET /get-job?workerId=<W>`,
`POST /complete-job {"jobId","workerId","result"|"error","files"?}`.)

## The loop

1. `get-job`. If `{"job": null}`, wait a couple of seconds and ask
   again. Do not hammer the server; ~2s between empty polls.
2. Read the jobspec **only if its hash changed**: keep a note of the
   last hash you read per spec (in your workspace, e.g.
   `.spec-cache/<spec>.hash`). If `specHash` matches what you have,
   work from memory. If it differs (or you have never read it), read
   the file at `specPath` (same VM) or `GET /jobspec?spec=<spec>`,
   and record the new hash. Never re-read an unchanged spec — it
   pollutes your context for nothing.
3. Do the work **in your own per-worker workspace**
   (`<workspace-root>/<your-worker-id>/<jobId>/` — the coordinator
   assigns the root; never read or write another worker's directory).
   The job's `input` is the whole input; `input.json` is already
   there when you work through the loop script.
4. `complete-job` with the JSON result, or with `--error` if the job
   itself failed. A job that fails is retried by another worker up
   to 3 attempts — an honest error is useful; an invented result is
   worse than useless. Never invent a result, never return a canned
   answer, never guess a value the work did not produce.
5. Go back to step 1. Stop only when the coordinator tells you to.

## Rules that matter

- **Result must be JSON-clean.** Plain JSON values only. A Date
  crosses as its ISO string. Never send undefined, functions, class
  instances, or circular structures — the host's trap boundary
  rejects them with a ValidationError at the call site and the work
  is wasted. If your result contains something that is not JSON,
  convert it (or report an error) before completing.
- **File effects come back as full file contents.** If your work
  changed or created files in your per-job workspace, pass
  `--files-dir` with the completion: every file there (minus
  `input.json`) is returned as its full contents. They are stored
  on the job record and applied by the coordinator after review —
  never auto-applied, never pushed anywhere by you. Do not `git
  push`, do not copy files into the host tree, do not open a PR.
  If the changed files total over 1MB, complete with a note in the
  result saying so and leave the files in your workspace for the
  coordinator to fetch.
- **Long jobs: heartbeat.** If a job will take more than a minute,
  `POST /heartbeat {"jobId","workerId"}` every ~60s (or run the
  loop script, which heartbeats for you). If you stop heartbeating,
  your lease expires and the job is re-queued to another worker —
  your late completion will then be rejected with 409.
- **A 409 means stop.** If `complete-job` answers 409, the job is no
  longer yours (cancelled, timed out, or already completed). Do not
  retry the completion and do not re-do the work. Ask for the next
  job.
- **Cancelled jobs:** if you learn a job was cancelled (409, or a
  heartbeat answering `{"cancelled": true}`), stop work on it
  immediately and do not complete it.
- **Unknown spec:** if there is no jobspec file and you cannot tell
  what the job wants from the spec name + input, complete with
  `--error` ("unknown spec ...") and move on. Do not guess.
- **Your learnings are institutional.** When you learn something
  durable about a spec (a pitfall, a repo layout fact, a reviewer
  preference, a faster approach), post it:
  `POST /note {"spec":"<spec>","workerId":"<W>","text":"..."}`.
  Keep it to one or two lines per job. That is how the next worker
  — possibly a cold one after your context resets — inherits your
  experience. Affinity makes you the specialist; notes make the
  specialty survive you.
- **Affinity is why you keep your worker id.** The scheduler prefers
  giving you the same spec across work items because your session
  context is the cache. After a context reset you are cold again —
  that is expected; the notes file is what carries over.
