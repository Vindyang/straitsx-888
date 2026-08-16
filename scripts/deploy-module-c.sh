#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -ne 4 ]]; then
  printf 'usage: %s <module-c|integration> <tfvars-file> <--plan|--apply> </tmp/reviewed.tfplan>\n' "$0" >&2
  exit 64
fi

stage="$1"
case "$stage" in
  module-c | integration) ;;
  *)
    printf 'stage must be module-c or integration\n' >&2
    exit 64
    ;;
esac

exec "${repo_root}/scripts/terraform-stack.sh" "$@"
