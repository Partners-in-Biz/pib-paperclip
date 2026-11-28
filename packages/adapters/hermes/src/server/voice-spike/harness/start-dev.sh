#!/bin/bash
# Start the PAR-15293 spike dev server with a clean env (no production PAPERCLIP_* vars).
cd "$1"
exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" LANG=C.UTF-8 NODE_OPTIONS=--max-old-space-size=2048 \
  PAPERCLIP_IN_WORKTREE=false PAPERCLIP_SPIKE_VOICE_WARM=1 PAPERCLIP_SPIKE_VOICE_STATE_DIR="$TMPDIR/spike15293/hosts" \
  pnpm dev:server
