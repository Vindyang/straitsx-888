#!/usr/bin/env bash
#
# A15 — the packet proof: agent-orchestrator cannot reach signer-service.
#
#   docs/owner-a-tasks.md A15 · docs/execution_plan.md §11
#
# Run this FROM a host inside the agent-orchestrator security group (or from a
# container on the orchestrator network locally). It attempts an ordinary HTTP
# request to the signer and asserts the connection never establishes.
#
#   scripts/test-isolation.sh --target 10.0.3.14:4003 --expect blocked
#   scripts/test-isolation.sh --target signer:4003    --expect blocked
#   scripts/test-isolation.sh --target 10.0.2.9:4003  --expect open    # from policy-service
#
# WHY THE PROBE TARGETS /health: /health is the one path exempt from the
# internal-token check (conventions.md §3). That exemption exists precisely so
# this test cannot produce a false pass — if the probe hit an authenticated
# path, a 401 would look like a refusal while actually proving the port was
# WIDE OPEN. Any HTTP response at all, including 401 or 500, means reachable.
#
# WHAT "BLOCKED" LOOKS LIKE — this differs by environment, and getting it wrong
# reports a working configuration as broken:
#
#   AWS security group : packets are DROPPED silently, so the connection HANGS
#                        and we observe a timeout. SGs never send a TCP RST.
#   Docker / no route  : fails fast with "connection refused" or an unresolvable
#                        host, because there is no route or no DNS entry.
#
# Both are passes. The ONLY failure is a completed HTTP exchange.

set -euo pipefail

TARGET="${ISOLATION_TARGET:-}"
EXPECT="${ISOLATION_EXPECT:-blocked}"
TIMEOUT="${ISOLATION_TIMEOUT:-8}"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  GREEN=$(tput setaf 2); RED=$(tput setaf 1); YELLOW=$(tput setaf 3)
else
  BOLD=""; DIM=""; RESET=""; GREEN=""; RED=""; YELLOW=""
fi

die() { printf '\n%stest-isolation: %s%s\n\n' "$RED" "$1" "$RESET" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)  TARGET="${2:-}"; shift 2 ;;
    --expect)  EXPECT="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "unknown argument: $1" ;;
  esac
done

[[ -n "$TARGET" ]] || die "--target <host:port> is required (or set ISOLATION_TARGET)"
[[ "$EXPECT" == "blocked" || "$EXPECT" == "open" ]] || die "--expect must be 'blocked' or 'open'"
command -v curl >/dev/null 2>&1 || die "curl is not installed"

URL="http://${TARGET}/health"

printf '\n%sA15 isolation probe%s\n' "$BOLD" "$RESET"
printf '  %sfrom      %s%s\n' "$DIM" "$(hostname)" "$RESET"
printf '  %starget    %s%s\n' "$DIM" "$URL" "$RESET"
printf '  %sexpecting %s%s\n' "$DIM" "$EXPECT" "$RESET"
printf '  %sat        %s%s\n\n' "$DIM" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$RESET"

# --fail is deliberately NOT used: any HTTP status proves reachability, so we
# want curl to exit 0 on a 401 or a 500 just as it would on a 200.
set +e
BODY=$(curl --silent --show-error \
            --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT" \
            --output /dev/null --write-out '%{http_code}' \
            "$URL" 2>&1)
CURL_EXIT=$?
set -e

# curl exit codes: 0 connected · 6 DNS failure · 7 connection refused or no
# route · 28 timed out (the AWS security-group drop signature).
case "$CURL_EXIT" in
  0)  OBSERVED="open"
      DETAIL="HTTP $BODY — the connection completed" ;;
  6)  # NOT a pass. An unresolvable name proves the NAME is wrong, not that the
      # security group blocked anything — the packet never left the host. Calling
      # this "isolated" is the classic false-positive that makes an isolation
      # claim worthless, so it is reported separately and fails the run.
      OBSERVED="inconclusive"
      DETAIL="could not resolve '${TARGET%%:*}' — DNS failure proves nothing about the firewall" ;;
  7)  OBSERVED="blocked"
      DETAIL="connection refused or no route — rejected at the network layer" ;;
  28) OBSERVED="blocked"
      DETAIL="timed out after ${TIMEOUT}s — packets dropped silently (security-group signature)" ;;
  *)  OBSERVED="blocked"
      DETAIL="curl exit $CURL_EXIT: ${BODY:-no detail}" ;;
esac

printf '  %sobserved  %s%s\n' "$DIM" "$OBSERVED" "$RESET"
printf '  %s%s%s\n\n' "$DIM" "$DETAIL" "$RESET"

if [[ "$OBSERVED" == "inconclusive" ]]; then
  printf '%s  INCONCLUSIVE — this is NOT evidence of isolation.%s\n' "$YELLOW" "$RESET"
  printf '%s  The hostname did not resolve, so no packet was ever sent. A blocked\n' "$DIM"
  printf '  firewall and a typo look identical from here. Fix the name, then re-run.\n'
  printf '  A valid isolation proof also needs POSITIVE controls: from the same host,\n'
  printf '  show that policy/ledger/chain-gateway ARE reachable. Otherwise you have\n'
  printf '  only shown the network is broken, not that the signer is protected.%s\n\n' "$RESET"
  exit 2
fi

if [[ "$OBSERVED" != "$EXPECT" ]]; then
  if [[ "$EXPECT" == "blocked" ]]; then
    printf '%s  FAIL — the signer IS REACHABLE from here.%s\n' "$RED" "$RESET"
    printf '%s  Anything that can reach :4003 can ask for a signature. The entire\n' "$RED"
    printf '  security claim rests on this being impossible. Do not demo until fixed.%s\n\n' "$RESET"
  else
    printf '%s  FAIL — expected the signer to be reachable from here and it is not.%s\n' "$RED" "$RESET"
    printf '%s  policy-service will not be able to get signatures. Check the ingress rule.%s\n\n' "$DIM" "$RESET"
  fi
  exit 1
fi

if [[ "$EXPECT" == "blocked" ]]; then
  printf '%s  PASS — the signer is unreachable from this host.%s\n' "$GREEN" "$RESET"
  if [[ "$CURL_EXIT" == "28" ]]; then
    printf '  %sNote for the deck: this is a TIMEOUT, not a refusal. Security groups\n' "$DIM"
    printf '  drop packets rather than rejecting them, so a hang is the correct and\n'
    printf '  expected evidence here.%s\n' "$RESET"
  fi
  printf '\n  %sScreenshot this output for the deck (A15 deliverable).%s\n\n' "$YELLOW" "$RESET"
else
  printf '%s  PASS — the signer is reachable from this host, as intended.%s\n\n' "$GREEN" "$RESET"
fi
