#!/bin/sh
# Unpacks a commit into ~/.local/share/soma/releases/<sha> and points `current` at it.
# Releasing a commit that is already unpacked only moves `current`, which is how to roll back.
#   scripts/release.sh [ref=HEAD]
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
sha=$(git -C "$repo" rev-parse --short "${1:-HEAD}^{commit}")
releases="$HOME/.local/share/soma/releases"
target="$releases/$sha"

if [ ! -d "$target" ]; then
	staging="$releases/.staging-$sha"
	rm -rf "$staging"
	mkdir -p "$staging"
	git -C "$repo" archive "$sha" | tar -x -C "$staging"
	(cd "$staging" && npm ci --omit=dev --ignore-scripts)
	# Renamed only once complete, so a half-built release is never one `current` can point at.
	mv "$staging" "$target"
fi

ln -sfn "$sha" "$releases/current"
echo "current -> $sha"
echo "restart prod to run it: launchctl kickstart -k gui/$(id -u)/dev.musingfox.soma"
