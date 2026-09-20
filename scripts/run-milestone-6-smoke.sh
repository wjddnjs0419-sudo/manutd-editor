#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
env_file="${SUPABASE_FUNCTIONS_ENV_FILE:-$repo_dir/supabase/functions/.env.local}"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi

: "${SUPABASE_URL:?SUPABASE_URL is required for M6 smoke}"
: "${SUPABASE_SECRET_KEY:?SUPABASE_SECRET_KEY is required for M6 smoke}"
db_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:55322/postgres}"

docker_env_args=()
if [[ -f "$env_file" ]]; then
  docker_env_args+=(--env-file "$env_file")
else
  docker_env_args+=(--env "SUPABASE_URL=$SUPABASE_URL" --env "SUPABASE_SECRET_KEY=$SUPABASE_SECRET_KEY")
fi

docker run --rm "${docker_env_args[@]}" --add-host=host.docker.internal:host-gateway \
  -v "$repo_dir/supabase:/workspace/supabase" -w /workspace/supabase \
  denoland/deno:2.1.4 deno test --allow-env --allow-net \
  tests/integration/milestone_6_telegram_integration_test.ts

if command -v psql >/dev/null 2>&1; then
  psql "$db_url" -X -v ON_ERROR_STOP=1 -f "$script_dir/verify-milestone-6-smoke.sql" >/dev/null
else
  docker run --rm -i --add-host=host.docker.internal:host-gateway postgres:17-alpine \
    psql "${db_url/127.0.0.1/host.docker.internal}" -X -v ON_ERROR_STOP=1 \
    -f - <"$script_dir/verify-milestone-6-smoke.sql" >/dev/null
fi

node "$script_dir/validate-n8n-workflow.mjs" "$repo_dir/n8n/workflows/fixture-sync-schedule.json" >/dev/null
node "$script_dir/validate-n8n-workflow.mjs" "$repo_dir/n8n/workflows/telegram-morning-brief.json" >/dev/null
node "$script_dir/validate-n8n-workflow.mjs" "$repo_dir/n8n/workflows/telegram-editorial-agent.json" >/dev/null

"$script_dir/run-milestone-6-espn-smoke.sh"

if rg -n --hidden --glob '!.git/**' --glob '!*.md' --glob '!*.json' \
  --glob '!scripts/run-milestone-6-smoke.sh' \
  'sk-[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9._-]{20,}' "$repo_dir"; then
  echo "secret-like value found in source tree" >&2
  exit 1
fi

echo "Milestone 6 local smoke passed. ESPN is public; credentialed OpenAI/Telegram/Notion smoke is skipped unless explicitly configured."
