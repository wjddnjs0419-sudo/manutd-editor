#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASE_FUNCTIONS_URL:?required}"
: "${COLLECTOR_INVOKE_SECRET:?required}"

if [[ -z "${SUPABASE_DB_URL:-}" ]] &&
  { [[ -z "${SUPABASE_URL:-}" ]] || [[ -z "${SUPABASE_SECRET_KEY:-}" ]]; }; then
  echo "SUPABASE_DB_URL or SUPABASE_URL with SUPABASE_SECRET_KEY is required" >&2
  exit 1
fi

psql_run() {
  if command -v psql >/dev/null 2>&1; then
    psql "$@"
  else
    docker run --rm -i postgres:17-alpine psql "$@"
  fi
}

rest_get() {
  curl --silent --show-error --fail \
    --globoff \
    --header "apikey: ${SUPABASE_SECRET_KEY}" \
    "${SUPABASE_URL%/}/rest/v1/$1"
}

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

if [[ "$scope" == "three" && -n "${SUPABASE_DB_URL:-}" ]]; then
  account_ids=$(psql_run "$SUPABASE_DB_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
select coalesce(json_agg(id order by username)::text, '[]')
from public.source_accounts
where active
  and username in ('utdreport', 'utddistrict', 'manunitedzone');
SQL
  )
elif [[ "$scope" == "three" ]]; then
  account_ids=$(rest_get \
    'source_accounts?select=id,username&active=eq.true&username=in.(utdreport,utddistrict,manunitedzone)&order=username' |
    jq '[.[].id]')
fi

if [[ "$scope" == "three" ]]; then
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

if [[ "$scope" == "three" ]]; then
  expected=3
elif [[ -n "${SUPABASE_DB_URL:-}" ]]; then
  expected=$(psql_run "$SUPABASE_DB_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -c "select count(*) from public.source_accounts where active")
else
  expected=$(rest_get 'source_accounts?select=id&active=eq.true' | jq 'length')
fi

jq -e --argjson expected "$expected" '
  .accounts_requested == $expected and
  (.accounts_success + .accounts_failed == $expected) and
  (.accounts | length == $expected) and
  all(.accounts[]; has("source_account_id") and has("username") and has("status"))
' "$http_body" >/dev/null

install -m 600 "$http_body" "$output"
if [[ -n "${SUPABASE_DB_URL:-}" ]]; then
  psql_run "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 \
    -f "$(dirname "$0")/verify-milestone-3-smoke.sql"
else
  raw_posts=$(rest_get \
    'raw_posts?select=source_account_id,external_post_id')
  snapshots=$(rest_get \
    'post_metric_snapshots?select=raw_post_id,capture_bucket_start')
  storage_paths=$(rest_get \
    'media_assets?select=storage_path&storage_path=not.is.null')
  jq -n \
    --argjson rawPosts "$raw_posts" \
    --argjson snapshots "$snapshots" \
    --argjson storagePaths "$storage_paths" \
    '{
      duplicate_raw_posts: ($rawPosts | group_by([.source_account_id, .external_post_id]) | map(select(length > 1)) | length),
      duplicate_snapshot_buckets: ($snapshots | group_by([.raw_post_id, .capture_bucket_start]) | map(select(length > 1)) | length),
      duplicate_storage_paths: ($storagePaths | group_by(.storage_path) | map(select(length > 1)) | length)
    }'
fi

jq '{accounts_requested, accounts_success, accounts_failed}' "$output"
