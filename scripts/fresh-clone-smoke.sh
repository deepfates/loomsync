#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(git rev-parse --show-toplevel)}"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/lync-fresh-clone.XXXXXX")"
clone_dir="$tmp_root/lync"

cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

git clone --quiet "$repo_root" "$clone_dir"
cd "$clone_dir"

pnpm install --frozen-lockfile
pnpm build
node bin/lync.js --help > help.txt

node bin/lync.js init demo.lync
first_id="$(
  printf '%s\n' '{"kind":"note/text","author":{"actor":"smoke"},"payload":{"text":"first line"}}' \
    | node bin/lync.js append demo.lync
)"
node bin/lync.js view demo.lync --as transcript > transcript.json

cp demo.lync a.lync
second_id="$(
  printf '%s\n' '{"kind":"note/text","author":{"actor":"smoke"},"payload":{"text":"second line"}}' \
    | node bin/lync.js append demo.lync
)"
cp demo.lync b.lync
cat a.lync b.lync > concatenated.lync
node bin/lync.js merge a.lync b.lync -o merged.lync
node bin/lync.js verify merged.lync > verify.txt

test "$(grep -F -c "\"id\":\"$first_id\"" merged.lync)" = "1"
test "$(grep -F -c "\"id\":\"$second_id\"" merged.lync)" = "1"
test "$(wc -l < concatenated.lync | tr -d ' ')" = "3"
test "$(wc -l < merged.lync | tr -d ' ')" = "2"

echo "fresh-clone smoke passed: $clone_dir"
