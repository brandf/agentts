#!/bin/sh
# Drive both workflow variants end to end through suspend / snapshot /
# fresh-process resume, and check the output is exactly what the same
# workflow would print if it ran straight through.
#
#   ./run.sh
#
# Canned step results, in call order:
#   step 1 -> score 0.92 (ship), step 2 -> score 0.41 (reject)
set -u
cd "$(dirname "$0")"

RESULT1='{"score":0.92,"label":"approved"}'
RESULT2='{"score":0.41,"label":"weak"}'

run_variant() {
    name=$1; workflow=$2; snap=$3; out=$4
    rm -f "$snap" "$out"
    echo "=== $name ($workflow) ==="
    t0=$(date +%s%N)
    ./proto run "$workflow" "$snap" > "$out" 2> "$snap.log"
    rc=$?
    rounds=1
    while [ $rc -eq 2 ] && [ $rounds -le 10 ]; do
        if [ $rounds -eq 1 ]; then result=$RESULT1; else result=$RESULT2; fi
        ./proto resume "$snap" "$result" >> "$out" 2>> "$snap.log"
        rc=$?
        rounds=$((rounds + 1))
    done
    t1=$(date +%s%N)
    ms=$(( (t1 - t0) / 1000000 ))
    echo "exit=$rc rounds=$rounds wall=${ms}ms snapshot=$(wc -c < "$snap" | tr -d ' ') bytes"
    echo "--- stdout ---"
    cat "$out"
    echo "--- stderr ---"
    cat "$snap.log"
    echo "--- expected ---"
    cat "$out.expected"
    if [ $rc -eq 0 ] && cmp -s "$out" "$out.expected"; then
        echo "PASS $name"
    else
        echo "FAIL $name (exit=$rc)"
    fi
    echo
}

cat > sync.out.expected <<'EOF'
step 1 -> {"score":0.92,"label":"approved"}
step 2 -> {"score":0.41,"label":"weak"}
verdict: ship/reject
EOF
cat > async.out.expected <<'EOF'
step 1 -> {"score":0.92,"label":"approved"}
step 2 -> {"score":0.41,"label":"weak"}
verdict: ship/reject
workflow done: ship/reject
EOF

make proto 2>&1 | tail -3
run_variant "sync-looking" workflow-sync.ts sync.snap sync.out
run_variant "async-await" workflow-async.ts async.snap async.out

echo "=== raw engine speed (qjs, same VM) ==="
QJS=${QJS:-$HOME/workspace/dquickts-build/qjs}
time "$QJS" -e 'let s=0; for (let i=0;i<100000000;i++) s+=i; print(s)'
