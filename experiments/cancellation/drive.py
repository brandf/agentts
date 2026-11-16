#!/usr/bin/env python3
"""Driver + checks for the cancellation prototype (Linear BRA-27, plan
doc section 8 prototype 3, design Q14): cancel a pending step, cancel
a whole combinator, sticky cancellation, the cancel-versus-complete
race (both orders), nested (recursive) propagation.

The driver is the environment: it delivers step results, so it also
delivers cancellations, via `host cancel <snap> <cancel.json>`. Each
scenario is scripted — the driver decides the order of events, then
checks the workflow's stdout and every journal:

  1. cancel a pending step — the workflow sees a CancellationError at
     the step call site, its finally block runs, and the journal
     records the cancellation event (what / when / why / trigger);
  2. cancel a whole all() in flight — the remaining children are
     cancelled, the combinator call throws a CancellationError at the
     call site, finally blocks run;
  3. sticky cancellation — after a run is cancelled, any further
     step() or combinator call throws immediately without dispatching;
  4. cancel-versus-complete race — a step whose result landed before
     the cancel keeps its result (result-first), and a cancel that
     lands first means the result never arrives (cancel-first);
     whichever is recorded in the journal first wins;
  5. nested propagation — cancel a parent whose branch itself forked:
     the whole tree cancels recursively, each journal recording its
     cancellation event.

Exit 0 on PASS, 1 on any mismatch. Run via ./run.sh.
"""
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys

DIR = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(DIR, "host")

MOCK = {
    ("score", 7): {"score": 0.92, "label": "approved"},
    ("verify", 7): {"score": 0.97, "label": "verified"},
    ("score", 3): {"score": 0.41, "label": "weak"},
    ("verify", 3): {"score": 0.88, "label": "retried"},
    ("score", 9): {"score": 0.31, "label": "slow"},
    ("score", 21): {"score": 0.21, "label": "g21"},
    ("score", 22): {"score": 0.22, "label": "g22"},
}

FAILURES = []


def fail(msg):
    print(f"FAIL: {msg}")
    FAILURES.append(msg)


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def mock_result(step_input):
    key = (step_input.get("op"), step_input.get("value"))
    if key in MOCK:
        return MOCK[key]
    print(f"[mock] no canned result for {key}; using default",
          file=sys.stderr)
    return {"score": 0.5, "label": "default"}


def last_step_input(log_path):
    last = None
    with open(log_path) as f:
        for line in f:
            if "[host] step(" in line:
                last = line
    if last is None:
        return None
    start = last.index("[host] step(") + len("[host] step(")
    end = last.rindex(") — suspending")
    return json.loads(last[start:end])


def read_journal(path):
    events = []
    if not os.path.exists(path):
        return events
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def last_fork(journal_path):
    forks = [e for e in read_journal(journal_path)
             if e.get("type") == "fork"]
    return forks[-1] if forks else None


def forks_of(journal_path):
    return [e for e in read_journal(journal_path)
            if e.get("type") == "fork"]


def prefix_for(run_id):
    return run_id.replace("/", "_")


def run_host(args, out_path, log_path, env_extra):
    env = dict(os.environ)
    env.update(env_extra)
    with open(out_path, "a") as out, open(log_path, "a") as log:
        r = subprocess.run([HOST] + args, stdout=out, stderr=log, env=env)
    return r.returncode


def clean(prefix):
    for pat in (prefix + ".snap", prefix + ".out", prefix + ".log",
                prefix + ".journal", prefix + ".outcome.json",
                prefix + ".cancel.json", prefix + ".join-*.json"):
        for f in glob.glob(pat):
            if os.path.isfile(f):
                os.remove(f)


# --- run registry -----------------------------------------------------
# run_id -> {"snap","out","log","env","rc","kind",
#            "ordinal" (pending step), "fork" (pending fork event),
#            "parentForkId","branch"}
# kind is "step" | "combinator" | "done" | "error", refreshed from the
# run's journal after every host invocation.
RUNS = {}


