#!/bin/sh
# record-copy-manifest.sh — record the copy-time manifest for a repo copy (BRA-159).
#
# Usage: record-copy-manifest.sh <repo-dir>
#
# Writes <repo-dir>/.agentts-copy-manifest.json:
#   {"copiedAt": "<ISO UTC>", "root": "<abs path copied from>",
#    "files": {"<repo-rel path>": "<sha256 hex>", ...}}
#
# The manifest is the base for the merge workflow's three-way merge
# (workflows/library/merge.ts): without it the workflow cannot tell a
# live-tree change since the copy was made from a copy change, and
# copying blind would clobber live work. Record it immediately after
# `cp -a` makes the copy, before any worker edits the copy.
#
# Coverage is every file in the repo except node_modules/,
# .agentts-state/, .agentts-scratch/, .git/, and the manifest itself —
# the same exclusion set the merge workflow's diff uses, so the two
# agree. Hashes come from sha256sum; the JSON is assembled by python3.
set -eu

if [ $# -ne 1 ]; then
  echo "usage: record-copy-manifest.sh <repo-dir>" >&2
  exit 2
fi

ROOT=$(cd "$1" && pwd)
cd "$ROOT"
MANIFEST="$ROOT/.agentts-copy-manifest.json"
TMP_MANIFEST="$MANIFEST.tmp"

find . \( -name node_modules -o -name .agentts-state -o -name .agentts-scratch -o -name .git \) -prune -o -type f -not -name '.agentts-copy-manifest.json' -print0 \
  | sort -z | xargs -0 -r sha256sum \
  | ROOT="$ROOT" MANIFEST_TMP="$TMP_MANIFEST" python3 -c '
import json, os, sys
from datetime import datetime, timezone
files = {}
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    parts = line.split(None, 1)
    if len(parts) != 2:
        raise SystemExit("record-copy-manifest: cannot parse sha256sum line: " + repr(line))
    h, p = parts
    if p.startswith("./"):
        p = p[2:]
    files[p] = h
manifest = {
    "copiedAt": datetime.now(timezone.utc).isoformat(),
    "root": os.environ["ROOT"],
    "files": files,
}
with open(os.environ["MANIFEST_TMP"], "w") as f:
    json.dump(manifest, f, indent=1, sort_keys=True)
    f.write("\n")
'

mv "$TMP_MANIFEST" "$MANIFEST"
echo "manifest: $MANIFEST ($(python3 -c "import json; print(len(json.load(open('$MANIFEST'))['files']))") files)"
