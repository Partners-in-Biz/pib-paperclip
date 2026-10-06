#!/usr/bin/env bash
# One-time setup for an agent (or a person) who builds and tests the PiB plugins in a fresh checkout on the VPS.
# Run from anywhere inside the checkout:  bash packages/plugins/agent-setup.sh
# It does four things the plain install does not: Node 24 first on PATH, a frozen install with scripts off, the built
# plugin SDK (the kit's typecheck and tests need its declarations, like CI's "Build the plugin SDK" step), and the
# embedded-Postgres library links (the *.pg.spec.ts tests fail with "Postgres init script exited with code 127" without them).
# After it, run per package:  cd packages/plugins/<pkg> && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

export PATH="/opt/node24/bin:/usr/bin:/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1

node -e 'if (+process.versions.node.split(".")[0] < 24) { console.error("Node 24 is required, found " + process.version + " (expected /opt/node24/bin)"); process.exit(1) }'

corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm --filter @paperclipai/plugin-sdk run build

found=0
for dir in node_modules/.pnpm/@embedded-postgres+linux-x64*/node_modules/@embedded-postgres/linux-x64; do
  [ -f "$dir/scripts/hydrate-symlinks.js" ] || continue
  (cd "$dir" && node scripts/hydrate-symlinks.js)
  found=1
done
[ "$found" = 1 ] || echo "note: no embedded-postgres linux-x64 package found (not on linux, or the lockfile changed); *.pg.spec.ts tests may fail"

echo "ready: Node $(node -v), pnpm $(corepack pnpm -v)"
echo "per package: cd packages/plugins/<pkg> && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build"