def refresh(run_id):
    entry = RUNS[run_id]
    journal = prefix_for(run_id) + ".journal"
    events = read_journal(journal)
    if entry["rc"] == 2:
        steps = [e for e in events if e.get("type") == "step"]
        entry["kind"] = "step"
        entry["ordinal"] = steps[-1]["ordinal"] if steps else None
        entry["fork"] = None
    elif entry["rc"] == 3:
        entry["kind"] = "combinator"
        entry["fork"] = last_fork(journal)
        entry["ordinal"] = None
    elif entry["rc"] == 0:
        entry["kind"] = "done"
    else:
        entry["kind"] = "error"


def start_run(workflow, run_id):
    """host run; registers the run; returns the exit code."""
    p = prefix_for(run_id)
    clean(p)
    env = {"AGENTTS_RUN_ID": run_id, "AGENTTS_JOURNAL": p + ".journal"}
    rc = run_host(["run", workflow, p + ".snap"], p + ".out", p + ".log",
                  env)
    RUNS[run_id] = {"snap": p + ".snap", "out": p + ".out",
                    "log": p + ".log", "env": env, "rc": rc,
                    "kind": None, "ordinal": None, "fork": None,
                    "parentForkId": None, "branch": None}
    refresh(run_id)
    return rc


def deliver_result(run_id, result):
    """host resume with a result; returns the new exit code."""
    entry = RUNS[run_id]
    rc = run_host(["resume", entry["snap"], json.dumps(result)],
                  entry["out"], entry["log"], entry["env"])
    entry["rc"] = rc
    refresh(run_id)
    return rc


def start_branch(child, snap, index, env, fork_id):
    """Spawn branch `child` as a child process on a copy of the parent
    snapshot. Runs it only until it suspends (at a step, exit 2, or at
    a combinator, exit 3) or completes (exit 0) — it is NOT driven
    further: the cancellation scenarios need the child live-suspended.
    Registers the child; returns the exit code."""
    cprefix = prefix_for(child)
    csnap = cprefix + ".snap"
    cout, clog = cprefix + ".out", cprefix + ".log"
    coutcome = cprefix + ".outcome.json"
    clean(cprefix)
    shutil.copy(snap, csnap)
    open(cout, "w").close()
    open(clog, "w").close()
    cenv = dict(env)
    cenv.update({"AGENTTS_RUN_ID": child,
                 "AGENTTS_JOURNAL": cprefix + ".journal",
                 "AGENTTS_OUTCOME": coutcome,
                 "AGENTTS_PARENT_FORK": fork_id})
    rc = run_host(["branch", csnap, str(index)], cout, clog, cenv)
    RUNS[child] = {"snap": csnap, "out": cout, "log": clog, "env": cenv,
                   "rc": rc, "kind": None, "ordinal": None, "fork": None,
                   "parentForkId": fork_id, "branch": index}
    refresh(child)
    return rc


def cancel_run(run_id, reason, trigger, cancelled=None):
    """Deliver a cancellation to one suspended run via `host cancel`.
    The cancel record carries what the run is waiting on (from the
    registry: pending step ordinal, or pending fork id + the direct
    children cancelled by this operation). Returns the new exit code,
    or None if the run was not suspended (nothing to cancel)."""
    entry = RUNS[run_id]
    if entry["rc"] not in (2, 3):
        return None
    p = prefix_for(run_id)
    record = {"reason": reason, "trigger": trigger}
    if entry["kind"] == "step":
        record["what"] = "step"
        record["ordinal"] = entry["ordinal"]
    else:
        record["what"] = "fork"
        record["forkId"] = entry["fork"]["forkId"]
        record["cancelled"] = list(cancelled or [])
    if entry.get("parentForkId") is not None:
        record["parentForkId"] = entry["parentForkId"]
        record["branch"] = entry["branch"]
    record_path = p + ".cancel.json"
    with open(record_path, "w") as f:
        json.dump(record, f)
    rc = run_host(["cancel", entry["snap"], record_path],
                  entry["out"], entry["log"], entry["env"])
    entry["rc"] = rc
    refresh(run_id)
    return rc


