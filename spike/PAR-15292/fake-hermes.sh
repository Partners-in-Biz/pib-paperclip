#!/bin/bash
# PAR-15292 spike: stand-in for `hermes chat` so runs finish without a model call or the
# host gateway. Preparation (what we measure) happens before this is started. Not committed.
if [ "$1" = "--version" ] || [ "$1" = "version" ]; then echo "Hermes Agent v0.22.5 (spike stand-in)"; exit 0; fi
sid=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--resume" ] || [ "$prev" = "-r" ]; then sid="$a"; fi
  prev="$a"
done
[ -n "$sid" ] || sid="local-spike$(date +%s%N | sha256sum | cut -c1-24)"
echo "Session: $sid" >&2
echo "Four. That is my short answer."
echo "" >&2
echo "session_id: $sid" >&2
exit 0
