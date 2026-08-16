#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [release-tag]" >&2
  exit 64
fi

: "${AWS_REGION:?AWS_REGION must name the deployment Region}"

release_tag="${1:-$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%SZ)}"
target_platform="${TARGET_PLATFORM:-linux/amd64}"
registry_prefix="${ECR_REGISTRY_PREFIX:-straitsx}"

if [[ ! "$release_tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "release tag is not a valid Docker/ECR tag: $release_tag" >&2
  exit 64
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

account_id="$(aws sts get-caller-identity --query Account --output text)"
if [[ ! "$account_id" =~ ^[0-9]{12}$ ]]; then
  echo "AWS STS returned an invalid account ID: $account_id" >&2
  exit 69
fi

registry="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# A/B images are built from the single root Dockerfile with build-args; Module C
# images have their own Dockerfiles. Lines are "repository|docker args".
jobs=(
  "${registry_prefix}/ledger-service|--build-arg SERVICE_ENTRY=services/ledger-service/src/index.ts --build-arg SERVICE_PORT=4001 -f Dockerfile"
  "${registry_prefix}/policy-service|--build-arg SERVICE_ENTRY=services/policy-service/src/index.ts --build-arg SERVICE_PORT=4002 -f Dockerfile"
  "${registry_prefix}/signer-service|--build-arg SERVICE_ENTRY=services/signer-service/src/main.ts --build-arg SERVICE_PORT=4003 -f Dockerfile"
  "${registry_prefix}/chain-gateway|--build-arg SERVICE_ENTRY=services/chain-gateway/src/main.ts --build-arg SERVICE_PORT=4004 -f Dockerfile"
  "${registry_prefix}/module-c-dashboard|-f services/dashboard/Dockerfile"
  "${registry_prefix}/module-c-orchestrator|-f services/agent-orchestrator/Dockerfile"
)

for entry in "${jobs[@]}"; do
  repository="${entry%%|*}"
  if [[ "$repository" != "${registry_prefix}/"* ]]; then
    echo "repository name is not under ${registry_prefix}/: $repository" >&2
    exit 65
  fi
done

for entry in "${jobs[@]}"; do
  repository="${entry%%|*}"
  if ! aws ecr describe-repositories \
    --region "$AWS_REGION" \
    --repository-names "$repository" >/dev/null 2>&1; then
    echo "creating ECR repository: $repository"
    aws ecr create-repository \
      --region "$AWS_REGION" \
      --repository-name "$repository" \
      --image-tag-mutability IMMUTABLE \
      --image-scanning-configuration scanOnPush=true >/dev/null
  fi
done

aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$registry"

declare -a repokey
declare -a imageuris
declare -a imagedigests
for entry in "${jobs[@]}"; do
  repository="${entry%%|*}"
  args="${entry#*|}"
  tagged="${registry}/${repository}:${release_tag}"

  docker buildx create --use --name straitsx-builder >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  docker buildx build --provenance=false --platform "$target_platform" \
    --push -t "$tagged" $args .
  repokey+=("$repository")
  imageuris+=("${registry}/${repository}")
  imagedigests+=("$(
    aws ecr describe-images \
      --region "$AWS_REGION" \
      --repository-name "$repository" \
      --image-ids "imageTag=${release_tag}" \
      --query 'imageDetails[0].imageDigest' --output text
  )")
done

assert_scan_gate() {
  local repository="$1"
  local digest="$2"
  local counts critical high

  aws ecr wait image-scan-complete \
    --region "$AWS_REGION" \
    --repository-name "$repository" \
    --image-id "imageDigest=${digest}"
  counts="$(aws ecr describe-image-scan-findings \
    --region "$AWS_REGION" \
    --repository-name "$repository" \
    --image-id "imageDigest=${digest}" \
    --query 'imageScanFindings.findingSeverityCounts' \
    --output json)"
  critical="$(jq -r '.CRITICAL // 0' <<<"$counts")"
  high="$(jq -r '.HIGH // 0' <<<"$counts")"
  printf 'scan %s@%s: critical=%s high=%s\n' "$repository" "$digest" "$critical" "$high"
  if (( critical > 0 || high > 0 )); then
    echo "refusing to publish Terraform values: ECR scan gate failed" >&2
    exit 67
  fi
}

for i in "${!repokey[@]}"; do
  assert_scan_gate "${repokey[$i]}" "${imagedigests[$i]}"
done

for i in "${!repokey[@]}"; do
  printf '%s=%s@%s\n' \
    "$(sed "s|^${registry_prefix}/||" <<<"${repokey[$i]}" | tr '-' '_')_image" \
    "${imageuris[$i]}" "${imagedigests[$i]}"
done

echo "copy these lines into /tmp module-c and module-ab tfvars (mode 0600)" >&2