def cancel_tree(run_id, reason, trigger):
    """Cancel a run and its whole subtree, deepest first. Descendants
    get trigger 'parent cancelled'; the top run keeps the caller's
    trigger. Returns the run ids cancelled, self last."""
    cancelled = []
    entry = RUNS.get(run_id)
    if entry is None or entry["rc"] not in (2, 3):
        return cancelled
    direct = []
    for fork in forks_of(prefix_for(run_id) + ".journal"):
        for child in fork.get("childRuns", []):
            if child in RUNS and RUNS[child]["rc"] in (2, 3):
                cancelled.extend(cancel_tree(child, reason,
                                             "parent cancelled"))
                direct.append(child)
    rc = cancel_run(run_id, reason, trigger, cancelled=direct)
    if rc is not None:
        cancelled.append(run_id)
    return cancelled


def snap_untouched(snap, before):
    if sha(snap) != before:
        fail(f"{snap} changed while children ran "
             f"(parent snapshot not untouched)")
        return False
    return True


def out_lines(run_id):
    with open(RUNS[run_id]["out"]) as f:
        return f.read().splitlines()


def check_cancel_event(events, run_id, what, trigger, reason, **extra):
    """Exactly one cancel event in `events`, with the Q14 fields (what
    / when / why / trigger) plus `extra`. Returns the event, or None
    (already reported via fail())."""
    cancels = [e for e in events if e.get("type") == "cancel"]
    if len(cancels) != 1:
        fail(f"{run_id}: expected 1 cancel event, got {len(cancels)}: "
             f"{events}")
        return None
    c = cancels[0]
    if c.get("what") != what:
        fail(f"{run_id}: cancel what {c.get('what')} != {what}: {c}")
    if c.get("trigger") != trigger:
        fail(f"{run_id}: cancel trigger {c.get('trigger')} != "
             f"{trigger}: {c}")
    if c.get("reason") != reason:
        fail(f"{run_id}: cancel reason {c.get('reason')} != {reason}: "
             f"{c}")
    when = c.get("when")
    if not isinstance(when, int) or when <= 0:
        fail(f"{run_id}: cancel when missing or not a positive "
             f"integer: {c}")
    for k, v in extra.items():
        if c.get(k) != v:
            fail(f"{run_id}: cancel {k} {c.get(k)} != {v}: {c}")
    return c


def test_cancel_step():
    print("\n=== 1. cancel a pending step ===")
    run_id = "run-cancel-step"
    rc = start_run("workflow-cancel-step.ts", run_id)
    if rc != 2:
        fail(f"cancel-step: run exited {rc}, expected 2 (suspended "
             f"at the step)")
        return
    rc = cancel_run(run_id, "user abort", "user abort")
    if rc != 0:
        fail(f"cancel-step: cancelled run exited {rc}, expected 0")
        return
    lines = out_lines(run_id)
    for want in ("caught: CancellationError: user abort",
                 "caught is Error: true", "finally ran",
                 "done, caught: CancellationError: user abort"):
        if want not in lines:
            fail(f"cancel-step: missing output line {want!r}: {lines}")
    if any(l.startswith("got:") for l in lines):
        fail(f"cancel-step: the step returned a value after being "
             f"cancelled: {lines}")
    events = read_journal(prefix_for(run_id) + ".journal")
    steps = [e for e in events if e.get("type") == "step"]
    if len(steps) != 1 or steps[0].get("ordinal") != 0:
        fail(f"cancel-step: expected 1 step event (ordinal 0), got "
             f"{steps}")
    if any(e.get("type") in ("step-result", "step-error")
           for e in events):
        fail(f"cancel-step: a step-result/step-error appeared for a "
             f"cancelled step: {events}")
    c = check_cancel_event(events, run_id, "step", "user abort",
                           "user abort", ordinal=0)
    if c is not None:
        step_i = events.index(steps[0])
        if events.index(c) < step_i:
            fail("cancel-step: cancel event precedes the step event — "
                 "the cancellation was recorded before the dispatch")
        else:
            print("CANCEL EVENT OK: step ordinal 0, trigger 'user "
                  "abort', reason 'user abort', when recorded")
    print("CATCH OK: CancellationError at the call site, real Error, "
          "finally ran")


