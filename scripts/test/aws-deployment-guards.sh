#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="${repo_root}/scripts/aws-account-guard.sh"
stack_runner="${repo_root}/scripts/terraform-stack.sh"
test_root="$(mktemp -d /tmp/straitsx-aws-guard.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "${test_root}/bin"
backend_config="${test_root}/backend.hcl"
cat >"$backend_config" <<'BACKEND_CONFIG'
bucket       = "straitsx-888-808198486011-ap-southeast-1-tfstate"
key          = "test/terraform.tfstate"
region       = "ap-southeast-1"
encrypt      = true
use_lockfile = true
BACKEND_CONFIG
chmod 0600 "$backend_config"

cat >"${test_root}/bin/aws" <<'FAKE_AWS'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "sts" && "${2:-}" == "get-caller-identity" ]]; then
  printf '{"Account":"%s","Arn":"%s","UserId":"test"}\n' \
    "${FAKE_AWS_ACCOUNT:?}" "${FAKE_AWS_ARN:?}"
  exit 0
fi

printf 'unexpected fake aws invocation: %s\n' "$*" >&2
exit 90
FAKE_AWS
chmod +x "${test_root}/bin/aws"

cat >"${test_root}/bin/terraform" <<'FAKE_TERRAFORM'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${FAKE_TERRAFORM_LOG:?}"
is_plan=false
plan_file=""
for argument in "$@"; do
  [[ "$argument" == "plan" ]] && is_plan=true
  if [[ "$argument" == -out=* ]]; then
    plan_file="${argument#-out=}"
  fi
done
if [[ "$is_plan" == true ]]; then
  [[ -n "$plan_file" ]] || exit 91
  printf 'fake reviewed plan\n' >"$plan_file"
fi
FAKE_TERRAFORM
chmod +x "${test_root}/bin/terraform"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

test_wrong_account_is_rejected() {
  local output status

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="111122223333" \
    FAKE_AWS_ARN="arn:aws:iam::111122223333:user/test" \
      bash "$guard"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "wrong account was accepted"
  [[ "$output" == *"wrong AWS account"* ]] || fail "wrong-account error was not explicit: $output"
}

test_wrong_region_is_rejected() {
  local output status

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="us-east-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:iam::808198486011:user/Straitsx" \
      bash "$guard"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "wrong Region was accepted"
  [[ "$output" == *"wrong AWS Region"* ]] || fail "wrong-Region error was not explicit: $output"
}

test_root_is_rejected() {
  local output status

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:iam::808198486011:root" \
      bash "$guard"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "root identity was accepted"
  [[ "$output" == *"root identity is forbidden"* ]] || fail "root error was not explicit: $output"
}

test_standing_user_is_rejected_for_routine_deployment() {
  local output status

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:iam::808198486011:user/Straitsx" \
      bash "$guard"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "standing IAM user was accepted for routine deployment"
  [[ "$output" == *"deployment role is required"* ]] || fail "role error was not explicit: $output"
}

test_unapproved_bootstrap_principal_is_rejected() {
  local output status

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:iam::808198486011:user/SomeoneElse" \
      bash "$guard" --bootstrap
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "unapproved bootstrap principal was accepted"
  [[ "$output" == *"bootstrap principal is not approved"* ]] || fail "bootstrap principal error was not explicit: $output"
}

test_approved_deployment_role_is_accepted() {
  local output

  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:sts::808198486011:assumed-role/straitsx-888-deployer/test-session" \
      bash "$guard"
  } 2>&1)" || fail "approved deployment role was rejected: $output"

  [[ "$output" == *"verified deployment role"* ]] || fail "role confirmation was missing: $output"
  [[ "$output" != *"test-session"* ]] || fail "role session name leaked into output"
}

test_unsafe_tfvars_permissions_are_rejected() {
  local output status tfvars_file
  tfvars_file="${test_root}/unsafe.tfvars"
  printf 'aws_region = "ap-southeast-1"\n' >"$tfvars_file"
  chmod 0644 "$tfvars_file"

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:sts::808198486011:assumed-role/straitsx-888-deployer/test-session" \
      bash "$stack_runner" foundation "$tfvars_file" --plan "${test_root}/foundation.tfplan"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "unsafe tfvars permissions were accepted"
  [[ "$output" == *"permissions must be 0600"* ]] || fail "tfvars permission error was not explicit: $output"
}

