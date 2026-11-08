#!/usr/bin/env bash
# PiB SEO gateway helper.
# Usage: source this file. Then:
#   pib <tool> '<json params>'            -> prints gateway JSON envelope to stdout
#   pibc <tool> '<json params>' <key>     -> prints result.result.content parsed as JSON, then ."<key>"
# Token is stored in ${PAPERCLIP_SCRATCH_DIR}/gw_token.txt and auto-refreshed when a call fails.
API="${PAPERCLIP_API_URL%/}"; case "$API" in */api) ;; *) API="$API/api";; esac
export GW_API="$API"
TOKFILE="${PAPERCLIP_SCRATCH_DIR:-/tmp}/gw_token.txt"

pib_token() {
  GW_TOKEN=$(curl -sS -X POST "$GW_API/tool-gateway/sessions" \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
    -d "{\"companyId\":\"$PAPERCLIP_COMPANY_ID\",\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"runId\":\"$PAPERCLIP_RUN_ID\",\"issueId\":\"$PAPERCLIP_TASK_ID\"}" | jq -r '.token // empty')
  [ -n "$GW_TOKEN" ] && printf '%s' "$GW_TOKEN" > "$TOKFILE"
}

[ -f "$TOKFILE" ] && GW_TOKEN=$(cat "$TOKFILE")
[ -z "$GW_TOKEN" ] && pib_token

pib() { # pib <tool> <params-json>
  local tool="$1" params="${2:-{}}"
  [ -z "$GW_TOKEN" ] && pib_token
  for attempt in 1 2 3; do
    local body
    body=$(jq -nc --arg t "$tool" --argjson p "$params" '{tool:$t, parameters:$p}')
    local resp
    resp=$(curl -sS -X POST "$GW_API/tool-gateway/tools/call" \
      -H "x-paperclip-tool-gateway-token: $GW_TOKEN" -H "Content-Type: application/json" \
      -d "$body")
    if echo "$resp" | grep -q '"error"'; then
      pib_token
      continue
    fi
    printf '%s' "$resp"
    return 0
  done
  printf '%s' "$resp"
}

pibc() { # pibc <tool> <params-json> <jq-filter-on-content>
  local key="$3"
  pib "$1" "$2" | python3 -c "
import sys, json
env=json.load(sys.stdin)
inner=env.get('result',{}).get('result',{}).get('content','')
try:
    data=json.loads(inner) if isinstance(inner,str) else inner
except Exception as e:
    data={'parse_error': str(e), 'raw_tail': inner[-200:]}
f='''$key'''
if f and isinstance(data, dict) and f in data:
    print(json.dumps(data[f], indent=2)[:20000])
else:
    print(json.dumps(data, indent=2)[:30000])
"
}
