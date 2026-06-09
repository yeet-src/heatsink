#!/usr/bin/env bash
# heatsink demo — give the dashboard something to watch. Spins up one busy
# loop per core so the cores boost and the package temperature climbs, then
# runs heatsink in the foreground. The load is killed when you Ctrl-C out.
#
#   cd examples/heatsink && ./demo.sh
#
# Override the burn with LOAD=N (default: one worker per core). LOAD=0 runs
# the dashboard against an idle box. Pass extra flags through, e.g.
#   ./demo.sh --sort head
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CORES="$(nproc 2>/dev/null || echo 4)"
LOAD="${LOAD:-$CORES}"

bold=$'\e[1m'; dim=$'\e[2m'; grn=$'\e[32m'; cyn=$'\e[36m'; rst=$'\e[0m'

pids=()
burn() { while :; do :; done; }
for ((i = 0; i < LOAD; i++)); do
  burn &
  pids+=("$!")
done

cleanup() { [ "${#pids[@]}" -gt 0 ] && kill "${pids[@]}" 2>/dev/null; }
trap cleanup EXIT INT TERM

cat <<EOF

${bold}heatsink${rst} — live thermal, power & clock dashboard.

Burning ${bold}${LOAD}${rst} of ${bold}${CORES}${rst} cores so the clocks boost and the package
temperature climbs. Watch the ${grn}CLOCKS${rst} grid light up and the ${cyn}k10temp${rst} /
${cyn}Tctl${rst} row march up its gauge. ${dim}Ctrl-C stops the load and the dashboard.${rst}

EOF

cd "$HERE"
exec yeet run main.js "$@"