test_tfvars_placeholders_are_rejected() {
  local output status tfvars_file
  tfvars_file="${test_root}/placeholder.tfvars"
  printf 'dashboard_image = "replace-me"\n' >"$tfvars_file"
  chmod 0600 "$tfvars_file"

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:sts::808198486011:assumed-role/straitsx-888-deployer/test-session" \
      bash "$stack_runner" foundation "$tfvars_file" --plan "${test_root}/foundation.tfplan"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "tfvars placeholder was accepted"
  [[ "$output" == *"contains an example placeholder"* ]] || fail "placeholder error was not explicit: $output"
}

test_apply_without_reviewed_plan_is_rejected() {
  local output status tfvars_file
  tfvars_file="${test_root}/safe.tfvars"
  printf 'aws_region = "ap-southeast-1"\n' >"$tfvars_file"
  chmod 0600 "$tfvars_file"

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:sts::808198486011:assumed-role/straitsx-888-deployer/test-session" \
      bash "$stack_runner" foundation "$tfvars_file" --apply "/tmp/missing-reviewed.tfplan"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "apply without a reviewed plan was accepted"
  [[ "$output" == *"reviewed plan does not exist"* ]] || fail "missing-plan error was not explicit: $output"
}

test_plan_creates_private_review_artifacts() {
  local output plan_file tfvars_file terraform_log
  tfvars_file="${test_root}/plan-safe.tfvars"
  plan_file="${test_root}/module-c.tfplan"
  terraform_log="${test_root}/terraform.log"
  printf 'aws_region = "ap-southeast-1"\n' >"$tfvars_file"
  chmod 0600 "$tfvars_file"
  : >"$terraform_log"

  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:sts::808198486011:assumed-role/straitsx-888-deployer/test-session" \
    FAKE_TERRAFORM_LOG="$terraform_log" \
    TF_BACKEND_CONFIG="$backend_config" \
      bash "$stack_runner" module-c "$tfvars_file" --plan "$plan_file"
  } 2>&1)" || fail "valid plan request failed: $output"

  [[ -f "$plan_file" ]] || fail "saved plan was not created"
  [[ -f "${plan_file}.metadata" ]] || fail "plan metadata was not created"
  [[ "$(stat -f '%Lp' "$plan_file")" == "600" ]] || fail "saved plan was not mode 0600"
  [[ "$(stat -f '%Lp' "${plan_file}.metadata")" == "600" ]] || fail "plan metadata was not mode 0600"
  [[ "$output" == *"plan created for review"* ]] || fail "plan review message was missing: $output"
  [[ "$(sed -n '1p' "$terraform_log")" == *"fmt -check"* ]] || fail "fmt did not run first"
  [[ "$(sed -n '2p' "$terraform_log")" == *"init -reconfigure -backend-config=$backend_config"* ]] || fail "init did not use the reviewed backend config"
  [[ "$(sed -n '3p' "$terraform_log")" == *"validate"* ]] || fail "validate did not run third"
  [[ "$(sed -n '4p' "$terraform_log")" == *"plan"* ]] || fail "plan did not run fourth"
  [[ "$(sed -n '5p' "$terraform_log")" == *"show"* ]] || fail "show did not run fifth"
}

test_routine_plan_requires_backend_config() {
  local output plan_file status tfvars_file terraform_log
  tfvars_file="${test_root}/missing-backend.tfvars"
  plan_file="${test_root}/missing-backend.tfplan"
  terraform_log="${test_root}/missing-backend-terraform.log"
  printf 'aws_region = "ap-southeast-1"\n' >"$tfvars_file"
  chmod 0600 "$tfvars_file"
  : >"$terraform_log"

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:sts::808198486011:assumed-role/straitsx-888-deployer/test-session" \
    FAKE_TERRAFORM_LOG="$terraform_log" \
      bash "$stack_runner" module-c "$tfvars_file" --plan "$plan_file"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "routine plan without backend config was accepted"
  [[ "$output" == *"TF_BACKEND_CONFIG is required"* ]] || fail "missing-backend error was not explicit: $output"
  [[ ! -s "$terraform_log" ]] || fail "Terraform ran without a backend config"
}

