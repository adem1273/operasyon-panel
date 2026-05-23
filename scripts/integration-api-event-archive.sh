#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
TENANT_ID="${TENANT_ID:-a7a82e4a-b5b5-48c2-8daf-a1e6cc953f7b}"
USER_ID="${USER_ID:-bbaab2c2-4fc7-41e1-808a-10b99db7d6df}"
LOGIN_EMAIL="${LOGIN_EMAIL:-operator@demo.local}"
LOGIN_PASSWORD="${LOGIN_PASSWORD:-Password123!}"

json_field() {
  local field="$1"
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const p='${field}'.split('.');let cur=j;for(const k of p){cur=cur?.[k]}process.stdout.write(cur==null?'':String(cur))})"
}

LOGIN_JSON=$(curl -sS -X POST "$API_BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -d "{\"email\":\"$LOGIN_EMAIL\",\"password\":\"$LOGIN_PASSWORD\"}")
ACCESS_TOKEN=$(printf "%s" "$LOGIN_JSON" | json_field accessToken)
[[ -n "$ACCESS_TOKEN" ]] || { echo "INTEGRATION_FAIL login"; exit 1; }

PAGE1_JSON=$(curl -sS "$API_BASE_URL/operations/event-archive?limit=2&offset=0" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID")

CURSOR_ID=$(printf "%s" "$PAGE1_JSON" | json_field nextCursorId)
PAGE1_COUNT=$(printf "%s" "$PAGE1_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(String((j.items||[]).length))})")

if [[ -z "$CURSOR_ID" || "$PAGE1_COUNT" -eq 0 ]]; then
  echo "INTEGRATION_FAIL pagination-first-page"
  exit 1
fi

PAGE2_JSON=$(curl -sS "$API_BASE_URL/operations/event-archive?limit=2&offset=0&cursorId=$CURSOR_ID" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID")
PAGE2_COUNT=$(printf "%s" "$PAGE2_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(String((j.items||[]).length))})")

METRICS_JSON=$(curl -sS "$API_BASE_URL/operations/metrics" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID")
ARCHIVE_QUERY_COUNT=$(printf "%s" "$METRICS_JSON" | json_field eventArchiveQueryCount)
TRIAGE_ACTION_COUNT=$(printf "%s" "$METRICS_JSON" | json_field triageActionCount)

if [[ "$PAGE2_COUNT" -lt 0 || -z "$ARCHIVE_QUERY_COUNT" || -z "$TRIAGE_ACTION_COUNT" ]]; then
  echo "INTEGRATION_FAIL metrics-or-pagination"
  exit 1
fi

echo "INTEGRATION_OK page1=$PAGE1_COUNT page2=$PAGE2_COUNT archiveQueries=$ARCHIVE_QUERY_COUNT triageActions=$TRIAGE_ACTION_COUNT"
