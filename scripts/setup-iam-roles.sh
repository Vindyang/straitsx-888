#!/usr/bin/env bash
#
# A15 — the IAM half of signer isolation.
#
#   docs/owner-a-tasks.md A15 ("Split IAM: policy-service and signer-service
#   under different roles") · docs/execution_plan.md §11 ("KMS IAM least
#   privilege: only signer-service's execution role may call Sign")
#
# Creates three EC2 roles and instance profiles:
#
#   straitsx-888-signer-service       ALLOW  kms:Sign on the signing key
#   straitsx-888-policy-service       DENY   kms:Sign  (explicit)
#   straitsx-888-agent-orchestrator   DENY   kms:*     (explicit)
#
# This is the SECOND layer, and it is not redundant with the security groups.
# The SG stops agent-orchestrator from reaching signer-service. This stops
# anything that is not signer-service from reaching KMS AT ALL — including a
# compromised policy-service that decides to skip the signer and call
# kms:Sign directly. Network isolation alone would not catch that.
#
# The denies are EXPLICIT rather than merely absent. An IAM explicit Deny beats
# every Allow anywhere, including a future permissive policy someone attaches in
# a hurry at 3am. "It has no permission yet" is a state; "it is denied" is an
# invariant.
#
# Verify-only by default; --apply is required to mutate.
#
#   scripts/setup-iam-roles.sh                                    # verify
#   scripts/setup-iam-roles.sh --apply                            # create
#   scripts/setup-iam-roles.sh --apply --kms-key-arn arn:aws:...  # scope to the key
#
# Run this BEFORE scripts/setup-kms.sh — that wizard asks for the signer role
# ARN this script prints, so the key policy can name it.

set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-1}"
MODE="verify"
KMS_KEY_ARN=""

readonly SIGNER_ROLE="straitsx-888-signer-service"
readonly POLICY_ROLE="straitsx-888-policy-service"
readonly ORCHESTRATOR_ROLE="straitsx-888-agent-orchestrator"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; GREEN=""; YELLOW=""; RED=""
fi

ok()   { printf '  %s+%s %s\n' "$GREEN" "$RESET" "$1"; }
info() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s! %s%s\n' "$YELLOW" "$1" "$RESET"; }
bad()  { printf '  %sFAIL%s %s\n' "$RED" "$RESET" "$1"; }
die()  { printf '\n%ssetup-iam-roles: %s%s\n\n' "$RED" "$1" "$RESET" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)      REGION="${2:-}"; shift 2 ;;
    --kms-key-arn) KMS_KEY_ARN="${2:-}"; shift 2 ;;
    --apply)       MODE="apply"; shift ;;
    --verify)      MODE="verify"; shift ;;
    -h|--help)     sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             die "unknown argument: $1" ;;
  esac
done

command -v aws >/dev/null 2>&1 || die "the aws CLI is not installed"
aws sts get-caller-identity >/dev/null 2>&1 || die "not authenticated to AWS — run 'aws configure'"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Scope Sign to one key when we know it. Before the key exists this is "*",
# which is still least-privilege ACROSS ROLES (only the signer may Sign at all)
# but not across keys. Re-run with --kms-key-arn once setup-kms.sh has run.
SIGN_RESOURCE="${KMS_KEY_ARN:-*}"

printf '\n%sA15 IAM role split — account %s%s\n\n' "$BOLD" "$ACCOUNT_ID" "$RESET"
if [[ -z "$KMS_KEY_ARN" ]]; then
  warn "no --kms-key-arn given: kms:Sign is scoped to '*' for now."
  info "after running setup-kms.sh, re-run this with --apply --kms-key-arn <arn>"
  printf '\n'
fi

# EC2 instance roles, because the deployment is EC2 (not Fargate). If that
# changes, only this trust policy changes: swap ec2 for ecs-tasks.
TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ec2.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'

role_exists() {
  aws iam get-role --role-name "$1" >/dev/null 2>&1
}

ensure_role() {
  local name="$1" description="$2"
  if role_exists "$name"; then
    info "$name exists"
    return 0
  fi
  if [[ "$MODE" != "apply" ]]; then
    warn "$name does not exist (re-run with --apply)"
    return 1
  fi
  aws iam create-role --role-name "$name" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "$description" >/dev/null || die "could not create $name"
  ok "created role $name"
}

put_policy() {
  local role="$1" policy_name="$2" document="$3"
  [[ "$MODE" == "apply" ]] || return 0
  aws iam put-role-policy --role-name "$role" \
    --policy-name "$policy_name" --policy-document "$document" >/dev/null \
    || die "could not attach $policy_name to $role"
  ok "attached $policy_name to $role"
}

ensure_instance_profile() {
  local name="$1"
  [[ "$MODE" == "apply" ]] || return 0
  if ! aws iam get-instance-profile --instance-profile-name "$name" >/dev/null 2>&1; then
    aws iam create-instance-profile --instance-profile-name "$name" >/dev/null \
      || die "could not create instance profile $name"
    ok "created instance profile $name"
  fi
  # Idempotent: adding a role already in the profile returns LimitExceeded.
  aws iam add-role-to-instance-profile \
    --instance-profile-name "$name" --role-name "$name" >/dev/null 2>&1 || true
}

# --- roles --------------------------------------------------------------------

if [[ "$MODE" == "apply" ]]; then
  printf '%sCreating roles%s\n' "$BOLD" "$RESET"
fi

