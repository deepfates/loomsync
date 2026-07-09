#!/usr/bin/env bash
# Guard against machine-local absolute paths leaking into tracked files
# (test vectors, fixtures, docs, configs). A path like
# /Users/someone/... or /home/someone/... makes a test pass on the machine
# that wrote it and fail everywhere else, including CI. See ticket dee-88da.
#
# Bare /tmp is allowed: mktemp and os.tmpdir() use it portably. We only catch
# user-home directories and machine-specific temp roots.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

pattern='/Users/|/home/[a-z]|/private/tmp|/var/folders/|file:///(Users|home)|[A-Za-z]:\\Users'

# Scan tracked files only. Exclude this guard itself, since it names the
# patterns it forbids.
if git grep -nIE "$pattern" -- . ':!scripts/no-machine-local-paths.sh'; then
  echo ""
  echo "ERROR: machine-local absolute path found above."
  echo "Make it machine-independent: build paths from the file's own location"
  echo "(e.g. fileURLToPath(import.meta.url) in TS, Path(__file__).parent in"
  echo "Python) or use a mktemp / os.tmpdir() temp directory."
  exit 1
fi

echo "guard: no machine-local paths in tracked files"
