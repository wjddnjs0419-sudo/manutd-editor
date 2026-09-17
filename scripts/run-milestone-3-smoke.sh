#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASE_FUNCTIONS_URL:?required}"
: "${COLLECTOR_INVOKE_SECRET:?required}"
: "${SUPABASE_DB_URL:?required}"

scope=""
output=""
while (($# > 0)); do
  case "$1" in
    --scope)
      scope="${2:-}"
      shift 2
      ;;
    --output)
      output="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument" >&2
      exit 2
      ;;
  esac
done

if [[ "$scope" != "three" && "$scope" != "all" ]]; then
  echo "--scope must be three or all" >&2
  exit 2
fi
if [[ -z "$output" ]]; then
  echo "--output is required" >&2
  exit 2
fi

body_file=$(mktemp)
http_body=$(mktemp)
trap 'rm -f "$body_file" "$http_body"' EXIT

if [[ "$scope" == "three" ]]; then
  account_ids=$(psql "$SUPABASE_DB_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
select coalesce(json_agg(id order by username)::text, '[]')
from public.source_accounts
where is_active
  and username in ('utdreport', 'utddistrict', 'manunitedzone');
SQL
  )
  if [[ $(jq 'length' <<<"$account_ids") -ne 3 ]]; then
    echo "expected three active smoke accounts" >&2
    exit 1
  fi
  jq -n --argjson ids "$account_ids" '{source_account_ids: $ids}' >"$body_file"
else
  printf '' >"$body_file"
fi

status=$(curl --silent --show-error \
  --output "$http_body" \
  --write-out '%{http_code}' \
  --request POST \
  --header "Authorization: Bearer ${COLLECTOR_INVOKE_SECRET}" \
  --header 'Content-Type: application/json' \
  --data-binary "@$body_file" \
  "${SUPABASE_FUNCTIONS_URL%/}/collect-instagram")

if [[ "$status" != "200" ]]; then
  echo "collector returned HTTP $status" >&2
  exit 1
fi

expected=$(psql "$SUPABASE_DB_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c "select count(*) from public.source_accounts where is_active")
if [[ "$scope" == "three" ]]; then
  expected=3
fi

jq -e --argjson expected "$expected" '
  .accounts_requested == $expected and
  (.accounts_success + .accounts_failed == $expected) and
  (.accounts | length == $expected) and
  all(.accounts[]; has("source_account_id") and has("username") and has("status"))
' "$http_body" >/dev/null

install -m 600 "$http_body" "$output"
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 \
  -f "$(dirname "$0")/verify-milestone-3-smoke.sql"

jq '{accounts_requested, accounts_success, accounts_failed}' "$output"
