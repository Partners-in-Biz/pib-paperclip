#!/usr/bin/env bash
# Gateway call helper: usage  gateway_call "toolName" 'json-params'
export PIBGW="${PIBGW:-pcgt_e368d28b-9ab1-45cc-a64f-1b32b586e8e4.3vnw_D71kd0L8WFbMyeswplulmbV7JcvY6YsNKJEeGA}"
api="${PAPERCLIP_API_URL%/}"
tool="$1"; params="$2"
body=$(jq -n --arg t "$tool" --argjson p "$params" '{tool:$t, parameters:$p}')
curl -sS "$api/api/tool-gateway/tools/call" \
  -H "x-paperclip-tool-gateway-token: $PIBGW" \
  -H "Content-Type: application/json" \
  --data-binary "$body"
echo
