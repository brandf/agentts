#!/bin/sh
# AgentTS heartbeat logger — BRA-137 diagnostic instrument.
#
# One line per minute to ~/workspace/agentts-runs/heartbeat.log:
#   <UTC timestamp> boot=<kernel boot_id> proc1=<PID 1 start epoch> load=<1/5/15m loadavg>
#
# Purpose: the next time a long suite run or the production server dies,
# the last heartbeat before the death vs. the first heartbeat after
# (new boot_id) settles whether the VM was replaced (boot_id changed)
# or the killer was in-VM (boot_id unchanged) — with zero ambiguity.
# The investigator's kill-rate math (30-min run vs ~117-min replacement
# cycle ≈ 26% kill rate, matching the observed 25-28%) says replacement
# is the likely cause (~75%), but no killed run has ever left a boot
# ID on disk, so this logger is the experiment that proves or kills it.
#
# Durability: a bare `nohup ... &` instance dies on the next VM
# replacement and is NOT restarted — it is a stopgap that yields data
# only until the next replacement. Durable operation needs a cron
# (every minute, restart-if-missing) or a supervised process; that is
# a parent/Meroki decision, not something this script invents.
#   nohup sh apps/agentts/bench/heartbeat.sh >/dev/null 2>&1 &
# Log growth is ~1 line/min (~100 KB/day); rotate by hand if it gets big.
set -u
LOG="$HOME/workspace/agentts-runs/heartbeat.log"
mkdir -p "$(dirname "$LOG")"
while true; do
  boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
  proc1=$(stat -c %Y /proc/1 2>/dev/null || echo unknown)
  load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo unknown)
  printf '%s boot=%s proc1=%s load=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$boot" "$proc1" "$load" >> "$LOG"
  sleep 60
done
