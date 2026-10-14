#!/usr/bin/env bash
# Checks that a deployed site is healthy and runs the expected commit: /api/health must return
# status ok with sha equal to the given commit (CI/CD design 4.3). Retries while CloudFront and the
# new Lambda version settle. Usage: smoke_test.sh <site url> <commit sha>
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <site url> <commit sha>" >&2
  exit 1
fi
url="${1%/}/api/health"
expected="$2"
attempts="${SMOKE_ATTEMPTS:-10}"
delay="${SMOKE_DELAY_SECONDS:-15}"

for attempt in $(seq 1 "$attempts"); do
  body="$(curl --silent --show-error --fail --max-time 10 "$url" || true)"
  status="$(jq -r '.status // empty' <<<"$body" 2>/dev/null || true)"
  sha="$(jq -r '.sha // empty' <<<"$body" 2>/dev/null || true)"
  if [ "$status" = "ok" ] && [ "$sha" = "$expected" ]; then
    echo "$url is healthy and runs $sha"
    exit 0
  fi
  echo "Attempt $attempt/$attempts: status=${status:-none} sha=${sha:-none}, expected sha $expected"
  if [ "$attempt" -lt "$attempts" ]; then sleep "$delay"; fi
done

echo "::error::$url did not report status ok with sha $expected"
exit 1
