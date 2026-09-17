#!/usr/bin/env bash
set -euo pipefail

output=""
while (($# > 0)); do
  case "$1" in
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

if [[ -z "$output" ]]; then
  echo "--output is required" >&2
  exit 2
fi

supabase_url="${SUPABASE_URL:-${LOCAL_SUPABASE_URL:-http://127.0.0.1:55321}}"
supabase_secret_key="${SUPABASE_SECRET_KEY:-${LOCAL_SUPABASE_SECRET_KEY:-}}"
functions_url="${SUPABASE_FUNCTIONS_URL:-${supabase_url%/}/functions/v1}"
db_url="${SUPABASE_DB_URL:-${LOCAL_SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:55322/postgres}}"

if [[ -z "$supabase_secret_key" ]]; then
  echo "SUPABASE_SECRET_KEY or LOCAL_SUPABASE_SECRET_KEY is required" >&2
  exit 1
fi
if [[ -z "${COLLECTOR_INVOKE_SECRET:-}" ]]; then
  echo "COLLECTOR_INVOKE_SECRET is required" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

body_file=$(mktemp)
candidate_file=$(mktemp)
response_file=$(mktemp)
trap 'rm -f "$body_file" "$candidate_file" "$response_file"' EXIT

die() {
  echo "$1" >&2
  exit 1
}

rest_get() {
  curl --silent --show-error --fail \
    --globoff \
    --header "apikey: $supabase_secret_key" \
    --header "Authorization: Bearer $supabase_secret_key" \
    "${supabase_url%/}/rest/v1/$1"
}

http_status=$(curl --silent --show-error \
  --output "$response_file" \
  --write-out '%{http_code}' \
  --request POST \
  --header "Authorization: Bearer ${COLLECTOR_INVOKE_SECRET}" \
  --header 'Content-Type: application/json' \
  "${functions_url%/}/intelligence" || true)

if [[ "$http_status" != "200" && "$http_status" != "202" ]]; then
  die "intelligence returned HTTP $http_status"
fi

if ! jq -e '
  type == "object" and
  (.request_id | type == "string") and
  (.run_id | type == "string") and
  (.status == "completed" or .status == "already_running") and
  (.clusters_processed | type == "number") and
  (.candidates_upserted | type == "number") and
  (has("error") | not)
' "$response_file" >/dev/null 2>&1; then
  die "intelligence returned an invalid safe summary"
fi

ranking_date=$(date -u '+%Y-%m-%d')
candidate_query="content_candidates?select=rank,story_cluster_id,priority_score,data_confidence,first_mover_flag,must_cover_flag,korea_coverage_status,global_spread_score,engagement_outperformance_score,engagement_velocity_score,velocity_acceleration_score,korea_gap_score,first_mover_score,korean_saturation_score,reliability_score,source_diversity_score,freshness_score,story_clusters(canonical_title,story_cluster_posts(raw_posts(source_accounts(username,region))))&ranking_date=eq.${ranking_date}&order=priority_score.desc,data_confidence.desc,story_cluster_id.asc&limit=5"
if ! rest_get "$candidate_query" >"$candidate_file"; then
  die "candidate query failed"
fi

if ! jq -e 'type == "array"' "$candidate_file" >/dev/null 2>&1; then
  die "candidate query returned an invalid response"
fi

jq 'map({
  rank,
  story_cluster_id,
  title: (.story_clusters.canonical_title // "Untitled story"),
  member_usernames: ([.story_clusters.story_cluster_posts[]?.raw_posts.source_accounts.username] | map(select(type == "string")) | unique | sort),
  region_counts: ([.story_clusters.story_cluster_posts[]?.raw_posts.source_accounts.region] | map(select(type == "string")) | group_by(.) | map({key: .[0], value: length}) | from_entries),
  priority_score,
  components: {
    global_spread: .global_spread_score,
    engagement_outperformance: .engagement_outperformance_score,
    engagement_velocity: .engagement_velocity_score,
    velocity_acceleration: .velocity_acceleration_score,
    korea_gap: .korea_gap_score,
    first_mover: .first_mover_score,
    korean_saturation: .korean_saturation_score,
    reliability: .reliability_score,
    source_diversity: .source_diversity_score,
    freshness: .freshness_score
  },
  data_confidence,
  flags: {first_mover: .first_mover_flag, must_cover: .must_cover_flag},
  korea_coverage_status
})' "$candidate_file" >"$body_file"

psql_run() {
  if command -v psql >/dev/null 2>&1; then
    psql "$@"
  else
    local container_db_url="$db_url"
    container_db_url="${container_db_url/127.0.0.1/host.docker.internal}"
    docker run --rm -i \
      --add-host=host.docker.internal:host-gateway \
      postgres:17-alpine psql "$container_db_url" "$@"
  fi
}

if ! psql_run -X -v ON_ERROR_STOP=1 \
  -f "$(dirname "$0")/verify-milestone-4-smoke.sql"; then
  die "milestone 4 smoke assertions failed"
fi

install -m 600 "$body_file" "$output"
cat "$output"
