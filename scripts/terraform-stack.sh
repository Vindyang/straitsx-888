#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'terraform-stack: %s\n' "$1" >&2
  exit 1
}

if [[ $# -ne 4 ]]; then
  die "usage: $0 <bootstrap|foundation|module-c|module-ab|integration> <tfvars-file> <--plan|--apply> <plan-file>"
fi

stage="$1"
tfvars_file="$2"
operation="$3"
plan_file="$4"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$stage" in
  bootstrap) stack_relative="infra/bootstrap" ;;
  foundation) stack_relative="infra/foundation" ;;
  module-c) stack_relative="infra/module-c" ;;
  module-ab) stack_relative="infra/module-ab" ;;
  integration) stack_relative="infra/module-c-integration" ;;
  *) die "unknown stack: $stage" ;;
esac
stack_dir="${repo_root}/${stack_relative}"

[[ -f "$tfvars_file" ]] || die "tfvars file does not exist: $tfvars_file"
[[ ! -L "$tfvars_file" ]] || die "symbolic links are forbidden for deployment artifacts"

if file_mode="$(stat -f '%Lp' "$tfvars_file" 2>/dev/null)"; then
  :
else
  file_mode="$(stat -c '%a' "$tfvars_file" 2>/dev/null)" ||
    die "could not inspect tfvars permissions"
fi
[[ "$file_mode" == "600" ]] ||
  die "tfvars permissions must be 0600; got 0${file_mode}"

readonly placeholder_pattern='replace-me|111122223333|732031180826|203\.0\.113\.|subnet-private-|subnet-public-|/absolute/path|ACCOUNT\.dkr\.ecr|example\.com'
if grep -Eq "$placeholder_pattern" "$tfvars_file"; then
  die "tfvars contains an example placeholder or forbidden old-account reference"
fi

case "$operation" in
  --plan | --apply) ;;
  *) die "operation must be --plan or --apply" ;;
esac

[[ "$plan_file" == /* && "$plan_file" == *.tfplan ]] ||
  die "plan file must be an absolute /tmp path ending in .tfplan"
[[ "$plan_file" != *"/../"* && "$plan_file" != *"/./"* ]] ||
  die "plan file must use a canonical /tmp path"
temp_root="$(cd /tmp && pwd -P)"
plan_parent="$(cd "$(dirname "$plan_file")" 2>/dev/null && pwd -P)" ||
  die "plan file parent directory does not exist"
[[ "$plan_parent" == "$temp_root" || "$plan_parent" == "${temp_root}/"* ]] ||
  die "plan file must use a canonical /tmp path"

if [[ "$operation" == "--apply" && ! -f "$plan_file" ]]; then
  die "reviewed plan does not exist: $plan_file"
fi
if [[ "$operation" == "--apply" && -L "$plan_file" ]]; then
  die "symbolic links are forbidden for deployment artifacts"
fi

[[ -d "$stack_dir" ]] || die "stack directory does not exist: $stack_relative"
command -v terraform >/dev/null 2>&1 || die "terraform is not installed"

if [[ "$stage" == "bootstrap" ]]; then
  "${repo_root}/scripts/aws-account-guard.sh" --bootstrap
else
  "${repo_root}/scripts/aws-account-guard.sh"
fi

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

umask 077
metadata_file="${plan_file}.metadata"

if [[ "$operation" == "--plan" ]]; then
  [[ ! -e "$plan_file" && ! -e "$metadata_file" ]] ||
    die "refusing to overwrite an existing plan or metadata file"

  terraform -chdir="$stack_dir" fmt -check
  terraform -chdir="$stack_dir" init -reconfigure
  terraform -chdir="$stack_dir" validate
  terraform -chdir="$stack_dir" plan -var-file="$tfvars_file" -out="$plan_file"
  chmod 0600 "$plan_file"
  terraform -chdir="$stack_dir" show "$plan_file"

  plan_sha256="$(sha256_file "$plan_file")"
  printf 'stage=%s\nplan_sha256=%s\n' "$stage" "$plan_sha256" >"$metadata_file"
  chmod 0600 "$metadata_file"
  printf 'terraform-stack: plan created for review: %s\n' "$plan_file"
  exit 0
fi

[[ -f "$metadata_file" ]] || die "reviewed plan metadata does not exist: $metadata_file"
[[ ! -L "$metadata_file" ]] || die "symbolic links are forbidden for deployment artifacts"

if plan_mode="$(stat -f '%Lp' "$plan_file" 2>/dev/null)"; then
  metadata_mode="$(stat -f '%Lp' "$metadata_file" 2>/dev/null)" ||
    die "could not inspect plan metadata permissions"
else
  plan_mode="$(stat -c '%a' "$plan_file" 2>/dev/null)" ||
    die "could not inspect plan permissions"
  metadata_mode="$(stat -c '%a' "$metadata_file" 2>/dev/null)" ||
    die "could not inspect plan metadata permissions"
fi
[[ "$plan_mode" == "600" && "$metadata_mode" == "600" ]] ||
  die "reviewed plan and metadata permissions must be 0600"

metadata_stage="$(awk -F= '$1 == "stage" { print substr($0, index($0, "=") + 1) }' "$metadata_file")"
metadata_sha256="$(awk -F= '$1 == "plan_sha256" { print substr($0, index($0, "=") + 1) }' "$metadata_file")"
[[ "$metadata_stage" == "$stage" ]] ||
  die "reviewed plan belongs to stack ${metadata_stage:-unknown}, not ${stage}"
[[ "$metadata_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  die "reviewed plan metadata contains an invalid checksum"

actual_plan_sha256="$(sha256_file "$plan_file")"
[[ "$actual_plan_sha256" == "$metadata_sha256" ]] ||
  die "plan checksum does not match reviewed metadata"

terraform -chdir="$stack_dir" apply "$plan_file"
printf 'terraform-stack: reviewed plan applied for %s\n' "$stage"
