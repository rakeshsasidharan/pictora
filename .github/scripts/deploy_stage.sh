#!/usr/bin/env bash
# Deploys one stage with the given image digests (CI/CD design 4.3): extracts the Next.js static files from
# the app image, runs cdk deploy, and writes the site URL from the stack outputs to $GITHUB_OUTPUT.
# Run from the repository root of the commit being deployed, with AWS credentials for the deploy role.
# Usage: deploy_stage.sh <PictoraDev|PictoraProd> <commit sha> <app digest> [worker digest]
# Environment: REGISTRY (ECR registry host), HOSTED_ZONE_ID, ALERT_EMAIL (optional), AWS_REGION.
set -euo pipefail

stage="$1"
sha="$2"
app_digest="$3"
worker_digest="${4:-}"
: "${REGISTRY:?REGISTRY is required}"
: "${HOSTED_ZONE_ID:?HOSTED_ZONE_ID is required}"

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"

static_dir="${RUNNER_TEMP:-/tmp}/app-static-$stage"
infra/scripts/extract_app_static.sh "$REGISTRY/pictora-app@$app_digest" "$static_dir"

outputs="$PWD/cdk-outputs-$stage.json"
(
  cd infra
  npx cdk deploy "$stage/*" --require-approval never --concurrency 3 --outputs-file "$outputs" \
    -c "appImageDigest=$app_digest" \
    -c "workerImageDigest=$worker_digest" \
    -c "gitSha=$sha" \
    -c "hostedZoneId=$HOSTED_ZONE_ID" \
    -c "alertEmail=${ALERT_EMAIL:-}" \
    -c "appStaticDir=$static_dir/static" \
    -c "appPublicDir=$static_dir/public"
)

site_url="$(jq -r '[.[] | .SiteUrl? // empty] | first // empty' "$outputs")"
if [ -z "$site_url" ]; then
  echo "::error::No SiteUrl output in $outputs"
  exit 1
fi
echo "Deployed $stage at $site_url"
echo "site_url=$site_url" >>"$GITHUB_OUTPUT"