test_unsafe_backend_config_permissions_are_rejected() {
  local output plan_file status tfvars_file terraform_log unsafe_backend
  tfvars_file="${test_root}/unsafe-backend.tfvars"
  plan_file="${test_root}/unsafe-backend.tfplan"
  terraform_log="${test_root}/unsafe-backend-terraform.log"
  unsafe_backend="${test_root}/unsafe-backend.hcl"
  printf 'aws_region = "ap-southeast-1"\n' >"$tfvars_file"
  printf 'bucket = "straitsx-888-state"\n' >"$unsafe_backend"
  chmod 0600 "$tfvars_file"
  chmod 0644 "$unsafe_backend"
  : >"$terraform_log"

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:sts::808198486011:assumed-role/straitsx-888-deployer/test-session" \
    FAKE_TERRAFORM_LOG="$terraform_log" \
    TF_BACKEND_CONFIG="$unsafe_backend" \
      bash "$stack_runner" module-c "$tfvars_file" --plan "$plan_file"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "unsafe backend config permissions were accepted"
  [[ "$output" == *"backend config permissions must be 0600"* ]] || fail "backend permission error was not explicit: $output"
  [[ ! -s "$terraform_log" ]] || fail "Terraform ran with unsafe backend config permissions"
}

test_bootstrap_local_state_requires_explicit_mode() {
  local output plan_file status tfvars_file terraform_log
  tfvars_file="${test_root}/bootstrap-local.tfvars"
  plan_file="${test_root}/bootstrap-local.tfplan"
  terraform_log="${test_root}/bootstrap-local-terraform.log"
  printf 'aws_region = "ap-southeast-1"\n' >"$tfvars_file"
  chmod 0600 "$tfvars_file"
  : >"$terraform_log"

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:iam::808198486011:user/Straitsx" \
    FAKE_TERRAFORM_LOG="$terraform_log" \
      bash "$stack_runner" bootstrap "$tfvars_file" --plan "$plan_file"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "implicit local bootstrap state was accepted"
  [[ "$output" == *"TF_BOOTSTRAP_LOCAL_STATE=1"* ]] || fail "local bootstrap mode error was not explicit: $output"
  [[ ! -s "$terraform_log" ]] || fail "Terraform ran without explicit local bootstrap mode"

  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:iam::808198486011:user/Straitsx" \
    FAKE_TERRAFORM_LOG="$terraform_log" \
    TF_BOOTSTRAP_LOCAL_STATE=1 \
      bash "$stack_runner" bootstrap "$tfvars_file" --plan "$plan_file"
  } 2>&1)" || fail "explicit local bootstrap plan failed: $output"

  [[ "$(sed -n '2p' "$terraform_log")" == *"init -reconfigure -backend=false"* ]] || fail "bootstrap local plan did not disable the backend"
}

test_tampered_plan_is_rejected() {
  local output plan_file status tfvars_file terraform_log
  tfvars_file="${test_root}/apply-safe.tfvars"
  plan_file="${test_root}/tampered.tfplan"
  terraform_log="${test_root}/tampered-terraform.log"
  printf 'aws_region = "ap-southeast-1"\n' >"$tfvars_file"
  printf 'original plan\n' >"$plan_file"
  printf 'stage=module-c\nplan_sha256=%064d\n' 0 >"${plan_file}.metadata"
  chmod 0600 "$tfvars_file" "$plan_file" "${plan_file}.metadata"
  : >"$terraform_log"

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:sts::808198486011:assumed-role/straitsx-888-deployer/test-session" \
    FAKE_TERRAFORM_LOG="$terraform_log" \
      bash "$stack_runner" module-c "$tfvars_file" --apply "$plan_file"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "tampered plan was applied"
  [[ "$output" == *"plan checksum does not match"* ]] || fail "checksum error was not explicit: $output"
  [[ ! -s "$terraform_log" ]] || fail "Terraform ran for a tampered plan"
}

