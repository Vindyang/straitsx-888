#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [release-tag]" >&2
  exit 64
fi

: "${AWS_REGION:?AWS_REGION must name the deployment Region}"

release_tag="${1:-$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%SZ)}"
target_platform="${TARGET_PLATFORM:-linux/amd64}"
dashboard_repository="${DASHBOARD_ECR_REPOSITORY:-straitsx/module-c-dashboard}"
orchestrator_repository="${ORCHESTRATOR_ECR_REPOSITORY:-straitsx/module-c-orchestrator}"

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
dashboard_repository_uri="${registry}/${dashboard_repository}"
orchestrator_repository_uri="${registry}/${orchestrator_repository}"

for repository in "$dashboard_repository" "$orchestrator_repository"; do
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

dashboard_tagged="${dashboard_repository_uri}:${release_tag}"
orchestrator_tagged="${orchestrator_repository_uri}:${release_tag}"

# Disable the default BuildKit provenance index so the pushed digest is the
# scannable platform manifest consumed by Fargate. Provenance should be
# published separately by CI when an attestation store is configured.
docker build --provenance=false --platform "$target_platform" -f services/dashboard/Dockerfile -t "$dashboard_tagged" .
docker build --provenance=false --platform "$target_platform" -f services/agent-orchestrator/Dockerfile -t "$orchestrator_tagged" .
docker push "$dashboard_tagged"
docker push "$orchestrator_tagged"

dashboard_digest="$(aws ecr describe-images --region "$AWS_REGION" --repository-name "$dashboard_repository" --image-ids "imageTag=${release_tag}" --query 'imageDetails[0].imageDigest' --output text)"
orchestrator_digest="$(aws ecr describe-images --region "$AWS_REGION" --repository-name "$orchestrator_repository" --image-ids "imageTag=${release_tag}" --query 'imageDetails[0].imageDigest' --output text)"

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

assert_scan_gate "$dashboard_repository" "$dashboard_digest"
assert_scan_gate "$orchestrator_repository" "$orchestrator_digest"

printf 'dashboard_image=%s@%s\n' "$dashboard_repository_uri" "$dashboard_digest"
printf 'orchestrator_image=%s@%s\n' "$orchestrator_repository_uri" "$orchestrator_digest"
printf 'fixture_image=%s@%s\n' "$orchestrator_repository_uri" "$orchestrator_digest"
