#!/usr/bin/env bash
# Looks up the digests of the app and worker images pushed for a commit (tag = full commit SHA) and writes
# app_digest and worker_digest to $GITHUB_OUTPUT. The app image must exist. The worker image must exist only
# when that commit has worker/Dockerfile. Run from a clone whose history contains the commit.
# Usage: resolve_images.sh <commit sha>
set -euo pipefail

sha="$1"
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::sha must be a full 40-character commit SHA: $sha"
  exit 1
fi

digest_for() {
  aws ecr describe-images --repository-name "$1" --image-ids "imageTag=$sha" \
    --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true
}

app_digest="$(digest_for pictora-app)"
if ! [[ "$app_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::No pictora-app image tagged $sha in ECR. Build that commit first: only commits merged to main after the deploy pipeline existed have images."
  exit 1
fi

if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
  echo "::error::Commit $sha is not in this repository's history."
  exit 1
fi

worker_digest=''
if git cat-file -e "$sha:worker/Dockerfile" 2>/dev/null; then
  worker_digest="$(digest_for pictora-worker)"
  if ! [[ "$worker_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "::error::No pictora-worker image tagged $sha in ECR. Build that commit first."
    exit 1
  fi
fi

echo "app: $app_digest"
echo "worker: ${worker_digest:-none (no worker/Dockerfile at this commit)}"
{
  echo "app_digest=$app_digest"
  echo "worker_digest=$worker_digest"
} >>"$GITHUB_OUTPUT"
