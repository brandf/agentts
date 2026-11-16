#!/bin/sh
# Restore+eval experiment (Linear BRA-23): can a runtime restored from a
# dquickts snapshot accept a fresh eval while a suspended execution sits
# in it?
#
#   ./run.sh
#
# 1. The direct workflow runs straight through (mock steps) — the
#    reference output.
# 2. The fork workflow suspends at all(); the parent snapshot is saved.
# 3. Each branch loads a COPY of the parent snapshot and evals a driver
#    that pulls its thunk from the stash and calls it; the thunk's steps
#    suspend/resume across processes like any other workflow.
# 4. PASS iff the concatenated branch outputs are byte-identical to the
#    direct run, and the parent snapshot file is untouched by the children.
#
# The mock maps a step's input to its result, keyed on op:value (read back
# from the host's suspension log line). A result of the form throw:<json>
# delivers the JSON value as an exception from the step call.
set -u
cd "$(dirname "$0")"

# mock_result <op> <value> — the canned step results.
mock_result() {
    case "$1:$2" in
        score:7)  echo '{"score":0.92,"label":"approved"}' ;;
        verify:7) echo '{"score":0.97,"label":"verified"}' ;;
        score:3)  echo '{"score":0.41,"label":"weak"}' ;;
        verify:3) echo '{"score":0.88,"label":"retried"}' ;;
        *) echo "[mock] no canned result for $1:$2; using default" >&2
           echo '{"score":0.5,"label":"default"}' ;;
    esac
}

# last_step <snap.log> — op:value of the most recent suspended step call,
# parsed from the host's "[host] step({...}) — suspending" line.
last_step() {
    line=$(grep '\[host\] step(' "$1" | tail -1)
    op=$(printf '%s' "$line" | grep -o '"op":"[^"]*"' | head -1 | sed 's/"op":"//;s/"//')
    value=$(printf '%s' "$line" | grep -o '"value":[-0-9]*' | head -1 | sed 's/"value"://')
    printf '%s:%s' "$op" "$value"
}

# drive <snap> <out> <log> <initial_rc> — resume rounds until the run
# completes (exit 0) or fails (exit 1). Echoes the final exit code.
# Only loops if the initial run suspended (rc 2).
drive() {
    snap=$1; out=$2; log=$3; rc=$4; rounds=0
    while [ $rc -eq 2 ] && [ $rounds -le 20 ]; do
        step=$(last_step "$log")
        result=$(mock_result "${step%%:*}" "${step##*:}")
        ./reval resume "$snap" "$result" >> "$out" 2>> "$log"
        rc=$?
        rounds=$((rounds + 1))
    done
    echo "$rc"
}

make reval || { echo "build failed"; exit 1; }

echo "=== direct (straight-through reference) ==="
rm -f direct.snap direct.out direct.log
./reval run workflow-direct.ts direct.snap > direct.out 2> direct.log
rc=$?
rc=$(drive direct.snap direct.out direct.log $rc)
echo "exit=$rc snapshot=$(wc -c < direct.snap | tr -d ' ') bytes"
cat direct.out
echo "--- stderr ---"
cat direct.log
echo

echo "=== parent (fork, suspends at all) ==="
rm -f parent.snap parent.out parent.log
./reval run workflow-fork.ts parent.snap > parent.out 2> parent.log
rc=$?
echo "exit=$rc (expect 2 = suspended) snapshot=$(wc -c < parent.snap | tr -d ' ') bytes"
echo "--- stdout (expect empty) ---"
cat parent.out
echo "--- stderr ---"
cat parent.log
parent_sha=$(sha256sum parent.snap | cut -d' ' -f1)
[ $rc -eq 2 ] || { echo "FAIL parent did not suspend"; exit 1; }
grep -q 'all(2 branches)' parent.log || { echo "FAIL parent did not suspend at all()"; exit 1; }
echo

for i in 0 1; do
    echo "=== branch $i (driver eval on restored runtime) ==="
    cp parent.snap "branch$i.snap"
    rm -f "branch$i.out" "branch$i.log"
    ./reval branch "branch$i.snap" $i > "branch$i.out" 2> "branch$i.log"
    rc=$?
    rc=$(drive "branch$i.snap" "branch$i.out" "branch$i.log" $rc)
    echo "exit=$rc snapshot=$(wc -c < "branch$i.snap" | tr -d ' ') bytes"
    echo "--- stdout ---"
    cat "branch$i.out"
    echo "--- stderr ---"
    cat "branch$i.log"
    [ $rc -eq 0 ] || { echo "FAIL branch $i exit=$rc"; exit 1; }
    echo
done

echo "=== compare ==="
cat branch0.out branch1.out > branches.out
echo "--- branches (concatenated) ---"
cat branches.out
echo "--- direct ---"
cat direct.out
if cmp -s branches.out direct.out; then
    echo "OUTPUT MATCH: branch outputs byte-identical to direct run"
else
    echo "FAIL: branch outputs differ from direct run"
    diff branches.out direct.out || true
    exit 1
fi

echo "--- parent snapshot untouched by children? ---"
child_sha=$(sha256sum parent.snap | cut -d' ' -f1)
if [ "$parent_sha" = "$child_sha" ]; then
    echo "YES: parent.snap unchanged ($parent_sha)"
else
    echo "FAIL: parent.snap changed ($parent_sha -> $child_sha)"
    exit 1
fi

echo
echo "PASS restore+eval"
