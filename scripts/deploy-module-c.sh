#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <module-c|integration> <tfvars-file> [--apply]" >&2
  exit 64
fi

stage="$1"
tfvars_file="$2"
apply_mode="${3:-}"

case "$stage" in
  module-c) stack_relative="infra/module-c" ;;
  integration) stack_relative="infra/module-c-integration" ;;
  *) echo "stage must be module-c or integration" >&2; exit 64 ;;
esac

if [[ ! -f "$tfvars_file" ]]; then
  echo "tfvars file does not exist: $tfvars_file" >&2
  echo "create one with:" >&2
  if [[ "$stage" == "module-c" ]]; then
    echo "  cp infra/module-c/terraform.standalone.tfvars.example /tmp/module-c.tfvars" >&2
  else
    echo "  cp ${stack_relative}/terraform.tfvars.example /tmp/${stage}.tfvars" >&2
  fi
  echo "then replace every example value before rerunning this command" >&2
  exit 66
fi
if [[ -n "$apply_mode" && "$apply_mode" != "--apply" ]]; then
  echo "third argument, when present, must be --apply" >&2
  exit 64
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stack_dir="${repo_root}/${stack_relative}"
tfvars_file="$(cd "$(dirname "$tfvars_file")" && pwd)/$(basename "$tfvars_file")"

placeholder_pattern='replace-me|111122223333|203\.0\.113\.|subnet-private-|subnet-public-|/absolute/path|ACCOUNT\.dkr\.ecr'
if grep -En "$placeholder_pattern" "$tfvars_file" >&2; then
  echo "tfvars still contains example placeholders; replace the lines shown above" >&2
  exit 65
fi

plan_file="$(mktemp "/tmp/${stage}.XXXXXX.tfplan")"
trap 'rm -f "$plan_file"' EXIT

terraform -chdir="$stack_dir" fmt -check
terraform -chdir="$stack_dir" init -reconfigure
terraform -chdir="$stack_dir" validate
terraform -chdir="$stack_dir" plan -var-file="$tfvars_file" -out="$plan_file"
terraform -chdir="$stack_dir" show "$plan_file"

if [[ "$apply_mode" == "--apply" ]]; then
  terraform -chdir="$stack_dir" apply "$plan_file"
else
  echo "plan only; rerun with --apply after review"
fi
