#!/usr/bin/env bash
# Deletes a stage's unused, retained ACM certificates after a deploy (CI/CD design 4.3, tech design 14).
# The Certificate stack retains a replaced certificate, because CloudFront still uses it until the Web stack
# switches to the new one. Once the deploy has finished, this removes the old ones.
#
# Deletes only certificates in us-east-1 that carry Project=pictora and Stage=<stage>, have an empty InUseBy,
# and are not the stage's current certificate. Untagged and other projects' certificates are never touched.
# Every failure is a warning: the cleanup never fails a deploy.
#
# Usage: prune_certificates.sh <dev|prod> <current certificate ARN>
# Needs the aws CLI and jq, with credentials that can list, describe, tag-read and delete ACM certificates.
set -uo pipefail

region="us-east-1"
stage="${1:-}"
current_arn="${2:-}"

warn() {
  echo "::warning::Certificate cleanup: $*"
}

case "$stage" in
  dev | prod) ;;
  *)
    warn "unknown stage '$stage'; nothing deleted"
    exit 0
    ;;
esac
if [ -z "$current_arn" ]; then
  warn "no current certificate ARN for $stage; nothing deleted"
  exit 0
fi

if ! listing="$(aws acm list-certificates --region "$region" --output json)"; then
  warn "could not list certificates in $region; nothing deleted"
  exit 0
fi
if ! arns="$(jq -r '.CertificateSummaryList[]?.CertificateArn' <<<"$listing")"; then
  warn "could not read the certificate list; nothing deleted"
  exit 0
fi

deleted=0
while IFS= read -r arn; do
  [ -n "$arn" ] || continue
  [ "$arn" != "$current_arn" ] || continue

  if ! tags="$(aws acm list-tags-for-certificate --region "$region" --certificate-arn "$arn" --output json)"; then
    warn "could not read the tags of $arn; kept"
    continue
  fi
  matches="$(jq -r --arg stage "$stage" '
    [.Tags[]?] as $tags
    | ($tags | any(.Key == "Project" and .Value == "pictora"))
      and ($tags | any(.Key == "Stage" and .Value == $stage))
  ' <<<"$tags" 2>/dev/null)"
  [ "$matches" = "true" ] || continue

  if ! description="$(aws acm describe-certificate --region "$region" --certificate-arn "$arn" --output json)"; then
    warn "could not describe $arn; kept"
    continue
  fi
  in_use="$(jq -r '.Certificate.InUseBy // [] | length' <<<"$description" 2>/dev/null)"
  if [ "$in_use" != "0" ]; then
    echo "Keeping $arn: in use by ${in_use:-unknown} resource(s)"
    continue
  fi

  if aws acm delete-certificate --region "$region" --certificate-arn "$arn"; then
    echo "Deleted unused $stage certificate $arn"
    deleted=$((deleted + 1))
  else
    warn "could not delete $arn; kept"
  fi
done <<<"$arns"

echo "Certificate cleanup for $stage done: $deleted deleted"
exit 0
