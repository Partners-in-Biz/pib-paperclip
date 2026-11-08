#!/usr/bin/env bash
# Gateway helper for partnersinbiz tools. Source this, then call gw <tool> '<json-params>'.
API="${PAPERCLIP_API_URL%/}"
case "$API" in */api) ;; *) API="$API/api";; esac
export GW_API="$API"

if [ -f /tmp/gw_token.txt ]; then
  GW_TOKEN=$(cat /tmp/gw_token.txt)
fi

gw_token() {
  GW_TOKEN=$(curl -sS -X POST "$GW_API/tool-gateway/sessions" \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
    -d "{\"companyId\":\"$PAPERCLIP_COMPANY_ID\",\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"runId\":\"$PAPERCLIP_RUN_ID\",\"issueId\":\"$PAPERCLIP_TASK_ID\"}" | jq -r '.token')
  echo "$GW_TOKEN" > /tmp/gw_token.txt
}

gw() {
  local tool="$1"; local params="${2:-{}}"
  [ -z "$GW_TOKEN" ] && gw_token
  local body
  body=$(jq -nc --arg tool "$tool" --argjson p "$params" '{tool:$tool,parameters:$p}')
  curl -sS -X POST "$GW_API/tool-gateway/tools/call" \
    -H "x-paperclip-tool-gateway-token: $GW_TOKEN" \
    -H "Content-Type: application/json" -d "$body"
}