def test_cancel_combinator():
    print("\n=== 2. cancel a whole all() in flight ===")
    run_id = "run-cancel-combinator"
    rc = start_run("workflow-cancel-combinator.ts", run_id)
    if rc != 3:
        fail(f"cancel-combinator: run exited {rc}, expected 3 "
             f"(suspended at a combinator)")
        return
    env = RUNS[run_id]["env"]
    snap = RUNS[run_id]["snap"]
    fork = last_fork(prefix_for(run_id) + ".journal")
    fork_id = fork["forkId"]
    children = fork["childRuns"]
    before = sha(snap)
    for i, child in enumerate(children):
        crc = start_branch(child, snap, i, env, fork_id)
        if crc != 2:
            fail(f"cancel-combinator: child {child} exited {crc}, "
                 f"expected 2 (suspended at its first step)")
            return
    if not snap_untouched(snap, before):
        return
    cancelled = cancel_tree(run_id, "user abort", "user abort")
    if cancelled != children + [run_id]:
        fail(f"cancel-combinator: cancelled order {cancelled} != "
             f"{children + [run_id]} (children first, parent last)")
    if RUNS[run_id]["rc"] != 0:
        fail(f"cancel-combinator: parent exited "
             f"{RUNS[run_id]['rc']}, expected 0")
        return
    lines = out_lines(run_id)
    for want in ("caught: CancellationError", "caught is Error: true",
                 "finally ran", "done, caught: CancellationError"):
        if want not in lines:
            fail(f"cancel-combinator: missing output line {want!r}: "
                 f"{lines}")
    if any(l.startswith("verdicts:") for l in lines):
        fail("cancel-combinator: the all() returned verdicts after "
             f"being cancelled: {lines}")
    events = read_journal(prefix_for(run_id) + ".journal")
    if any(e.get("type") == "join" for e in events):
        fail("cancel-combinator: a join event appeared — the cancelled "
             "fork spuriously joined")
    check_cancel_event(events, run_id, "fork", "user abort",
                       "user abort", forkId=fork_id,
                       cancelled=children)
    for i, child in enumerate(children):
        cevents = read_journal(prefix_for(child) + ".journal")
        starts = [e for e in cevents
                  if e.get("type") == "branch-start"]
        dones = [e for e in cevents
                 if e.get("type") == "branch-done"]
        if len(starts) != 1 or starts[0].get("parentForkId") != fork_id:
            fail(f"cancel-combinator: child {child} branch-start "
                 f"missing/wrong parentForkId: {starts}")
        check_cancel_event(cevents, child, "step", "parent cancelled",
                           "user abort", ordinal=0, parentForkId=fork_id,
                           branch=i)
        if len(dones) != 1:
            fail(f"cancel-combinator: child {child} expected 1 "
                 f"branch-done, got {len(dones)}: {cevents}")
        elif dones[0].get("outcome") != {
                "ok": True, "value": "cancelled:CancellationError"}:
            fail(f"cancel-combinator: child {child} outcome != "
                 f"cancelled-cleanly: {dones[0].get('outcome')}")
        else:
            print(f"CHILD OK: {child} caught its cancellation and "
                  f"returned 'cancelled:CancellationError'")
    print("PARENT OK: CancellationError at the all() call site, "
          "finally ran; no join event")


