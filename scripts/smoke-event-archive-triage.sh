#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
TENANT_ID="${TENANT_ID:-a7a82e4a-b5b5-48c2-8daf-a1e6cc953f7b}"
USER_ID="${USER_ID:-bbaab2c2-4fc7-41e1-808a-10b99db7d6df}"
LOGIN_EMAIL="${LOGIN_EMAIL:-operator@demo.local}"
LOGIN_PASSWORD="${LOGIN_PASSWORD:-Password123!}"
ASSIGNED_USER_ID="${ASSIGNED_USER_ID:-$USER_ID}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing command: $1"
    exit 1
  fi
}

json_field() {
  local field="$1"
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const parts='${field}'.split('.');let cur=j;for(const p of parts){cur=cur?.[p]}process.stdout.write(cur==null?'':String(cur))}catch{process.stdout.write('')}})"
}

json_count() {
  local field="$1"
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const v=j?.['${field}'];process.stdout.write(String(v ?? 0))})"
}

find_event_id() {
  local severity="$1"
  local triage="$2"
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const item=(j.items||[]).find(i=>i.severity==='${severity}'&&i.triageStatus==='${triage}')||(j.items||[])[0];process.stdout.write(item?.id||'')})"
}

require_command curl
require_command node

LOGIN_JSON=$(curl -sS -X POST "$API_BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -d "{\"email\":\"$LOGIN_EMAIL\",\"password\":\"$LOGIN_PASSWORD\"}")
ACCESS_TOKEN=$(printf "%s" "$LOGIN_JSON" | json_field accessToken)
if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "LOGIN_FAIL $LOGIN_JSON"
  exit 1
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
CREATE_JSON=$(curl -sS -X POST "$API_BASE_URL/reservations" \
  -H "Content-Type: application/json" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -d "{\"customerName\":\"Smoke Triage\",\"pickupLocation\":\"IST\",\"dropoffLocation\":\"Levent\",\"pickupTime\":\"$NOW\"}")
RESERVATION_ID=$(printf "%s" "$CREATE_JSON" | json_field id)
if [[ -z "$RESERVATION_ID" ]]; then
  echo "CREATE_FAIL $CREATE_JSON"
  exit 1
fi

curl -sS -X PATCH "$API_BASE_URL/reservations/$RESERVATION_ID/status" \
  -H "Content-Type: application/json" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -d '{"status":"CONFIRMED","reason":"smoke confirmed"}' >/dev/null

curl -sS -X PATCH "$API_BASE_URL/reservations/$RESERVATION_ID/status" \
  -H "Content-Type: application/json" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -d '{"status":"DELAYED","reason":"smoke delayed"}' >/dev/null

ARCHIVE_JSON=$(curl -sS "$API_BASE_URL/operations/event-archive?limit=30&offset=0&reservationId=$RESERVATION_ID" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID")
ARCHIVE_TOTAL=$(printf "%s" "$ARCHIVE_JSON" | json_field total)
TARGET_EVENT_ID=$(printf "%s" "$ARCHIVE_JSON" | find_event_id HIGH OPEN)
if [[ -z "$TARGET_EVENT_ID" ]]; then
  echo "ARCHIVE_FAIL $ARCHIVE_JSON"
  exit 1
fi

ACK_JSON=$(curl -sS -X POST "$API_BASE_URL/operations/event-archive/triage" \
  -H "Content-Type: application/json" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -d "{\"eventIds\":[\"$TARGET_EVENT_ID\"],\"action\":\"acknowledge\"}")
ACK_UPDATED=$(printf "%s" "$ACK_JSON" | json_field updated)

SNOOZE_UNTIL=$(date -u -d '+30 minutes' +"%Y-%m-%dT%H:%M:%S.000Z")
SNOOZE_JSON=$(curl -sS -X POST "$API_BASE_URL/operations/event-archive/triage" \
  -H "Content-Type: application/json" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -d "{\"eventIds\":[\"$TARGET_EVENT_ID\"],\"action\":\"snooze\",\"snoozedUntil\":\"$SNOOZE_UNTIL\"}")
SNOOZE_UPDATED=$(printf "%s" "$SNOOZE_JSON" | json_field updated)

ASSIGN_JSON=$(curl -sS -X POST "$API_BASE_URL/operations/event-archive/triage" \
  -H "Content-Type: application/json" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -d "{\"eventIds\":[\"$TARGET_EVENT_ID\"],\"action\":\"assign\",\"assignedUserId\":\"$ASSIGNED_USER_ID\"}")
ASSIGN_UPDATED=$(printf "%s" "$ASSIGN_JSON" | json_field updated)

RESOLVE_JSON=$(curl -sS -X POST "$API_BASE_URL/operations/event-archive/triage" \
  -H "Content-Type: application/json" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID" \
  -d "{\"eventIds\":[\"$TARGET_EVENT_ID\"],\"action\":\"resolve\"}")
RESOLVE_UPDATED=$(printf "%s" "$RESOLVE_JSON" | json_field updated)

RESOLVED_JSON=$(curl -sS "$API_BASE_URL/operations/event-archive?limit=30&offset=0&reservationId=$RESERVATION_ID&triageStatus=RESOLVED" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-user-id: $USER_ID")
RESOLVED_COUNT=$(printf "%s" "$RESOLVED_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(String((j.items||[]).filter(i=>i.id==='${TARGET_EVENT_ID}').length))})")

if [[ "$ACK_UPDATED" != "1" || "$SNOOZE_UPDATED" != "1" || "$ASSIGN_UPDATED" != "1" || "$RESOLVE_UPDATED" != "1" || "$RESOLVED_COUNT" != "1" ]]; then
  echo "SMOKE_FAIL reservation=$RESERVATION_ID targetEvent=$TARGET_EVENT_ID archiveTotal=$ARCHIVE_TOTAL ack=$ACK_UPDATED snooze=$SNOOZE_UPDATED assign=$ASSIGN_UPDATED resolve=$RESOLVE_UPDATED resolvedCount=$RESOLVED_COUNT"
  exit 1
fi

echo "SMOKE_OK reservation=$RESERVATION_ID targetEvent=$TARGET_EVENT_ID archiveTotal=$ARCHIVE_TOTAL ack=$ACK_UPDATED snooze=$SNOOZE_UPDATED assign=$ASSIGN_UPDATED resolve=$RESOLVE_UPDATED resolvedCount=$RESOLVED_COUNT"
