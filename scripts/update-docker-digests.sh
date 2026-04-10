#!/usr/bin/env bash
# update-docker-digests.sh
#
# Fetches the latest SHA256 digests for pinned Docker base images and updates
# all Dockerfiles. Run this weekly (or before any release) to stay current.
#
# Usage:
#   ./scripts/update-docker-digests.sh
#
# Requirements: curl, jq
#
# To automate: add a scheduled CI job that runs this script, commits the diff,
# and opens a pull request for review (e.g. GitHub Actions on a weekly cron).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Fetching latest Docker image digests..."

# Fetch multi-platform manifest digest from Docker Hub
get_digest() {
  local image="$1"
  local tag="$2"
  curl -fsSL "https://hub.docker.com/v2/repositories/library/${image}/tags/${tag}" \
    | jq -r '.digest'
}

NODE_DIGEST=$(get_digest "node" "22-bookworm")
DEBIAN_DIGEST=$(get_digest "debian" "bookworm-slim")

echo "node:22-bookworm        -> ${NODE_DIGEST}"
echo "debian:bookworm-slim    -> ${DEBIAN_DIGEST}"

# Update Dockerfile (node base image)
sed -i "s|FROM node:22-bookworm@sha256:[a-f0-9]*|FROM node:22-bookworm@${NODE_DIGEST}|g" \
  "${REPO_ROOT}/Dockerfile"

# Update debian-based Dockerfiles
for f in "${REPO_ROOT}/Dockerfile.sandbox" "${REPO_ROOT}/Dockerfile.sandbox-browser"; do
  sed -i "s|FROM debian:bookworm-slim@sha256:[a-f0-9]*|FROM debian:bookworm-slim@${DEBIAN_DIGEST}|g" "$f"
done

echo ""
echo "Done. Review the diff and update BUN_VERSION + checksums manually if upgrading Bun."
echo "Bun releases and checksums: https://github.com/oven-sh/bun/releases"
echo ""
echo "After updating, commit with a message like:"
echo "  chore: pin docker image digests ($(date +%Y-%m-%d))"
