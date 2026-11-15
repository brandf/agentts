#!/bin/sh
# Drive each workflow end to end through suspend / snapshot /
# fresh-process resume, and check the output is exactly what the same
# workflow would print if it ran straight through.
#
#   ./run.sh
#
# The mock maps a step's input to its result, per workflow, keyed on
# op:value (read back from the host's suspension log line). A result of
# the form throw:<json> delivers the JSON value as an exception from the
# step call instead of a normal result.
set -u
cd "$(dirname "$0")"

# mock_result <workflow> <op> <value> — the canned step results.
mock_result() {
    case "$1:$2:$3" in
        sync:score:7) echo '{"score":0.92,"label":"approved"}' ;;
        sync:score:3) echo '{"score":0.41,"label":"weak"}' ;;
        complex:score:7) echo '{"score":0.92,"label":"approved"}' ;;
        complex:score:9) echo 'throw:"step failed: value 9 is not scorable"' ;;
        complex:score:3) echo '{"score":0.41,"label":"weak"}' ;;
        complex:score:8) echo '{"score":0.75,"label":"ok"}' ;;
        complex:verify:7) echo '{"score":0.97,"label":"verified"}' ;;
        complex:retry:3) echo '{"score":0.88,"label":"retried"}' ;;
        *) echo "[mock] no canned result for $1:$2:$3; using default" >&2
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

run_variant() {
    name=$1; workflow=$2; snap=$3; out=$4
    rm -f "$snap" "$out" "$snap.log"
    echo "=== $name ($workflow) ==="
    t0=$(date +%s%N)
    ./proto run "$workflow" "$snap" > "$out" 2> "$snap.log"
    rc=$?
    rounds=1
    while [ $rc -eq 2 ] && [ $rounds -le 20 ]; do
        step=$(last_step "$snap.log")
        result=$(mock_result "$name" "${step%%:*}" "${step##*:}")
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
cat > complex.out.expected <<'EOF'
item 7 settled
grid 0 0 value 7 -> {"score":0.92,"label":"approved"}
item 9 failed: step failed: value 9 is not scorable
item 9 settled
grid 0 1 value 9 -> {"score":0,"label":"failed"}
item 3 settled
grid 1 0 value 3 -> {"score":0.41,"label":"weak"}
item 8 settled
grid 1 1 value 8 -> {"score":0.75,"label":"ok"}
check 7 passed, verify -> {"score":0.97,"label":"verified"}
check 3 weak, retry -> {"score":0.88,"label":"retried"}
checks: ship/revise
shipped: 1 failed: 1
workflow done: done
EOF

make proto || { echo "build failed" ; exit 1; }
run_variant "sync" workflow-sync.ts sync.snap sync.out
run_variant "complex" workflow-complex.ts complex.snap complex.out

echo "=== raw engine speed (qjs, same VM) ==="
QJS=${QJS:-$HOME/workspace/dquickts-build/qjs}
if [ -x "$QJS" ]; then
    time "$QJS" -e 'let s=0; for (let i=0;i<100000000;i++) s+=i; print(s)'
else
    echo "(qjs not found at $QJS — skipping raw-speed check)"
fi
