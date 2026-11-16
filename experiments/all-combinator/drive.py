#!/usr/bin/env python3
"""Driver + checks for the combinator experiment (Linear BRA-24,
BRA-25, BRA-26): all() collect-all + fail-fast bool, any(), race().

Drives fork/direct test pairs through the host, forking branch
children from the journal's fork events and joining them, then checks:
  - the parent's stdout is byte-identical to the straight-through
    reference's stdout;
  - the outcome objects have the Q13 shape, with a failed branch as
    { ok: false, error };
  - the journal has the fork event (fork id, kind, branch count, child
    run ids) and the join event (the outcome) in the parent journal, and
    each child journal records the parent fork id;
  - the parent snapshot is untouched by the children;
  - nested all() works, and a branch write to shared state is discarded;
  - fail-fast: all([...], true) returns bare values on success and
    throws the first branch error at the call site; the parent catches
    it, its finally block runs, and it keeps working; the join event
    records the thrown error and which branch failed first, and each
    cancelled sibling's journal records a cancellation event with the
    Q13 trigger; firstness is journal order;
  - any(): the first success wins (bare value), the rest are cancelled
    with trigger "loser in any"; if every branch fails, an
    AggregateError holding all branch errors in branch order is thrown
    at the call site; any([]) throws an AggregateError with no errors
    immediately, with no fork;
  - race(): the first settler wins — bare value on success, its error
    thrown on failure — the rest are cancelled with trigger "loser in
    race"; race([]) never settles, tested with a bounded drive that
    confirms no resolution and no crash.

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
    ("score", 5): {"score": 0.63, "label": "approved"},
    ("score", 9): {"score": 0.31, "label": "slow"},
    ("score", 11): {"score": 0.90, "label": "approved"},
    ("score", 12): {"score": 0.85, "label": "approved"},
    ("score", 21): {"score": 0.21, "label": "g21"},
    ("score", 22): {"score": 0.22, "label": "g22"},
    ("score", 23): {"score": 0.23, "label": "g23"},
}

FAILURES = []


def fail(msg):
    print(f"FAIL: {msg}")
    FAILURES.append(msg)


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def mock_result(step_input):
    op = step_input.get("op")
    if op == "aggregate":
        verdicts = step_input.get("verdicts", [])
        ok = sum(1 for v in verdicts if v.get("ok"))
        failed = len(verdicts) - ok
        return {"approved": ok, "failed": failed,
                "summary": f"{ok} approved, {failed} failed"}
    key = (op, step_input.get("value"))
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


def record_cancel(child, fork_id, branch, trigger, extra=None):
    """Write a cancellation event into a cancelled sibling's journal.
    The scheduler (this driver) is what cancels it: in this experiment
    the driver runs branches sequentially, so at the moment the
    cancellation is decided no sibling process is live — the
    cancellation is the scheduler refusing to (re)spawn the remaining
    siblings, recorded here; in the real engine the same decision kills
    live child processes (Q14)."""
    event = {"type": "cancel", "runId": child, "parentForkId": fork_id,
             "branch": branch, "trigger": trigger}
    if extra:
        event.update(extra)
    with open(prefix_for(child) + ".journal", "a") as f:
        f.write(json.dumps(event) + "\n")


def prefix_for(run_id):
    return run_id.replace("/", "_")


def run_host(args, out_path, log_path, env_extra):
    env = dict(os.environ)
    env.update(env_extra)
    with open(out_path, "a") as out, open(log_path, "a") as log:
        r = subprocess.run([HOST] + args, stdout=out, stderr=log, env=env)
    return r.returncode


def run_one_branch(children, i, snap, env, fork_id):
    """Spawn branch i as a child process and drive it to completion.
    Returns (outcome dict, outcome file path), or (None, None) on
    failure (already reported via fail())."""
    child = children[i]
    cprefix = prefix_for(child)
    csnap = cprefix + ".snap"
    cout, clog = cprefix + ".out", cprefix + ".log"
    coutcome = cprefix + ".outcome.json"
    shutil.copy(snap, csnap)
    open(cout, "w").close()
    open(clog, "w").close()
    cenv = dict(env)
    cenv.update({"AGENTTS_RUN_ID": child,
                 "AGENTTS_JOURNAL": cprefix + ".journal",
                 "AGENTTS_OUTCOME": coutcome,
                 "AGENTTS_PARENT_FORK": fork_id})
    crc = run_host(["branch", csnap, str(i)], cout, clog, cenv)
    crc = drive(csnap, cout, clog, crc, child)
    if crc != 0:
        fail(f"branch {child} exited {crc}")
        return None, None
    if not os.path.exists(coutcome):
        fail(f"no outcome file for {child}")
        return None, None
    return json.load(open(coutcome)), coutcome


def snap_untouched(snap, before):
    if sha(snap) != before:
        fail(f"{snap} changed while children ran "
             f"(parent snapshot not untouched)")
        return False
    return True


def do_all_join(snap, out_path, log_path, env, fork):
    """Join an all() fork (collect-all, or fail-fast on the bool).
    Returns the exit code of the join invocation."""
    prefix = prefix_for(fork["runId"])
    fork_id = fork["forkId"]
    children = fork["childRuns"]
    fail_fast = bool(fork.get("failFast"))
    before = sha(snap)
    outcomes = []
    completed = []
    failed_branch = None
    failed_error = None
    cancelled = []
    for i, child in enumerate(children):
        outcome, coutcome = run_one_branch(children, i, snap, env,
                                           fork_id)
        if outcome is None:
            return 1
        completed.append(outcome)
        outcomes.append(coutcome)
        if fail_fast and not outcome.get("ok"):
            failed_branch = i
            failed_error = outcome.get("error")
            for j in range(i + 1, len(children)):
                cancelled.append(j)
                record_cancel(children[j], fork_id, j,
                              "sibling failed with fail-fast on",
                              {"failedBranch": failed_branch,
                               "error": failed_error})
            break
    if not snap_untouched(snap, before):
        return 1
    if fail_fast and failed_branch is not None:
        record = {"failedBranch": failed_branch,
                  "error": failed_error,
                  "cancelled": cancelled,
                  "completed": completed[:-1]}
        record_path = prefix + ".join-throw.json"
        with open(record_path, "w") as f:
            json.dump(record, f)
        return run_host(["join-throw", snap, record_path],
                        out_path, log_path, env)
    if fail_fast:
        # Success: the parent gets bare values, in order.
        value_files = []
        for k, outcome in enumerate(completed):
            vpath = f"{prefix}.join-value-{k}.json"
            with open(vpath, "w") as f:
                json.dump(outcome["value"], f)
            value_files.append(vpath)
        return run_host(["join", snap] + value_files,
                        out_path, log_path, env)
    return run_host(["join", snap] + outcomes, out_path, log_path, env)


def do_any_join(snap, out_path, log_path, env, fork):
    """Join an any() fork. The first success wins (bare value, the rest
    cancelled with trigger "loser in any"); if every branch fails, the
    parent is resumed with an AggregateError of all branch errors in
    branch order. Returns the exit code of the join invocation."""
    fork_id = fork["forkId"]
    children = fork["childRuns"]
    before = sha(snap)
    errors = []
    completed = []
    for i, child in enumerate(children):
        outcome, _ = run_one_branch(children, i, snap, env, fork_id)
        if outcome is None:
            return 1
        if outcome.get("ok"):
            cancelled = []
            for j in range(i + 1, len(children)):
                cancelled.append(j)
                record_cancel(children[j], fork_id, j, "loser in any",
                              {"winner": i})
            if not snap_untouched(snap, before):
                return 1
            record = {"value": outcome["value"], "winner": i,
                      "cancelled": cancelled, "completed": completed}
            record_path = prefix_for(fork_id) + ".join-value.json"
            with open(record_path, "w") as f:
                json.dump(record, f)
            return run_host(["join-value", snap, record_path],
                            out_path, log_path, env)
        errors.append(outcome.get("error"))
        completed.append(outcome)
    # Every branch failed: throw an AggregateError of all errors.
    if not snap_untouched(snap, before):
        return 1
    record = {"errors": errors, "completed": completed, "cancelled": []}
    record_path = prefix_for(fork_id) + ".join-aggregate.json"
    with open(record_path, "w") as f:
        json.dump(record, f)
    return run_host(["join-aggregate", snap, record_path],
                    out_path, log_path, env)


def do_race_join(snap, out_path, log_path, env, fork):
    """Join a race() fork. The first settler wins — its bare value on
    success (join-value), its error thrown on failure (join-throw) —
    and the rest are cancelled with trigger "loser in race". In this
    experiment the driver runs branches sequentially, so the first
    branch is always the first settler. Returns the exit code of the
    join invocation."""
    fork_id = fork["forkId"]
    children = fork["childRuns"]
    before = sha(snap)
    outcome, _ = run_one_branch(children, 0, snap, env, fork_id)
    if outcome is None:
        return 1
    cancelled = []
    for j in range(1, len(children)):
        cancelled.append(j)
        record_cancel(children[j], fork_id, j, "loser in race",
                      {"winner": 0})
    if not snap_untouched(snap, before):
        return 1
    if outcome.get("ok"):
        record = {"value": outcome["value"], "winner": 0,
                  "cancelled": cancelled, "completed": []}
        record_path = prefix_for(fork_id) + ".join-value.json"
        with open(record_path, "w") as f:
            json.dump(record, f)
        return run_host(["join-value", snap, record_path],
                        out_path, log_path, env)
    record = {"failedBranch": 0, "error": outcome.get("error"),
              "cancelled": cancelled, "completed": []}
    record_path = prefix_for(fork_id) + ".join-throw.json"
    with open(record_path, "w") as f:
        json.dump(record, f)
    return run_host(["join-throw", snap, record_path],
                    out_path, log_path, env)


def drive(snap, out_path, log_path, rc, run_id, allow_unresolved=False):
    """Drive one run to completion. rc is the exit code of the invocation
    that started it (2 = suspended at step, 3 = suspended at a
    combinator). allow_unresolved is only for the race([]) test: a
    0-branch fork never settles, so a bounded drive observes it still
    suspended instead of joining (an unbounded drive would hang the
    harness)."""
    prefix = prefix_for(run_id)
    journal = prefix + ".journal"
    env = {"AGENTTS_RUN_ID": run_id, "AGENTTS_JOURNAL": journal}
    rounds = 0
    while rc in (2, 3):
        rounds += 1
        if rounds > 50:
            fail(f"drive loop exceeded for {run_id}")
            return 1
        if rc == 2:
            step_input = last_step_input(log_path)
            if step_input is None:
                fail(f"no step input in {log_path} for {run_id}")
                return 1
            result = mock_result(step_input)
            rc = run_host(["resume", snap, json.dumps(result)],
                          out_path, log_path, env)
        else:  # rc == 3: suspended at a combinator; fork children, join
            fork = last_fork(journal)
            if fork is None:
                fail(f"no fork event in {journal} for {run_id}")
                return 1
            kind = fork.get("kind", "all")
            if not fork["childRuns"]:
                # A 0-branch fork (race([])) never settles: nothing to
                # spawn, nothing to join. Only a bounded drive may
                # observe it still suspended.
                if allow_unresolved:
                    return 3
                fail(f"fork {fork['forkId']} has no children and the "
                     f"drive is not bounded")
                return 1
            if kind == "all":
                rc = do_all_join(snap, out_path, log_path, env, fork)
            elif kind == "any":
                rc = do_any_join(snap, out_path, log_path, env, fork)
            elif kind == "race":
                rc = do_race_join(snap, out_path, log_path, env, fork)
            else:
                fail(f"unknown fork kind {kind!r} in {journal}")
                return 1
    return rc


def parse_out_lines(out_path):
    lines = {}
    with open(out_path) as f:
        for line in f:
            line = line.rstrip("\n")
            if ": " in line:
                key, val = line.split(": ", 1)
                lines[key] = val
    return lines


def check_journal_pair(name, journal_path, fork_id, branches, verdicts):
    events = read_journal(journal_path)
    forks = [e for e in events if e.get("type") == "fork"]
    joins = [e for e in events if e.get("type") == "join"]
    if len(forks) != 1:
        fail(f"{name}: expected 1 fork event, got {len(forks)}")
        return
    fork = forks[0]
    if fork.get("forkId") != fork_id:
        fail(f"{name}: fork id {fork.get('forkId')} != {fork_id}")
    if fork.get("kind") != "all" or fork.get("branches") != branches:
        fail(f"{name}: fork event kind/branches wrong: {fork}")
    if len(fork.get("childRuns", [])) != branches:
        fail(f"{name}: childRuns length != {branches}: {fork}")
    if len(joins) != 1:
        fail(f"{name}: expected 1 join event, got {len(joins)}")
        return
    if joins[0].get("forkId") != fork_id:
        fail(f"{name}: join fork id {joins[0].get('forkId')} != {fork_id}")
    if joins[0].get("outcome") != verdicts:
        fail(f"{name}: join outcome != verdicts:\n  "
             f"{joins[0].get('outcome')}\n  vs\n  {verdicts}")
    for i, child in enumerate(fork["childRuns"]):
        cjournal = prefix_for(child) + ".journal"
        cevents = read_journal(cjournal)
        starts = [e for e in cevents if e.get("type") == "branch-start"]
        dones = [e for e in cevents if e.get("type") == "branch-done"]
        if len(starts) != 1 or starts[0].get("parentForkId") != fork_id:
            fail(f"{name}: child {child} branch-start missing/wrong "
                 f"parentForkId: {starts}")
        if len(dones) != 1 or dones[0].get("parentForkId") != fork_id:
            fail(f"{name}: child {child} branch-done missing/wrong "
                 f"parentForkId: {dones}")
        elif dones[0].get("outcome") != verdicts[i]:
            fail(f"{name}: child {child} branch-done outcome != "
                 f"verdicts[{i}]: {dones[0].get('outcome')}")


def run_test(name, workflow, direct, run_id, branches):
    print(f"\n=== {name} ===")
    p = prefix_for(run_id)
    d = prefix_for(run_id + "-direct")
    for f in (p + ".snap", p + ".out", p + ".log", p + ".journal",
              d + ".snap", d + ".out", d + ".log", d + ".journal"):
        if os.path.exists(f):
            os.remove(f)

    # Straight-through reference.
    rc = run_host(["run", direct, d + ".snap"], d + ".out", d + ".log",
                  {"AGENTTS_RUN_ID": run_id + "-direct",
                   "AGENTTS_JOURNAL": d + ".journal"})
    rc = drive(d + ".snap", d + ".out", d + ".log", rc, run_id + "-direct")
    if rc != 0:
        fail(f"{name}: direct reference exited {rc}")
        return None
    print(f"--- direct output ---")
    print(open(d + ".out").read(), end="")

    # Fork version: the parent suspends at a combinator (exit 3).
    rc = run_host(["run", workflow, p + ".snap"], p + ".out", p + ".log",
                  {"AGENTTS_RUN_ID": run_id,
                   "AGENTTS_JOURNAL": p + ".journal"})
    if rc != 3:
        fail(f"{name}: parent run exited {rc}, expected 3 (suspended "
             f"at a combinator)")
        return None
    print(f"parent suspended at a combinator, snapshot "
          f"{os.path.getsize(p + '.snap')} bytes")
    rc = drive(p + ".snap", p + ".out", p + ".log", rc, run_id)
    if rc != 0:
        fail(f"{name}: parent exited {rc}")
        return None
    print(f"--- parent output ---")
    print(open(p + ".out").read(), end="")

    # Byte-compare parent output vs the straight-through reference.
    parent_out = open(p + ".out", "rb").read()
    direct_out = open(d + ".out", "rb").read()
    if parent_out == direct_out:
        print("OUTPUT MATCH: parent byte-identical to direct reference")
    else:
        fail(f"{name}: parent output differs from direct reference")
        print("--- diff ---")
        for a, b in zip(parent_out.decode().splitlines(),
                        direct_out.decode().splitlines()):
            if a != b:
                print(f"  parent: {a}\n  direct: {b}")
    return {"parent_out": p + ".out", "parent_journal": p + ".journal",
            "run_id": run_id, "branches": branches}


def test_judges():
    r = run_test("judges (3 simulated judges, one throws)",
                 "workflow-judges.ts", "workflow-judges-direct.ts",
                 "run-judges", 3)
    if r is None:
        return
    lines = parse_out_lines(r["parent_out"])
    verdicts = json.loads(lines["verdicts"])
    expected = [
        {"ok": True, "value": "approved/verified"},
        {"ok": True, "value": "weak/retried"},
        {"ok": False,
         "error": {"name": "Error", "message": "judge crashed"}},
    ]
    if verdicts != expected:
        fail(f"judges: verdicts != expected:\n  {verdicts}\n  vs\n  "
             f"{expected}")
    else:
        print("OUTCOMES OK: failed branch is { ok: false, error }")
    agg = json.loads(lines["aggregate"])
    if agg != {"approved": 2, "failed": 1,
               "summary": "2 approved, 1 failed"}:
        fail(f"judges: aggregate != expected: {agg}")
    else:
        print("AGGREGATE OK: 2 approved, 1 failed")
    check_journal_pair("judges", r["parent_journal"],
                       "run-judges/fork-0", 3, verdicts)


def test_global():
    r = run_test("global state (branch write discarded)",
                 "workflow-global.ts", "workflow-global-direct.ts",
                 "run-global", 3)
    if r is None:
        return
    lines = parse_out_lines(r["parent_out"])
    verdicts = json.loads(lines["verdicts"])
    expected = [
        {"ok": True, "value": "read:0"},
        {"ok": True, "value": "read:99"},
        {"ok": True, "value": "read:0"},
    ]
    if verdicts != expected:
        fail(f"global: verdicts != expected:\n  {verdicts}\n  vs\n  "
             f"{expected}")
    else:
        print("GLOBAL READ OK: branches saw fork-time sharedCount=0; "
              "the writing branch read its own 99")
    if lines.get("empty all") != "[]":
        fail(f"global: all([]) != []: {lines.get('empty all')}")
    else:
        print("EMPTY all([]) OK: [] with no fork")
    if lines.get("sharedCount after join") != "0":
        fail("global: sharedCount after join != 0: "
             f"{lines.get('sharedCount after join')}")
    else:
        print("GLOBAL WRITE DISCARDED OK: parent sharedCount still 0")
    check_journal_pair("global", r["parent_journal"],
                       "run-global/fork-0", 3, verdicts)


def test_nested():
    r = run_test("nested all() (branch fans out again)",
                 "workflow-nested.ts", "workflow-nested-direct.ts",
                 "run-nested", 2)
    if r is None:
        return
    lines = parse_out_lines(r["parent_out"])
    verdicts = json.loads(lines["verdicts"])
    nested = [{"ok": True, "value": "approved"},
              {"ok": True, "value": "approved"}]
    expected = [
        {"ok": True,
         "value": "approved/nested=" + json.dumps(nested,
                                                   separators=(",", ":"))},
        {"ok": True, "value": "weak/retried"},
    ]
    if verdicts != expected:
        fail(f"nested: verdicts != expected:\n  {verdicts}\n  vs\n  "
             f"{expected}")
    else:
        print("NESTED OK: branch 0 joined its own sub-judges")
    check_journal_pair("nested", r["parent_journal"],
                       "run-nested/fork-0", 2, verdicts)
    # The nested fork lives in branch 0's journal.
    nested_fork = "run-nested/fork-0/branch-0/fork-0"
    b0_journal = "run-nested_fork-0_branch-0.journal"
    check_journal_pair("nested-inner", b0_journal, nested_fork, 2, nested)


def test_failfast():
    r = run_test("fail-fast bool on all()",
                 "workflow-failfast.ts", "workflow-failfast-direct.ts",
                 "run-failfast", 3)
    if r is None:
        return
    out_lines = open(r["parent_out"]).read().splitlines()
    lines = parse_out_lines(r["parent_out"])

    values = json.loads(lines["values"])
    if values != ["approved/verified", "weak/retried"]:
        fail(f"fail-fast: values != bare values in order: {values}")
    else:
        print("FAIL-FAST SUCCESS OK: bare values in order")

    collected = json.loads(lines["collected false"])
    expected_collected = [
        {"ok": True, "value": "approved/verified"},
        {"ok": False,
         "error": {"name": "Error", "message": "judge crashed"}},
    ]
    if collected != expected_collected:
        fail(f"fail-fast: collected false != collect-all outcomes:\n  "
             f"{collected}\n  vs\n  {expected_collected}")
    else:
        print("EXPLICIT FALSE OK: all([...], false) is collect-all")

    if lines.get("caught is Error") != "true":
        fail("fail-fast: caught error is not a rehydrated Error: "
             f"{lines.get('caught is Error')}")
    else:
        print("REHYDRATION OK: caught value is a real Error")
    if "finally ran" not in out_lines:
        fail("fail-fast: finally block did not run after the throw")
    else:
        print("FINALLY OK: finally block ran after the throw")
    if lines.get("caught") != "judge crashed":
        fail(f"fail-fast: caught != 'judge crashed': {lines.get('caught')}")
    else:
        print("CATCH OK: parent caught the first branch error")
    continued = json.loads(lines["continued"])
    if continued != {"score": 0.9, "label": "approved"}:
        fail(f"fail-fast: parent did not continue after the catch: "
             f"{continued}")
    else:
        print("CONTINUE OK: parent called a further step after catching")
    if lines.get("first failure") != "judge timed out":
        fail("fail-fast: first failure != branch 1's error "
             f"('judge timed out'): {lines.get('first failure')}")
    else:
        print("FIRSTNESS OK: the first failure's error was thrown, "
              "not the later one")

    check_failfast_journal(r["parent_journal"], "run-failfast")


def check_failfast_journal(journal_path, run_id):
    events = read_journal(journal_path)
    forks = [e for e in events if e.get("type") == "fork"]
    joins = [e for e in events if e.get("type") == "join"]
    if len(forks) != 4 or len(joins) != 4:
        fail(f"fail-fast journal: expected 4 forks + 4 joins, got "
             f"{len(forks)} + {len(joins)}")
        return
    # fork-0: fail-fast success — join outcome is the bare values.
    if forks[0].get("failFast") is not True:
        fail(f"fail-fast journal: fork-0 failFast != true: {forks[0]}")
    if joins[0].get("outcome") != ["approved/verified", "weak/retried"]:
        fail(f"fail-fast journal: fork-0 join outcome != bare values: "
             f"{joins[0].get('outcome')}")
    else:
        print("JOURNAL OK: fork-0 join recorded the bare values")
    # fork-1: explicit false — collect-all, failFast recorded false.
    if forks[1].get("failFast") is not False:
        fail(f"fail-fast journal: fork-1 failFast != false: {forks[1]}")
    if joins[1].get("outcome") != [
            {"ok": True, "value": "approved/verified"},
            {"ok": False,
             "error": {"name": "Error", "message": "judge crashed"}}]:
        fail(f"fail-fast journal: fork-1 join outcome != outcomes: "
             f"{joins[1].get('outcome')}")
    else:
        print("JOURNAL OK: fork-1 join recorded the outcome objects")
    # fork-2: throw + catch — join records the error + failed branch.
    j2 = joins[2]
    if j2.get("failedBranch") != 1:
        fail(f"fail-fast journal: fork-2 failedBranch != 1: {j2}")
    if j2.get("error") != {"name": "Error", "message": "judge crashed"}:
        fail(f"fail-fast journal: fork-2 error wrong: {j2}")
    if j2.get("cancelled") != [2]:
        fail(f"fail-fast journal: fork-2 cancelled != [2]: {j2}")
    if j2.get("completed") != [{"ok": True, "value": "approved/verified"}]:
        fail(f"fail-fast journal: fork-2 completed wrong: {j2}")
    else:
        print("JOURNAL OK: fork-2 join recorded the thrown error, "
              "failed branch 1, cancelled [2]")
    # fork-3: firstness — branch 1's error wins, branch 2 cancelled.
    j3 = joins[3]
    if j3.get("failedBranch") != 1:
        fail(f"fail-fast journal: fork-3 failedBranch != 1: {j3}")
    if j3.get("error") != {"name": "Error", "message": "judge timed out"}:
        fail(f"fail-fast journal: fork-3 error wrong: {j3}")
    if j3.get("cancelled") != [2]:
        fail(f"fail-fast journal: fork-3 cancelled != [2]: {j3}")
    else:
        print("JOURNAL OK: fork-3 join recorded branch 1's error "
              "('judge timed out'), cancelled [2]")
    # Each cancelled sibling's journal: exactly one cancel event with
    # the Q13 trigger — and no branch-start: it never ran.
    for fork_i, failed_msg in ((2, "judge crashed"),
                               (3, "judge timed out")):
        fork_id = f"{run_id}/fork-{fork_i}"
        child = f"{fork_id}/branch-2"
        cevents = read_journal(prefix_for(child) + ".journal")
        cancels = [e for e in cevents if e.get("type") == "cancel"]
        starts = [e for e in cevents if e.get("type") == "branch-start"]
        if len(cancels) != 1:
            fail(f"fail-fast journal: {child} expected 1 cancel event, "
                 f"got {len(cancels)}: {cevents}")
            continue
        c = cancels[0]
        if (c.get("parentForkId") != fork_id
                or c.get("trigger") != "sibling failed with fail-fast on"
                or c.get("failedBranch") != 1
                or c.get("error") != {"name": "Error",
                                      "message": failed_msg}):
            fail(f"fail-fast journal: {child} cancel event wrong: {c}")
        elif starts:
            fail(f"fail-fast journal: {child} was cancelled but ran "
                 f"anyway (branch-start present): {starts}")
        else:
            print(f"JOURNAL OK: {child} cancelled before starting, "
                  f"trigger recorded")


def test_any():
    r = run_test("any (first success wins; all-fail throws AggregateError)",
                 "workflow-any.ts", "workflow-any-direct.ts",
                 "run-any", 3)
    if r is None:
        return
    lines = parse_out_lines(r["parent_out"])
    if lines.get("winner") != "approved/verified":
        fail(f"any: winner != first success's bare value: "
             f"{lines.get('winner')}")
    else:
        print("ANY SUCCESS OK: first success wins, bare value")
    if lines.get("all-fail is AggregateError") != "true":
        fail("any: all-fail caught value is not a real AggregateError: "
             f"{lines.get('all-fail is AggregateError')}")
    else:
        print("AGGREGATE OK: caught value is a real AggregateError")
    errors = json.loads(lines["all-fail errors"])
    if errors != ["judge crashed", "judge timed out"]:
        fail(f"any: AggregateError errors != branch errors in order: "
             f"{errors}")
    else:
        print("AGGREGATE ERRORS OK: all branch errors, branch order")
    if lines.get("empty any is AggregateError") != "true":
        fail("any: any([]) caught value is not a real AggregateError: "
             f"{lines.get('empty any is AggregateError')}")
    elif lines.get("empty any errors") != "0":
        fail(f"any: any([]) errors != 0: {lines.get('empty any errors')}")
    else:
        print("EMPTY any([]) OK: AggregateError with no errors, no fork")
    check_any_journal(r["parent_journal"], "run-any")


def check_any_journal(journal_path, run_id):
    events = read_journal(journal_path)
    forks = [e for e in events if e.get("type") == "fork"]
    joins = [e for e in events if e.get("type") == "join"]
    if len(forks) != 2 or len(joins) != 2:
        fail(f"any journal: expected 2 forks + 2 joins, got "
             f"{len(forks)} + {len(joins)}")
        return
    if forks[0].get("kind") != "any" or forks[0].get("branches") != 3:
        fail(f"any journal: fork-0 kind/branches wrong: {forks[0]}")
    if forks[1].get("kind") != "any" or forks[1].get("branches") != 2:
        fail(f"any journal: fork-1 kind/branches wrong: {forks[1]}")
    # fork-0: first success wins — join records the bare value, the
    # winner, the cancelled losers, and the failed branch that ran
    # before the winner.
    j0 = joins[0]
    if j0.get("outcome") != "approved/verified":
        fail(f"any journal: fork-0 join outcome != winner's value: {j0}")
    if j0.get("winner") != 1:
        fail(f"any journal: fork-0 winner != 1: {j0}")
    if j0.get("cancelled") != [2]:
        fail(f"any journal: fork-0 cancelled != [2]: {j0}")
    if j0.get("completed") != [
            {"ok": False,
             "error": {"name": "Error", "message": "judge crashed"}}]:
        fail(f"any journal: fork-0 completed != branch-0's failure: {j0}")
    else:
        print("JOURNAL OK: fork-0 join recorded winner 1, cancelled "
              "[2], the failed branch-0 outcome")
    # fork-1: every branch failed — join records the AggregateError.
    j1 = joins[1]
    if j1.get("aggregate") is not True:
        fail(f"any journal: fork-1 join is not aggregate: {j1}")
    if j1.get("errors") != [
            {"name": "Error", "message": "judge crashed"},
            {"name": "Error", "message": "judge timed out"}]:
        fail(f"any journal: fork-1 errors != branch errors in order: "
             f"{j1}")
    if j1.get("cancelled") != []:
        fail(f"any journal: fork-1 cancelled != []: {j1}")
    if j1.get("completed") != [
            {"ok": False,
             "error": {"name": "Error", "message": "judge crashed"}},
            {"ok": False,
             "error": {"name": "Error", "message": "judge timed out"}}]:
        fail(f"any journal: fork-1 completed != both failures: {j1}")
    else:
        print("JOURNAL OK: fork-1 join recorded the AggregateError "
              "(both errors, branch order), no cancellations")
    # The loser (fork-0 branch-2): exactly one cancel event with the
    # Q13 trigger and the winner — and no branch-start: it never ran.
    child = f"{run_id}/fork-0/branch-2"
    cevents = read_journal(prefix_for(child) + ".journal")
    cancels = [e for e in cevents if e.get("type") == "cancel"]
    starts = [e for e in cevents if e.get("type") == "branch-start"]
    if len(cancels) != 1:
        fail(f"any journal: {child} expected 1 cancel event, got "
             f"{len(cancels)}: {cevents}")
    else:
        c = cancels[0]
        if (c.get("parentForkId") != f"{run_id}/fork-0"
                or c.get("trigger") != "loser in any"
                or c.get("winner") != 1):
            fail(f"any journal: {child} cancel event wrong: {c}")
        elif starts:
            fail(f"any journal: {child} was cancelled but ran anyway "
                 f"(branch-start present): {starts}")
        else:
            print(f"JOURNAL OK: {child} cancelled before starting, "
                  f"trigger 'loser in any', winner 1")
    # Both branches of the all-fail fork ran and failed: branch-start +
    # branch-done with a failed outcome, no cancellations.
    all_ran = True
    for i in (0, 1):
        child = f"{run_id}/fork-1/branch-{i}"
        cevents = read_journal(prefix_for(child) + ".journal")
        starts = [e for e in cevents if e.get("type") == "branch-start"]
        dones = [e for e in cevents if e.get("type") == "branch-done"]
        cancels = [e for e in cevents if e.get("type") == "cancel"]
        if (len(starts) != 1 or len(dones) != 1 or cancels
                or dones[0].get("outcome", {}).get("ok") is not False):
            fail(f"any journal: {child} should have run and failed "
                 f"with no cancellation: {cevents}")
            all_ran = False
    if all_ran:
        print("JOURNAL OK: both fork-1 branches ran and failed "
              "(no cancellations)")


def test_race():
    r = run_test("race (first settler wins; failure throws)",
                 "workflow-race.ts", "workflow-race-direct.ts",
                 "run-race", 3)
    if r is None:
        return
    out_lines = open(r["parent_out"]).read().splitlines()
    lines = parse_out_lines(r["parent_out"])
    if lines.get("winner") != "approved/verified":
        fail(f"race: winner != first settler's bare value: "
             f"{lines.get('winner')}")
    else:
        print("RACE SUCCESS OK: first settler's bare value wins")
    if lines.get("caught is Error") != "true":
        fail("race: caught value is not a rehydrated Error: "
             f"{lines.get('caught is Error')}")
    else:
        print("RACE THROW OK: caught value is a real Error")
    if "finally ran" not in out_lines:
        fail("race: finally block did not run after the throw")
    else:
        print("FINALLY OK: finally block ran after the throw")
    if lines.get("caught") != "judge crashed":
        fail(f"race: caught != 'judge crashed': {lines.get('caught')}")
    else:
        print("RACE CATCH OK: parent caught the first settler's error")
    check_race_journal(r["parent_journal"], "run-race")


def check_race_journal(journal_path, run_id):
    events = read_journal(journal_path)
    forks = [e for e in events if e.get("type") == "fork"]
    joins = [e for e in events if e.get("type") == "join"]
    if len(forks) != 2 or len(joins) != 2:
        fail(f"race journal: expected 2 forks + 2 joins, got "
             f"{len(forks)} + {len(joins)}")
        return
    if forks[0].get("kind") != "race" or forks[0].get("branches") != 3:
        fail(f"race journal: fork-0 kind/branches wrong: {forks[0]}")
    if forks[1].get("kind") != "race" or forks[1].get("branches") != 2:
        fail(f"race journal: fork-1 kind/branches wrong: {forks[1]}")
    # fork-0: first settler wins — join records the bare value, the
    # winner (branch 0 in the sequential driver), the cancelled losers.
    j0 = joins[0]
    if j0.get("outcome") != "approved/verified":
        fail(f"race journal: fork-0 join outcome != winner's value: {j0}")
    if j0.get("winner") != 0:
        fail(f"race journal: fork-0 winner != 0: {j0}")
    if j0.get("cancelled") != [1, 2]:
        fail(f"race journal: fork-0 cancelled != [1, 2]: {j0}")
    if j0.get("completed") != []:
        fail(f"race journal: fork-0 completed != []: {j0}")
    else:
        print("JOURNAL OK: fork-0 join recorded winner 0, "
              "cancelled [1, 2]")
    # fork-1: first settler failed — join records the thrown error.
    j1 = joins[1]
    if j1.get("failedBranch") != 0:
        fail(f"race journal: fork-1 failedBranch != 0: {j1}")
    if j1.get("error") != {"name": "Error", "message": "judge crashed"}:
        fail(f"race journal: fork-1 error wrong: {j1}")
    if j1.get("cancelled") != [1]:
        fail(f"race journal: fork-1 cancelled != [1]: {j1}")
    if j1.get("completed") != []:
        fail(f"race journal: fork-1 completed != []: {j1}")
    else:
        print("JOURNAL OK: fork-1 join recorded the thrown error, "
              "failed branch 0, cancelled [1]")
    # Each loser: exactly one cancel event with the Q13 trigger and
    # the winner — and no branch-start: it never ran. (fork-0's
    # branch-1 would have failed if it had run — that is the check
    # that the losers were cancelled, not executed.)
    for fork_i, losers in ((0, (1, 2)), (1, (1,))):
        fork_id = f"{run_id}/fork-{fork_i}"
        for j in losers:
            child = f"{fork_id}/branch-{j}"
            cevents = read_journal(prefix_for(child) + ".journal")
            cancels = [e for e in cevents if e.get("type") == "cancel"]
            starts = [e for e in cevents
                      if e.get("type") == "branch-start"]
            if len(cancels) != 1:
                fail(f"race journal: {child} expected 1 cancel event, "
                     f"got {len(cancels)}: {cevents}")
                continue
            c = cancels[0]
            if (c.get("parentForkId") != fork_id
                    or c.get("trigger") != "loser in race"
                    or c.get("winner") != 0):
                fail(f"race journal: {child} cancel event wrong: {c}")
            elif starts:
                fail(f"race journal: {child} was cancelled but ran "
                     f"anyway (branch-start present): {starts}")
            else:
                print(f"JOURNAL OK: {child} cancelled before starting, "
                      f"trigger 'loser in race', winner 0")


def test_race_empty():
    print("\n=== race([]) never settles (bounded drive) ===")
    run_id = "run-race-empty"
    p = prefix_for(run_id)
    for f in (p + ".snap", p + ".out", p + ".log", p + ".journal"):
        if os.path.exists(f):
            os.remove(f)
    rc = run_host(["run", "workflow-race-empty.ts", p + ".snap"],
                  p + ".out", p + ".log",
                  {"AGENTTS_RUN_ID": run_id,
                   "AGENTTS_JOURNAL": p + ".journal"})
    if rc != 3:
        fail(f"race-empty: parent run exited {rc}, expected 3 "
             f"(suspended at race([]))")
        return
    print("parent suspended at race([])")
    fork = last_fork(p + ".journal")
    if (fork is None or fork.get("kind") != "race"
            or fork.get("branches") != 0 or fork.get("childRuns") != []):
        fail(f"race-empty: fork event wrong: {fork}")
        return
    print("FORK OK: 0-branch race fork, no children")
    # Bounded drive: the run must neither resolve nor crash, and the
    # harness must not hang — drive() with allow_unresolved returns
    # the still-suspended code instead of joining.
    rc = drive(p + ".snap", p + ".out", p + ".log", rc, run_id,
               allow_unresolved=True)
    if rc != 3:
        fail(f"race-empty: bounded drive returned {rc}, expected 3 "
             f"(still suspended)")
        return
    events = read_journal(p + ".journal")
    if any(e.get("type") == "join" for e in events):
        fail("race-empty: a join event appeared — race([]) spuriously "
             "resolved")
        return
    if open(p + ".out").read() != "":
        fail("race-empty: the workflow printed output — race([]) "
             "resolved")
        return
    print("BOUNDED DRIVE OK: still suspended, no join, no output, no "
          "crash — race([]) never settles")


def main():
    os.chdir(DIR)
    for pat in ("run-judges*", "run-global*", "run-nested*",
                "run-failfast*", "run-any*", "run-race*", "smoke.*"):
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

    test_judges()
    test_global()
    test_nested()
    test_failfast()
    test_any()
    test_race()
    test_race_empty()

    print()
    if FAILURES:
        print(f"FAIL ({len(FAILURES)} check(s)):")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("PASS combinator (collect-all + fail-fast + any/race)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
