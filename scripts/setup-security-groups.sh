#!/usr/bin/env bash
#
# A15 — network isolation, enforced at the network layer.
#
# Creates three security groups and exactly ONE ingress rule that matters:
# signer-service:4003 is reachable from policy-service's security group and
# from nothing else. agent-orchestrator is deliberately given no path at all.
#
#   docs/owner-a-tasks.md A15 · docs/execution_plan.md §11 · conventions.md §2
#
# Why a security group and not an "if" in code: a code check would prove the
# port was reachable and that we chose not to answer. The claim being made is
# that the port is NOT REACHABLE. Only the network layer can make that true.
#
# Verify-only by default — it will not mutate your account unless you pass
# --apply. Both modes are safe to re-run.
#
#   scripts/setup-security-groups.sh --vpc vpc-0abc123           # verify
#   scripts/setup-security-groups.sh --vpc vpc-0abc123 --apply   # create + verify
#
# The verify pass is itself a deliverable: it is the CONFIGURATION proof, and it
# complements scripts/test-isolation.sh, which is the PACKET proof. Show both.

set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-1}"
VPC_ID=""
MODE="verify"

# Ports come from SERVICE_PORTS in packages/contracts/src/constants.ts. Never
# hardcode a port anywhere else (conventions.md §2) — these three mirror it.
readonly SIGNER_PORT=4003
readonly POLICY_SG_NAME="straitsx-888-policy-service"
readonly SIGNER_SG_NAME="straitsx-888-signer-service"
readonly ORCHESTRATOR_SG_NAME="straitsx-888-agent-orchestrator"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; GREEN=""; YELLOW=""; RED=""
fi

ok()   { printf '  %s+%s %s\n' "$GREEN" "$RESET" "$1"; }
info() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s! %s%s\n' "$YELLOW" "$1" "$RESET"; }
fail() { printf '  %sFAIL%s %s\n' "$RED" "$RESET" "$1"; }
die()  { printf '\n%ssetup-security-groups: %s%s\n\n' "$RED" "$1" "$RESET" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vpc)     VPC_ID="${2:-}"; shift 2 ;;
    --region)  REGION="${2:-}"; shift 2 ;;
    --apply)   MODE="apply"; shift ;;
    --verify)  MODE="verify"; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "unknown argument: $1" ;;
  esac
done

[[ -n "$VPC_ID" ]] || die "--vpc <vpc-id> is required (find it with: aws ec2 describe-vpcs)"
command -v aws >/dev/null 2>&1 || die "the aws CLI is not installed"
aws sts get-caller-identity >/dev/null 2>&1 || die "not authenticated to AWS — run 'aws configure'"

printf '\n%sA15 network isolation — %s in %s%s\n\n' "$BOLD" "$VPC_ID" "$REGION" "$RESET"

# --- security group resolution ------------------------------------------------

# Prints the group id for NAME, or empty string when it does not exist.
sg_id() {
  local name="$1" id
  id=$(aws ec2 describe-security-groups \
        --region "$REGION" \
        --filters "Name=group-name,Values=$name" "Name=vpc-id,Values=$VPC_ID" \
        --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null) || true
  [[ "$id" == "None" || -z "$id" ]] && return 0
  printf '%s' "$id"
}

# Creates NAME if absent and prints its id. Idempotent.
ensure_sg() {
  local name="$1" description="$2" id
  id=$(sg_id "$name")
  if [[ -n "$id" ]]; then
    info "$name exists ($id)"
    printf '%s' "$id"
    return 0
  fi
  if [[ "$MODE" != "apply" ]]; then
    printf '%s' ""
    return 0
  fi
  id=$(aws ec2 create-security-group \
        --region "$REGION" --vpc-id "$VPC_ID" \
        --group-name "$name" --description "$description" \
        --query GroupId --output text) || die "could not create $name"
  ok "created $name ($id)"
  printf '%s' "$id"
}

POLICY_SG=$(ensure_sg "$POLICY_SG_NAME" "straitsx-888 policy-service - may reach the signer")
SIGNER_SG=$(ensure_sg "$SIGNER_SG_NAME" "straitsx-888 signer-service - holds the only key, reachable from policy-service ONLY")
ORCHESTRATOR_SG=$(ensure_sg "$ORCHESTRATOR_SG_NAME" "straitsx-888 agent-orchestrator - deliberately has NO path to the signer")