def test_sticky():
    print("\n=== 3. sticky cancellation ===")
    run_id = "run-sticky"
    rc = start_run("workflow-sticky.ts", run_id)
    if rc != 2:
        fail(f"sticky: run exited {rc}, expected 2 (suspended at the "
             f"step)")
        return
    rc = cancel_run(run_id, "user abort", "user abort")
    if rc != 0:
        fail(f"sticky: cancelled run exited {rc}, expected 0 (the "
             f"workflow must not suspend again)")
        return
    lines = out_lines(run_id)
    for want in ("caught: CancellationError", "finally ran",
                 "second threw: CancellationError",
                 "all threw: CancellationError", "done"):
        if want not in lines:
            fail(f"sticky: missing output line {want!r}: {lines}")
    if any(l.startswith("ERROR:") for l in lines):
        fail(f"sticky: a call after the cancel dispatched anyway: "
             f"{lines}")
    else:
        print("STICKY OK: the second step() and the all() both threw "
              "at once — neither dispatched")
    events = read_journal(prefix_for(run_id) + ".journal")
    steps = [e for e in events if e.get("type") == "step"]
    if len(steps) != 1 or steps[0].get("ordinal") != 0:
        fail(f"sticky: expected exactly 1 step event (ordinal 0), got "
             f"{steps}")
    if any(e.get("type") == "fork" for e in events):
        fail(f"sticky: a fork event appeared — the all() after the "
             f"cancel forked: {events}")
    check_cancel_event(events, run_id, "step", "user abort",
                       "user abort", ordinal=0)


def test_race_order():
    # Scenario A: result-first — the result lands, then the cancel.
    print("\n=== 4a. cancel-vs-complete race: result first ===")
    run_id = "run-race-a"
    rc = start_run("workflow-race-order.ts", run_id)
    if rc != 2:
        fail(f"race-a: run exited {rc}, expected 2 (suspended at the "
             f"first step)")
        return
    step_input = last_step_input(RUNS[run_id]["log"])
    if step_input is None:
        fail("race-a: no step input in the log")
        return
    rc = deliver_result(run_id, mock_result(step_input))
    if rc != 2:
        fail(f"race-a: after the first result the run exited {rc}, "
             f"expected 2 (suspended at the second step)")
        return
    rc = cancel_run(run_id, "user abort", "user abort")
    if rc != 0:
        fail(f"race-a: cancelled run exited {rc}, expected 0")
        return
    lines = out_lines(run_id)
    for want in ('first got: {"score":0.92,"label":"approved"}',
                 "first finally ran",
                 "second threw: CancellationError",
                 "second finally ran", "done"):
        if want not in lines:
            fail(f"race-a: missing output line {want!r}: {lines}")
    events = read_journal(prefix_for(run_id) + ".journal")
    results = [e for e in events if e.get("type") == "step-result"]
    cancels = [e for e in events if e.get("type") == "cancel"]
    if len(results) != 1 or results[0].get("ordinal") != 0:
        fail(f"race-a: expected 1 step-result (ordinal 0), got "
             f"{results}")
    elif len(cancels) != 1:
        fail(f"race-a: expected 1 cancel event, got {len(cancels)}: "
             f"{events}")
    elif events.index(results[0]) > events.index(cancels[0]):
        fail("race-a: the cancel event precedes the step-result — the "
             "result did not win the race in the journal")
    elif cancels[0].get("ordinal") != 1:
        fail(f"race-a: cancel ordinal {cancels[0].get('ordinal')} != 1")
    else:
        print("RACE OK (result-first): the first result is kept — the "
              "step-result is recorded before the cancel event")

    # Scenario B: cancel-first — the cancel lands, no result arrives.
    print("\n=== 4b. cancel-vs-complete race: cancel first ===")
    run_id = "run-race-b"
    rc = start_run("workflow-race-order.ts", run_id)
    if rc != 2:
        fail(f"race-b: run exited {rc}, expected 2 (suspended at the "
             f"first step)")
        return
    rc = cancel_run(run_id, "user abort", "user abort")
    if rc != 0:
        fail(f"race-b: cancelled run exited {rc}, expected 0 (sticky: "
             f"the second step must throw at once, not suspend)")
        return
    lines = out_lines(run_id)
    for want in ("first threw: CancellationError", "first finally ran",
                 "second threw: CancellationError",
                 "second finally ran", "done"):
        if want not in lines:
            fail(f"race-b: missing output line {want!r}: {lines}")
    if any("got:" in l for l in lines):
        fail(f"race-b: a step returned a value after the cancel: "
             f"{lines}")
    else:
        print("RACE OK (cancel-first): no result ever landed, and the "
              "second step threw at once (sticky)")
    events = read_journal(prefix_for(run_id) + ".journal")
    if any(e.get("type") == "step-result" for e in events):
        fail(f"race-b: a step-result appeared for a cancelled step: "
             f"{events}")
    steps = [e for e in events if e.get("type") == "step"]
    if len(steps) != 1 or steps[0].get("ordinal") != 0:
        fail(f"race-b: expected exactly 1 step event (ordinal 0) — "
             f"the second step never dispatched: {steps}")
    check_cancel_event(events, run_id, "step", "user abort",
                       "user abort", ordinal=0)