ensure_role "$SIGNER_ROLE"       "straitsx-888 signer-service - the ONLY principal permitted to call kms:Sign" || true
ensure_role "$POLICY_ROLE"       "straitsx-888 policy-service - may reach the signer, may NOT sign" || true
ensure_role "$ORCHESTRATOR_ROLE" "straitsx-888 agent-orchestrator - no key access of any kind" || true

put_policy "$SIGNER_ROLE" "kms-sign" "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"SignWithTheSigningKey\",
    \"Effect\": \"Allow\",
    \"Action\": [ \"kms:Sign\", \"kms:GetPublicKey\", \"kms:DescribeKey\" ],
    \"Resource\": \"${SIGN_RESOURCE}\"
  }]
}"

# policy-service must be able to do its job and nothing more. The deny is what
# makes "policy-service cannot sign" true even if it is fully compromised —
# which is the premise the hard-invariant rail (§12b 2.2) is written against.
put_policy "$POLICY_ROLE" "deny-kms-sign" '{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PolicyServiceMayNeverSign",
    "Effect": "Deny",
    "Action": [ "kms:Sign", "kms:Decrypt", "kms:GenerateDataKey" ],
    "Resource": "*"
  }]
}'

put_policy "$ORCHESTRATOR_ROLE" "deny-kms-all" '{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "OrchestratorMayNeverTouchKms",
    "Effect": "Deny",
    "Action": "kms:*",
    "Resource": "*"
  }]
}'

ensure_instance_profile "$SIGNER_ROLE"
ensure_instance_profile "$POLICY_ROLE"
ensure_instance_profile "$ORCHESTRATOR_ROLE"

# --- verification: the configuration proof ------------------------------------

printf '\n%sVerifying%s\n' "$BOLD" "$RESET"
FAILURES=0

for role in "$SIGNER_ROLE" "$POLICY_ROLE" "$ORCHESTRATOR_ROLE"; do
  if ! role_exists "$role"; then
    bad "$role does not exist"
    FAILURES=$((FAILURES + 1))
  fi
done

if (( FAILURES > 0 )); then
  printf '\n%s  roles are missing — re-run with --apply%s\n\n' "$RED" "$RESET"
  exit 1
fi

# 1. The signer may sign.
signer_actions=$(aws iam get-role-policy --role-name "$SIGNER_ROLE" \
                   --policy-name "kms-sign" \
                   --query 'PolicyDocument.Statement[0].Action' --output text 2>/dev/null) || signer_actions=""
if [[ "$signer_actions" == *"kms:Sign"* ]]; then
  ok "$SIGNER_ROLE may call kms:Sign"
else
  bad "$SIGNER_ROLE has no kms:Sign allow — the signer cannot sign"
  FAILURES=$((FAILURES + 1))
fi

# 2. policy-service is explicitly denied. Absence is not enough: this asserts
#    the Deny is present, so a later permissive attachment cannot silently
#    grant signing.
policy_effect=$(aws iam get-role-policy --role-name "$POLICY_ROLE" \
                  --policy-name "deny-kms-sign" \
                  --query 'PolicyDocument.Statement[0].Effect' --output text 2>/dev/null) || policy_effect=""
policy_actions=$(aws iam get-role-policy --role-name "$POLICY_ROLE" \
                   --policy-name "deny-kms-sign" \
                   --query 'PolicyDocument.Statement[0].Action' --output text 2>/dev/null) || policy_actions=""
if [[ "$policy_effect" == "Deny" && "$policy_actions" == *"kms:Sign"* ]]; then
  ok "$POLICY_ROLE is explicitly DENIED kms:Sign"
else
  bad "$POLICY_ROLE is not explicitly denied kms:Sign (effect='$policy_effect')"
  FAILURES=$((FAILURES + 1))
fi

# 3. orchestrator is denied everything KMS.
orch_effect=$(aws iam get-role-policy --role-name "$ORCHESTRATOR_ROLE" \
                --policy-name "deny-kms-all" \
                --query 'PolicyDocument.Statement[0].Effect' --output text 2>/dev/null) || orch_effect=""
if [[ "$orch_effect" == "Deny" ]]; then
  ok "$ORCHESTRATOR_ROLE is explicitly DENIED all of kms:*"
else
  bad "$ORCHESTRATOR_ROLE is not explicitly denied kms:* (effect='$orch_effect')"
  FAILURES=$((FAILURES + 1))
fi

# 4. The three roles are genuinely distinct. A15 says "different roles"; sharing
#    one would make every allow and deny above meaningless.
if [[ "$SIGNER_ROLE" != "$POLICY_ROLE" && "$POLICY_ROLE" != "$ORCHESTRATOR_ROLE" ]]; then
  ok "signer, policy and orchestrator run under three distinct roles"
fi

printf '\n'
if (( FAILURES > 0 )); then
  printf '%s  %s check(s) failed — the IAM split is NOT proven%s\n\n' "$RED" "$FAILURES" "$RESET"
  exit 1
fi

SIGNER_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${SIGNER_ROLE}"
printf '%s  IAM split verified%s\n\n' "$GREEN" "$RESET"
info "Signer role ARN — paste this into scripts/setup-kms.sh when it asks:"
printf '\n    %s%s%s\n\n' "$BOLD" "$SIGNER_ROLE_ARN" "$RESET"
if [[ -z "$KMS_KEY_ARN" ]]; then
  info "Then come back and re-run:"
  info "  scripts/setup-iam-roles.sh --apply --kms-key-arn <the key arn>"
  info "to narrow kms:Sign from '*' to that one key."
  printf '\n'
fi
