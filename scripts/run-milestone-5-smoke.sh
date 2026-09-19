#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
env_file="${SUPABASE_FUNCTIONS_ENV_FILE:-$repo_dir/supabase/functions/.env.local}"
if [[ ! -f "$env_file" && -f "$repo_dir/../../supabase/functions/.env.local" ]]; then
  env_file="$repo_dir/../../supabase/functions/.env.local"
fi
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi
supabase_url="${SUPABASE_URL:-${LOCAL_SUPABASE_URL:-http://127.0.0.1:55321}}"
db_url="${SUPABASE_DB_URL:-${LOCAL_SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:55322/postgres}}"

if ! command -v jq >/dev/null 2>&1; then echo "jq is required" >&2; exit 1; fi

docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$repo_dir/supabase:/workspace/supabase" -w /workspace/supabase \
  denoland/deno:2.1.4 deno test --allow-env --allow-read \
  tests/integration/milestone_5_generation_integration_test.ts

psql_run() {
  if command -v psql >/dev/null 2>&1; then
    psql "$@"
  else
    local container_db_url="${db_url/127.0.0.1/host.docker.internal}"
    docker run --rm -i --add-host=host.docker.internal:host-gateway postgres:17-alpine psql "$container_db_url" "$@"
  fi
}
psql_run "$db_url" -X -v ON_ERROR_STOP=1 -f - <"$script_dir/verify-milestone-5-smoke.sql" >/dev/null

if rg -n --hidden --glob '!.git/**' --glob '!*.md' --glob '!*.json' \
  --glob '!scripts/run-milestone-5-smoke.sh' \
  'sk-[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|META_ACCESS_TOKEN=[^[:space:]]+' "$repo_dir"; then
  echo "secret-like value found in source tree" >&2
  exit 1
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "Milestone 5 local smoke passed; actual OpenAI smoke skipped: OPENAI_API_KEY is unavailable."
else
  echo "Milestone 5 local smoke passed; actual OpenAI smoke requires a deployed function and was not invoked by this local-only runner."
fi
