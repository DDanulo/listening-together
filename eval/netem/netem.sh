#!/usr/bin/env bash
# Network impairment scenarios for the evaluation (E1, E6), with Linux tc netem. Needs root (sudo).
#
#   sudo eval/netem/netem.sh apply <scenario> [--iface wlan0] [--server 203.0.113.10]
#   sudo eval/netem/netem.sh outage <seconds> [--iface wlan0] [--server 203.0.113.10]
#   sudo eval/netem/netem.sh reset [--iface wlan0]
#   eval/netem/netem.sh status [--iface wlan0]
#   eval/netem/netem.sh list
#
# The delay is split between both directions (egress with netem, ingress through an ifb device), so a scenario's
# delay is added to the round trip, symmetrically, except in `asym-*`, which delays one direction only: that breaks
# the symmetric-delay assumption of the clock sync and should show an offset error of half the asymmetry.
# With --server, only traffic to/from that IP is impaired (the rest of the machine stays usable).
# Always run `reset` afterwards; the impairment survives until reset or reboot.
set -euo pipefail

IFB=ifb-lt0

# name: one-way netem arguments, applied to each direction (asym-*: egress only)
scenario_args() {
  case "$1" in
    delay0)    echo "delay 0ms" ;;
    delay50)   echo "delay 25ms" ;;
    delay150)  echo "delay 75ms" ;;
    delay300)  echo "delay 150ms" ;;
    jitter20)  echo "delay 25ms 10ms distribution normal" ;;
    jitter50)  echo "delay 50ms 25ms distribution normal" ;;
    loss1)     echo "delay 25ms loss 1%" ;;
    loss5)     echo "delay 25ms loss 5%" ;;
    asym-50)   echo "delay 50ms" ;;
    asym-150)  echo "delay 150ms" ;;
    *) return 1 ;;
  esac
}

SCENARIOS="delay0 delay50 delay150 delay300 jitter20 jitter50 loss1 loss5 asym-50 asym-150"

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

default_iface() { ip route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}'; }

need_root() { [[ $EUID -eq 0 ]] || { echo "needs root: run with sudo" >&2; exit 1; }; }

reset() {
  tc qdisc del dev "$IFACE" root 2>/dev/null || true
  tc qdisc del dev "$IFACE" ingress 2>/dev/null || true
  if ip link show "$IFB" >/dev/null 2>&1; then
    tc qdisc del dev "$IFB" root 2>/dev/null || true
    ip link del "$IFB" 2>/dev/null || true
  fi
}

# netem on one device: on everything, or (with --server) only on traffic matching that IP in direction $3 (src|dst)
add_netem() {
  local dev=$1 args=$2 match=$3
  if [[ -z "$SERVER" ]]; then
    # shellcheck disable=SC2086
    tc qdisc add dev "$dev" root netem $args
  else
    tc qdisc add dev "$dev" root handle 1: prio bands 3 priomap 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1
    # shellcheck disable=SC2086
    tc qdisc add dev "$dev" parent 1:3 handle 30: netem $args
    tc filter add dev "$dev" parent 1: protocol ip prio 1 u32 match ip "$match" "$SERVER"/32 flowid 1:3
  fi
}

apply() {
  local name=$1 args
  args=$(scenario_args "$name") || { echo "unknown scenario '$name' (try: list)" >&2; exit 1; }
  reset
  add_netem "$IFACE" "$args" dst
  if [[ "$name" != asym-* ]]; then
    modprobe ifb numifbs=0
    ip link add "$IFB" type ifb
    ip link set "$IFB" up
    tc qdisc add dev "$IFACE" handle ffff: ingress
    tc filter add dev "$IFACE" parent ffff: protocol all u32 match u32 0 0 action mirred egress redirect dev "$IFB"
    add_netem "$IFB" "$args" src
  fi
  echo "$(date +%T) applied '$name' on $IFACE${SERVER:+ (only $SERVER)}: $args per direction"
}

outage() {
  local seconds=$1
  reset
  add_netem "$IFACE" "loss 100%" dst
  echo "$(date +%T.%3N) outage started on $IFACE${SERVER:+ (only $SERVER)} for ${seconds}s"
  sleep "$seconds"
  reset
  echo "$(date +%T.%3N) outage ended"
}

[[ $# -ge 1 ]] || usage
COMMAND=$1; shift
ARG=""
if [[ "$COMMAND" == apply || "$COMMAND" == outage ]]; then
  [[ $# -ge 1 ]] || usage
  ARG=$1; shift
fi
IFACE=""; SERVER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --iface) IFACE=$2; shift 2 ;;
    --server) SERVER=$2; shift 2 ;;
    *) usage ;;
  esac
done
IFACE=${IFACE:-$(default_iface)}

case "$COMMAND" in
  apply) need_root; apply "$ARG" ;;
  outage) need_root; outage "$ARG" ;;
  reset) need_root; reset; echo "reset $IFACE" ;;
  status) tc qdisc show dev "$IFACE"; ip link show "$IFB" >/dev/null 2>&1 && tc qdisc show dev "$IFB" || true ;;
  list) for s in $SCENARIOS; do printf '%-10s %s\n' "$s" "$(scenario_args "$s")"; done ;;
  *) usage ;;
esac
