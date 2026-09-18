#!/usr/bin/env bash
set -euo pipefail

output="/tmp/milestone-4-5-smoke.json"
while (($# > 0)); do
  case "$1" in
    --output)
      output="${2:?--output requires a path}"
      shift 2
      ;;
    *)
      echo "usage: $0 [--output PATH]" >&2
      exit 2
      ;;
  esac
done

functions_url="${FUNCTIONS_URL:-${SUPABASE_URL:-http://127.0.0.1:55321}/functions/v1}"
invoke_secret="${COLLECTOR_INVOKE_SECRET:?COLLECTOR_INVOKE_SECRET is required}"
notion_token="${NOTION_TOKEN:?NOTION_TOKEN is required}"
notion_database_id="${NOTION_DAILY_INTELLIGENCE_DATABASE_ID:?NOTION_DAILY_INTELLIGENCE_DATABASE_ID is required}"

sync_raw="$(curl --fail-with-body --silent --show-error \
  --request POST "${functions_url%/}/sync-notion-intelligence" \
  --header "Authorization: Bearer ${invoke_secret}" \
  --header "Content-Type: application/json" \
  --write-out $'\n%{http_code}')"
sync_status="${sync_raw##*$'\n'}"
sync_body="${sync_raw%$'\n'*}"
if [[ "$sync_status" != "200" ]]; then
  echo "sync-notion-intelligence returned HTTP ${sync_status}" >&2
  exit 1
fi

jq -e '
  (.ranking_date | type == "string") and
  (.considered | type == "number") and
  (.created | type == "number") and
  (.updated | type == "number") and
  (.skipped | type == "number") and
  (.failed | type == "number") and
  (.failed >= 0) and
  ((.created + .updated + .skipped) > 0)
' >/dev/null <<<"$sync_body" || {
  echo "sync response did not contain a non-empty safe projection summary" >&2
  exit 1
}

notion_raw="$(curl --fail-with-body --silent --show-error \
  --request POST "https://api.notion.com/v1/databases/${notion_database_id}/query" \
  --header "Authorization: Bearer ${notion_token}" \
  --header 'Notion-Version: 2022-06-28' \
  --header 'Content-Type: application/json' \
  --data '{"page_size":100}')"

notion_pages="$(jq '[.results[]?] | length' <<<"$notion_raw")"
notion_identity_pages="$(jq '[.results[]?.properties["Sync Identity"].rich_text // [] | select(length > 0)] | length' <<<"$notion_raw")"
if (( notion_pages < 1 || notion_identity_pages < 1 )); then
  echo "Notion Daily Intelligence did not contain a synced identity page" >&2
  exit 1
fi

jq -n \
  --argjson sync "$sync_body" \
  --argjson notion_pages "$notion_pages" \
  --argjson notion_identity_pages "$notion_identity_pages" \
  '$sync + {notion_pages: $notion_pages, notion_identity_pages: $notion_identity_pages}' \
  >"$output"
echo "Milestone 4.5 smoke passed: ${output}"