if [[ -z "$POLICY_SG" || -z "$SIGNER_SG" || -z "$ORCHESTRATOR_SG" ]]; then
  warn "one or more security groups do not exist yet."
  info "re-run with --apply to create them."
  exit 1
fi

# --- the one rule that matters ------------------------------------------------

if [[ "$MODE" == "apply" ]]; then
  printf '\n%sApplying ingress%s\n' "$BOLD" "$RESET"
  # Source is the POLICY SECURITY GROUP, not a CIDR. A CIDR would grant access
  # to whatever else happens to hold that address later; a group reference
  # follows the workload as instances come and go.
  if aws ec2 authorize-security-group-ingress \
       --region "$REGION" --group-id "$SIGNER_SG" \
       --protocol tcp --port "$SIGNER_PORT" --source-group "$POLICY_SG" \
       >/dev/null 2>&1; then
    ok "signer:$SIGNER_PORT now reachable from policy-service SG only"
  else
    info "ingress rule already present (nothing to do)"
  fi
  # agent-orchestrator gets NOTHING. There is deliberately no command here.
  info "agent-orchestrator: no rule added, by design"
fi

# --- verification: the configuration proof ------------------------------------

printf '\n%sVerifying%s\n' "$BOLD" "$RESET"
FAILURES=0

# 1. No CIDR-based ingress on the signer at all. Any 0.0.0.0/0 here would make
#    the whole isolation claim false regardless of the group rules.
cidrs=$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SIGNER_SG" \
          --query 'SecurityGroups[0].IpPermissions[].IpRanges[].CidrIp' --output text)
if [[ -n "$cidrs" && "$cidrs" != "None" ]]; then
  fail "signer SG has CIDR ingress: $cidrs (expected none)"
  FAILURES=$((FAILURES + 1))
else
  ok "no CIDR ingress on the signer"
fi

# 2. Exactly one source group, and it is policy-service.
sources=$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SIGNER_SG" \
            --query 'SecurityGroups[0].IpPermissions[].UserIdGroupPairs[].GroupId' --output text)
if [[ "$sources" == "$POLICY_SG" ]]; then
  ok "only source group is policy-service ($POLICY_SG)"
else
  fail "expected exactly '$POLICY_SG' as the source group, got: '${sources:-none}'"
  FAILURES=$((FAILURES + 1))
fi

# 3. The orchestrator SG is not among them. Checked explicitly rather than
#    inferred from 2, because this is the assertion a judge will ask about.
if [[ "$sources" == *"$ORCHESTRATOR_SG"* ]]; then
  fail "agent-orchestrator SG ($ORCHESTRATOR_SG) can reach the signer — the security claim is false"
  FAILURES=$((FAILURES + 1))
else
  ok "agent-orchestrator ($ORCHESTRATOR_SG) has no path to the signer"
fi

# 4. Only port 4003 is open.
ports=$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SIGNER_SG" \
          --query 'SecurityGroups[0].IpPermissions[].FromPort' --output text)
if [[ "$ports" == "$SIGNER_PORT" ]]; then
  ok "only port $SIGNER_PORT is open"
else
  fail "expected only port $SIGNER_PORT, got: '${ports:-none}'"
  FAILURES=$((FAILURES + 1))
fi

printf '\n'
if (( FAILURES > 0 )); then
  printf '%s  %s check(s) failed — isolation is NOT proven%s\n\n' "$RED" "$FAILURES" "$RESET"
  exit 1
fi

printf '%s  Configuration proof passed%s\n\n' "$GREEN" "$RESET"
info "Record these for the deployment:"
info "  POLICY_SG=$POLICY_SG"
info "  SIGNER_SG=$SIGNER_SG"
info "  ORCHESTRATOR_SG=$ORCHESTRATOR_SG"
printf '\n'
info "This proves the RULES are right. It does not prove a packet is dropped."
info "For that, run the packet proof from a host in the orchestrator SG:"
info "  scripts/test-isolation.sh --target <signer-private-ip>:$SIGNER_PORT --expect blocked"
printf '\n'
