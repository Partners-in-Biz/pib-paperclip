#!/bin/bash
# usage: gw.sh <tool> <json-params>
api="${PAPERCLIP_API_URL%/}"; case "$api" in */api) ;; *) api="$api/api" ;; esac
TOKEN="pcgt_fe1d2d73-9c9b-4ea2-a48b-ba02b193490b.WDOqikDMmaT7Qlq3LqnvECm1fMIY2fLkWWNJojnyYg4"
curl -sS -X POST "$api/tool-gateway/tools/call" \
  -H "x-paperclip-tool-gateway-token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"tool\":\"$1\",\"parameters\":$2}"
