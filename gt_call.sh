#!/usr/bin/env bash
# Usage: gt_call.sh <toolName> '<json params>'
export GT="pcgt_a7a9fe4e-ab3c-4123-a268-2b67016a45a6.9SRiwrdafEmMmRQqkyCnQHjb2L5MfO6VLsp5sj4pcvM"
api="${PAPERCLIP_API_URL%/}"; case "$api" in */api) ;; *) api="$api/api" ;; esac
TOOL="$1"; shift
PARAMS="$1"
jq -n --arg t "$TOOL" --argjson p "$PARAMS" '{tool:$t, parameters:$p}' > /tmp/gt_body.json 2>/dev/null || \
jq -n --arg t "$TOOL" --arg p "$PARAMS" '{tool:$t, parameters:$p}' > /tmp/gt_body.json
curl -sS -X POST "$api/tool-gateway/tools/call" \
  -H "x-paperclip-tool-gateway-token: $GT" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/gt_body.json
echo