def test_nested_cancel():
    print("\n=== 5. nested propagation (cancel the whole tree) ===")
    run_id = "run-nested-cancel"
    rc = start_run("workflow-nested-cancel.ts", run_id)
    if rc != 3:
        fail(f"nested-cancel: run exited {rc}, expected 3 (suspended "
             f"at a combinator)")
        return
    env = RUNS[run_id]["env"]
    snap = RUNS[run_id]["snap"]
    fork = last_fork(prefix_for(run_id) + ".journal")
    fork_id = fork["forkId"]
    children = fork["childRuns"]
    before = sha(snap)
    # Branch 0 fans out again: it suspends at its own all() (exit 3).
    rc0 = start_branch(children[0], snap, 0, env, fork_id)
    if rc0 != 3:
        fail(f"nested-cancel: branch 0 exited {rc0}, expected 3 "
             f"(suspended at its own all())")
        return
    b0_snap = RUNS[children[0]]["snap"]
    before0 = sha(b0_snap)
    fork0 = last_fork(prefix_for(children[0]) + ".journal")
    fork0_id = fork0["forkId"]
    grandchildren = fork0["childRuns"]
    for i, gc in enumerate(grandchildren):
        crc = start_branch(gc, b0_snap, i, RUNS[children[0]]["env"],
                           fork0_id)
        if crc != 2:
            fail(f"nested-cancel: grandchild {gc} exited {crc}, "
                 f"expected 2 (suspended at its step)")
            return
    if not snap_untouched(b0_snap, before0):
        return
    # Branch 1 suspends at its step.
    rc1 = start_branch(children[1], snap, 1, env, fork_id)
    if rc1 != 2:
        fail(f"nested-cancel: branch 1 exited {rc1}, expected 2 "
             f"(suspended at its step)")
        return
    if not snap_untouched(snap, before):
        return
    cancelled = cancel_tree(run_id, "user abort", "user abort")
    expected = grandchildren + [children[0], children[1], run_id]
    if cancelled != expected:
        fail(f"nested-cancel: cancelled order {cancelled} != "
             f"{expected} (deepest first, parent last)")
    if RUNS[run_id]["rc"] != 0:
        fail(f"nested-cancel: parent exited {RUNS[run_id]['rc']}, "
             f"expected 0")
        return
    lines = out_lines(run_id)
    for want in ("caught: CancellationError", "finally ran",
                 "done, caught: CancellationError"):
        if want not in lines:
            fail(f"nested-cancel: missing output line {want!r}: {lines}")
    if any(l.startswith("verdicts:") for l in lines):
        fail("nested-cancel: the parent all() returned verdicts after "
             f"being cancelled: {lines}")
    events = read_journal(prefix_for(run_id) + ".journal")
    if any(e.get("type") == "join" for e in events):
        fail("nested-cancel: a join event appeared in the parent "
             "journal — the cancelled fork spuriously joined")
    check_cancel_event(events, run_id, "fork", "user abort",
                       "user abort", forkId=fork_id,
                       cancelled=children)
    # Branch 0: cancelled at its own fork; its outcome is a failed
    # CancellationError (it does not catch); no join in its journal.
    b0_events = read_journal(prefix_for(children[0]) + ".journal")
    if any(e.get("type") == "join" for e in b0_events):
        fail("nested-cancel: a join event appeared in branch 0's "
             "journal — its cancelled fork spuriously joined")
    check_cancel_event(b0_events, children[0], "fork",
                       "parent cancelled", "user abort",
                       forkId=fork0_id, cancelled=grandchildren,
                       parentForkId=fork_id, branch=0)
    b0_dones = [e for e in b0_events if e.get("type") == "branch-done"]
    if len(b0_dones) != 1:
        fail(f"nested-cancel: branch 0 expected 1 branch-done, got "
             f"{len(b0_dones)}: {b0_events}")
    elif b0_dones[0].get("outcome") != {
            "ok": False,
            "error": {"name": "CancellationError",
                      "message": "user abort"}}:
        fail(f"nested-cancel: branch 0 outcome != failed "
             f"CancellationError: {b0_dones[0].get('outcome')}")
    else:
        print("BRANCH 0 OK: cancelled at its own fork, failed outcome "
              "is a CancellationError, no join")
    # Branch 1: caught its cancellation, returned cleanly.
    b1_events = read_journal(prefix_for(children[1]) + ".journal")
    check_cancel_event(b1_events, children[1], "step",
                       "parent cancelled", "user abort", ordinal=0,
                       parentForkId=fork_id, branch=1)
    b1_dones = [e for e in b1_events if e.get("type") == "branch-done"]
    if len(b1_dones) != 1:
        fail(f"nested-cancel: branch 1 expected 1 branch-done, got "
             f"{len(b1_dones)}: {b1_events}")
    elif b1_dones[0].get("outcome") != {
            "ok": True, "value": "cancelled:CancellationError"}:
        fail(f"nested-cancel: branch 1 outcome != cancelled-cleanly: "
             f"{b1_dones[0].get('outcome')}")
    else:
        print("BRANCH 1 OK: caught its cancellation, returned "
              "'cancelled:CancellationError'")
    # Grandchildren: cancelled at their steps, uncaught, failed
    # CancellationError outcomes.
    for i, gc in enumerate(grandchildren):
        gc_events = read_journal(prefix_for(gc) + ".journal")
        check_cancel_event(gc_events, gc, "step", "parent cancelled",
                           "user abort", ordinal=0,
                           parentForkId=fork0_id, branch=i)
        gc_dones = [e for e in gc_events
                    if e.get("type") == "branch-done"]
        if len(gc_dones) != 1:
            fail(f"nested-cancel: grandchild {gc} expected 1 "
                 f"branch-done, got {len(gc_dones)}: {gc_events}")
        elif gc_dones[0].get("outcome") != {
                "ok": False,
                "error": {"name": "CancellationError",
                          "message": "user abort"}}:
            fail(f"nested-cancel: grandchild {gc} outcome != failed "
                 f"CancellationError: {gc_dones[0].get('outcome')}")
        else:
            print(f"GRANDCHILD OK: {gc} cancelled at its step, failed "
                  f"outcome is a CancellationError")
    print("TREE OK: every journal (parent, both branches, both "
          "grandchildren) records exactly one cancel event")


def main():
    os.chdir(DIR)
    for pat in ("run-cancel-*", "run-sticky*", "run-race-*",
                "run-nested-cancel*"):
        for f in glob.glob(pat):
            if os.path.isfile(f):
                os.remove(f)
    r = subprocess.run(["make", "host"], capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr)
        fail("build failed")
        return 1
    print("host built OK")

    test_cancel_step()
    test_cancel_combinator()
    test_sticky()
    test_race_order()
    test_nested_cancel()

    print()
    if FAILURES:
        print(f"FAIL ({len(FAILURES)} check(s)):")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("PASS cancellation (pending step + whole combinator + "
          "sticky + race both orders + nested tree)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