test_reviewed_plan_is_applied_exactly_once() {
  local output plan_file plan_sha tfvars_file terraform_log
  tfvars_file="${test_root}/reviewed-apply.tfvars"
  plan_file="${test_root}/reviewed.tfplan"
  terraform_log="${test_root}/reviewed-terraform.log"
  printf 'aws_region = "ap-southeast-1"\n' >"$tfvars_file"
  printf 'reviewed plan bytes\n' >"$plan_file"
  plan_sha="$(shasum -a 256 "$plan_file" | awk '{print $1}')"
  printf 'stage=module-c\nplan_sha256=%s\n' "$plan_sha" >"${plan_file}.metadata"
  chmod 0600 "$tfvars_file" "$plan_file" "${plan_file}.metadata"
  : >"$terraform_log"

  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:sts::808198486011:assumed-role/straitsx-888-deployer/test-session" \
    FAKE_TERRAFORM_LOG="$terraform_log" \
      bash "$stack_runner" module-c "$tfvars_file" --apply "$plan_file"
  } 2>&1)" || fail "reviewed plan apply failed: $output"

  [[ "$(wc -l <"$terraform_log" | tr -d ' ')" == "1" ]] || fail "apply invoked Terraform more than once"
  [[ "$(sed -n '1p' "$terraform_log")" == *" apply $plan_file"* ]] || fail "saved plan was not applied exactly"
  [[ "$output" == *"reviewed plan applied"* ]] || fail "apply confirmation was missing: $output"
}

test_plan_path_traversal_is_rejected() {
  local escaped_plan output status tfvars_file
  tfvars_file="${test_root}/traversal-safe.tfvars"
  escaped_plan="/tmp/../tmp/${test_root#/tmp/}/escaped.tfplan"
  printf 'aws_region = "ap-southeast-1"\n' >"$tfvars_file"
  chmod 0600 "$tfvars_file"

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:sts::808198486011:assumed-role/straitsx-888-deployer/test-session" \
    FAKE_TERRAFORM_LOG="${test_root}/traversal-terraform.log" \
      bash "$stack_runner" module-c "$tfvars_file" --plan "$escaped_plan"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "plan path traversal was accepted"
  [[ "$output" == *"canonical /tmp path"* ]] || fail "path-traversal error was not explicit: $output"
}

test_symlinked_plan_is_rejected() {
  local output plan_file plan_sha status target_plan tfvars_file terraform_log
  tfvars_file="${test_root}/symlink-safe.tfvars"
  target_plan="${test_root}/target.tfplan"
  plan_file="${test_root}/symlink.tfplan"
  terraform_log="${test_root}/symlink-terraform.log"
  printf 'aws_region = "ap-southeast-1"\n' >"$tfvars_file"
  printf 'target plan bytes\n' >"$target_plan"
  ln -s "$target_plan" "$plan_file"
  plan_sha="$(shasum -a 256 "$target_plan" | awk '{print $1}')"
  printf 'stage=module-c\nplan_sha256=%s\n' "$plan_sha" >"${plan_file}.metadata"
  chmod 0600 "$tfvars_file" "$target_plan" "${plan_file}.metadata"
  : >"$terraform_log"

  set +e
  output="$({
    PATH="${test_root}/bin:${PATH}" \
    EXPECTED_AWS_ACCOUNT_ID="808198486011" \
    AWS_REGION="ap-southeast-1" \
    FAKE_AWS_ACCOUNT="808198486011" \
    FAKE_AWS_ARN="arn:aws:sts::808198486011:assumed-role/straitsx-888-deployer/test-session" \
    FAKE_TERRAFORM_LOG="$terraform_log" \
      bash "$stack_runner" module-c "$tfvars_file" --apply "$plan_file"
  } 2>&1)"
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail "symlinked plan was accepted"
  [[ "$output" == *"symbolic links are forbidden"* ]] || fail "symlink error was not explicit: $output"
  [[ ! -s "$terraform_log" ]] || fail "Terraform ran for a symlinked plan"
}

test_wrong_account_is_rejected
test_wrong_region_is_rejected
test_root_is_rejected
test_standing_user_is_rejected_for_routine_deployment
test_unapproved_bootstrap_principal_is_rejected
test_approved_deployment_role_is_accepted
test_unsafe_tfvars_permissions_are_rejected
test_tfvars_placeholders_are_rejected
test_apply_without_reviewed_plan_is_rejected
test_routine_plan_requires_backend_config
test_unsafe_backend_config_permissions_are_rejected
test_bootstrap_local_state_requires_explicit_mode
test_plan_creates_private_review_artifacts
test_tampered_plan_is_rejected
test_reviewed_plan_is_applied_exactly_once
test_plan_path_traversal_is_rejected
test_symlinked_plan_is_rejected
printf 'PASS aws deployment guard tests\n'
