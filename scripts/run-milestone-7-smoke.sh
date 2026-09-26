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

if [[ -n "${SUPABASE_URL:-}" ]]; then
  case "$SUPABASE_URL" in
    http://127.0.0.1:*|http://localhost:*) ;;
    *) unset SUPABASE_URL SUPABASE_SECRET_KEY ;;
  esac
fi

if [[ -z "${SUPABASE_SECRET_KEY:-}" ]]; then
  eval "$(supabase status -o env)"
  SUPABASE_SECRET_KEY="${SECRET_KEY:-${SERVICE_ROLE_KEY:-}}"
fi

supabase_url="${SUPABASE_URL:-${API_URL:-http://127.0.0.1:55321}}"
service_key="${SUPABASE_SECRET_KEY:-}"
if [[ -z "$service_key" ]]; then
  echo "SUPABASE_SECRET_KEY is required for local smoke" >&2
  exit 1
fi
case "$supabase_url" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "M7 smoke only accepts a local SUPABASE_URL" >&2
    exit 1
    ;;
esac

bash -n "$repo_dir/scripts/register-telegram-webhook.sh"
test -x "$repo_dir/scripts/register-telegram-webhook.sh"
rg -q 'setWebhook' "$repo_dir/scripts/register-telegram-webhook.sh"
rg -q 'secret_token' "$repo_dir/scripts/register-telegram-webhook.sh"
rg -q -- '--fail' "$repo_dir/scripts/register-telegram-webhook.sh"

supabase db reset --local
supabase test db --local

container_url="${supabase_url/127.0.0.1/host.docker.internal}"
container_url="${container_url/localhost/host.docker.internal}"
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e "SUPABASE_URL=$container_url" \
  -e "SUPABASE_SECRET_KEY=$service_key" \
  -v "$repo_dir/supabase:/workspace" \
  -w /workspace \
  denoland/deno:2.1.4 \
  deno test --allow-env --allow-net \
    tests/integration/milestone_7_orchestration_integration_test.ts \
    tests/integration/milestone_7_phase_2_parity_test.ts \
    tests/integration/milestone_7_phase_3_parity_test.ts

if rg -n --hidden --glob '!.git/**' --glob '!.superpowers/**' --glob '!*.md' --glob '!*.json' --glob '!*.env*' \
  --glob '!scripts/run-milestone-7-smoke.sh' \
  --glob '!scripts/run-milestone-7-phase-1-smoke.sh' \
  'sk-[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9._-]{20,}' "$repo_dir"; then
  echo "secret-like value found in source tree" >&2
  exit 1
fi

echo "Milestone 7 local smoke passed: Cron roots, queue/worker chains, Notion isolation, observability, direct Telegram webhook, and n8n-free parity verified."
