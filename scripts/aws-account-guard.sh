#!/usr/bin/env bash
set -euo pipefail

readonly target_account_id="808198486011"
readonly target_region="ap-southeast-1"
readonly deployment_role_name="straitsx-888-deployer"

die() {
  printf 'aws-account-guard: %s\n' "$1" >&2
  exit 1
}

: "${EXPECTED_AWS_ACCOUNT_ID:?EXPECTED_AWS_ACCOUNT_ID must be set}"
: "${AWS_REGION:?AWS_REGION must be set}"

mode="routine"
if [[ "${1:-}" == "--bootstrap" && $# -eq 1 ]]; then
  mode="bootstrap"
elif [[ $# -ne 0 ]]; then
  die "usage: $0 [--bootstrap]"
fi

[[ "$EXPECTED_AWS_ACCOUNT_ID" == "$target_account_id" ]] ||
  die "configured account must be ${target_account_id}"
[[ "$AWS_REGION" == "$target_region" ]] ||
  die "wrong AWS Region: expected ${target_region}, got ${AWS_REGION}"
command -v aws >/dev/null 2>&1 || die "aws CLI is not installed"
command -v jq >/dev/null 2>&1 || die "jq is not installed"

identity_json="$(aws sts get-caller-identity --output json)" ||
  die "could not read AWS caller identity"
actual_account_id="$(jq -er '.Account' <<<"$identity_json")" ||
  die "AWS caller identity did not contain an account"
caller_arn="$(jq -er '.Arn' <<<"$identity_json")" ||
  die "AWS caller identity did not contain an ARN"

[[ "$actual_account_id" == "$target_account_id" ]] ||
  die "wrong AWS account: expected ${target_account_id}, got ${actual_account_id}"
[[ "$caller_arn" != "arn:aws:iam::${target_account_id}:root" ]] ||
  die "root identity is forbidden"

expected_role_prefix="arn:aws:sts::${target_account_id}:assumed-role/${deployment_role_name}/"
if [[ "$mode" == "routine" ]]; then
  [[ "$caller_arn" == "${expected_role_prefix}"* ]] ||
    die "deployment role is required for routine operations"
  identity_label="deployment role ${deployment_role_name}"
else
  approved_user_arn="arn:aws:iam::${target_account_id}:user/Straitsx"
  [[ "$caller_arn" == "$approved_user_arn" || "$caller_arn" == "${expected_role_prefix}"* ]] ||
    die "bootstrap principal is not approved"
  identity_label="bootstrap principal"
fi

printf 'aws-account-guard: verified %s in account %s (%s)\n' \
  "$identity_label" "$actual_account_id" "$target_region"
