#!/usr/bin/env bash
# Builds a zip for AgentCore Runtime direct code deployment (NODE_22, linux/arm64).
# Bundles the TypeScript into plain JS with Deno and includes the arm64 Deno binary.
# Usage (from poc/): ./agentcore/build-zip.sh [out.zip]
set -euo pipefail
DENO_VERSION=${DENO_VERSION:-2.9.7}
OUT=$(realpath -m "${1:-dist/agentcore.zip}")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

deno bundle --platform deno -o "$WORK/pkg/server.mjs" agentcore/server.ts
deno bundle --platform deno -o "$WORK/pkg/sandbox.test.mjs" test/sandbox.test.ts
cp agentcore/bootstrap.js "$WORK/pkg/"
echo '{"type":"module"}' > "$WORK/pkg/package.json"
mkdir -p "$WORK/pkg/bin"
curl -fsSL -o "$WORK/deno.zip" "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-aarch64-unknown-linux-gnu.zip"
python3 -c "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$WORK/deno.zip" "$WORK/pkg/bin"
chmod +x "$WORK/pkg/bin/deno"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(cd "$WORK/pkg" && python3 -c "
import os, zipfile
with zipfile.ZipFile('$OUT', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk('.'):
        for f in files:
            z.write(os.path.join(root, f))
")
echo "$OUT"
