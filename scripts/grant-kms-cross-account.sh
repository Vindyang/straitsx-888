#!/usr/bin/env bash
#
# Let signer-service run in a DIFFERENT AWS account than the one holding the key.
#
#   scripts/grant-kms-cross-account.sh --account 732031180826            # verify
#   scripts/grant-kms-cross-account.sh --account 732031180826 --apply    # grant
#
# WHY THIS EXISTS. Module C is deployed in account 732031180826; the KMS key and
# the A11 custody proof live in 808198486011. The obvious move — create a new key
# in C's account — is the wrong one: a new key derives a NEW ADDRESS, which
# invalidates the custody proof, strands the 20 XSGD at the old address, and
# orphans both settled transactions. Keep the key, extend who may use it.
#
# CROSS-ACCOUNT KMS NEEDS BOTH SIDES, and forgetting either produces an
# AccessDenied that reads like the other one:
#
#   1. the KEY POLICY must name the external principal   <- this script
#   2. the external role's IAM POLICY must allow kms:Sign on the key ARN
#      <- scripts/setup-iam-roles.sh --apply --kms-key-arn <arn>, run in
#         the OTHER account
#
# Run this against the account that OWNS the key, then run setup-iam-roles.sh
# against the account that RUNS the signer.

set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-1}"
MODE="verify"
TARGET_ACCOUNT=""
ROLE_NAME="straitsx-888-signer-service"
KEY_ID="${KMS_KEY_ID:-}"
SID="AllowCrossAccountSignerServiceToSignOnly"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; GREEN=""; YELLOW=""; RED=""
fi
ok()   { printf '  %s+%s %s\n' "$GREEN" "$RESET" "$1"; }
info() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s! %s%s\n' "$YELLOW" "$1" "$RESET"; }
die()  { printf '\n%sgrant-kms-cross-account: %s%s\n\n' "$RED" "$1" "$RESET" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --account) TARGET_ACCOUNT="${2:-}"; shift 2 ;;
    --role)    ROLE_NAME="${2:-}"; shift 2 ;;
    --key-id)  KEY_ID="${2:-}"; shift 2 ;;
    --region)  REGION="${2:-}"; shift 2 ;;
    --apply)   MODE="apply"; shift ;;
    --verify)  MODE="verify"; shift ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "unknown argument: $1" ;;
  esac
done

command -v aws >/dev/null 2>&1 || die "the aws CLI is not installed"
command -v jq  >/dev/null 2>&1 || die "jq is required to edit the key policy safely"
[[ "$TARGET_ACCOUNT" =~ ^[0-9]{12}$ ]] || die "--account must be a 12-digit AWS account id"

# Fall back to .env so the usual case needs no flags.
if [[ -z "$KEY_ID" && -f .env ]]; then
  KEY_ID="$(grep -E '^KMS_KEY_ID=' .env | cut -d= -f2- || true)"
fi
[[ -n "$KEY_ID" ]] || die "--key-id is required (or set KMS_KEY_ID, or run from a repo with .env)"

OWNER_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" \
  || die "not authenticated to AWS"

if [[ "$OWNER_ACCOUNT" == "$TARGET_ACCOUNT" ]]; then
  die "--account $TARGET_ACCOUNT is the account you are already in. Cross-account grant is not needed; use setup-iam-roles.sh."
fi

EXTERNAL_ROLE_ARN="arn:aws:iam::${TARGET_ACCOUNT}:role/${ROLE_NAME}"

printf '\n%sCross-account KMS grant%s\n' "$BOLD" "$RESET"
info "key owner account : $OWNER_ACCOUNT"
info "granting to       : $EXTERNAL_ROLE_ARN"
printf '\n'

CURRENT="$(aws kms get-key-policy --region "$REGION" --key-id "$KEY_ID" \
            --policy-name default --query Policy --output text)" \
  || die "could not read the key policy — check the key id and your permissions"

KEY_ARN="$(aws kms describe-key --region "$REGION" --key-id "$KEY_ID" \
            --query KeyMetadata.Arn --output text)"

# --- apply ---------------------------------------------------------------------

if [[ "$MODE" == "apply" ]]; then
  # Idempotent: replace any statement with our Sid rather than appending a
  # duplicate, so re-running never grows the policy.
  UPDATED="$(jq --arg sid "$SID" --arg arn "$EXTERNAL_ROLE_ARN" '
    .Statement = ([.Statement[] | select(.Sid != $sid)] + [{
      Sid: $sid,
      Effect: "Allow",
      Principal: { AWS: $arn },
      Action: ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"],
      Resource: "*"
    }])
  ' <<<"$CURRENT")"

  # A malformed policy can lock the key. Sanity-check before writing.
  jq -e '.Statement | length >= 2' >/dev/null <<<"$UPDATED" \
    || die "refusing to write: the rebuilt policy lost statements"
  jq -e --arg a "arn:aws:iam::${OWNER_ACCOUNT}:root" \
    '[.Statement[] | select(.Principal.AWS == $a)] | length == 1' >/dev/null <<<"$UPDATED" \
    || die "refusing to write: the account-root administration statement would be lost"

  aws kms put-key-policy --region "$REGION" --key-id "$KEY_ID" \
    --policy-name default --policy "$UPDATED" \
    || die "put-key-policy failed"
  ok "key policy updated"
  CURRENT="$UPDATED"
fi

# --- verify --------------------------------------------------------------------

printf '%sPrincipals allowed to Sign%s\n' "$BOLD" "$RESET"
jq -r '.Statement[] | select((.Action | tostring) | contains("kms:Sign")) | "    " + (.Principal.AWS // "?")' <<<"$CURRENT"
printf '\n'

if jq -e --arg arn "$EXTERNAL_ROLE_ARN" \
     '[.Statement[] | select(.Principal.AWS == $arn) | select((.Action|tostring)|contains("kms:Sign"))] | length > 0' \
     >/dev/null <<<"$CURRENT"; then
  ok "$EXTERNAL_ROLE_ARN may Sign with this key"
else
  warn "$EXTERNAL_ROLE_ARN is NOT yet allowed. Re-run with --apply."
  exit 1
fi

printf '\n%sHalf done. The other half runs in account %s:%s\n\n' "$BOLD" "$TARGET_ACCOUNT" "$RESET"
info "  scripts/setup-iam-roles.sh --apply --kms-key-arn $KEY_ARN"
printf '\n'
info "A key policy alone is not enough for cross-account access: the role's own"
info "IAM policy must also allow kms:Sign on that ARN. Miss it and you get an"
info "AccessDenied that looks exactly like this grant never happened."
printf '\n'
info "Then confirm end to end by booting signer-service in $TARGET_ACCOUNT and"
info "checking GET /health returns derivedAddress 0x0F6DdD...7CA7 — the same"
info "address, because it is the same key."
printf '\n'
