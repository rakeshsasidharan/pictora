#!/usr/bin/env bash
# Copies the Next.js static files out of a built app image, so the assets bucket gets exactly the files the
# image's server references. Usage: extract_app_static.sh <image> <out-dir>
# Then deploy with -c appStaticDir=<out-dir>/static -c appPublicDir=<out-dir>/public.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <image> <out-dir>" >&2
  exit 1
fi
image="$1"
out="$2"

container="$(docker create --platform linux/arm64 "$image")"
trap 'docker rm "$container" >/dev/null' EXIT

rm -rf "$out"
mkdir -p "$out/static" "$out/public"
docker cp "$container:/var/task/app/.next/static/." "$out/static"
docker cp "$container:/var/task/app/public/." "$out/public"
echo "Static files from $image are in $out"
