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

env_output=$(supabase status -o env 2>/dev/null)
status_url=$(printf '%s\n' "$env_output" | sed -n 's/^API_URL=//p' | tr -d '"')
status_key=$(printf '%s\n' "$env_output" | sed -n 's/^SECRET_KEY=//p' | tr -d '"')
supabase_url="${SUPABASE_URL:-$status_url}"
service_key="${SUPABASE_SECRET_KEY:-$status_key}"

case "$supabase_url" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "M8 Phase B/C smoke only accepts a local SUPABASE_URL" >&2; exit 1 ;;
esac
if [[ -z "$service_key" ]]; then
  echo "SUPABASE_SECRET_KEY is required for local smoke" >&2
  exit 1
fi

echo "Resetting local Supabase and checking database contracts"
supabase db reset --local --yes
supabase test db --local

container_url="${supabase_url/127.0.0.1/host.docker.internal}"
container_url="${container_url/localhost/host.docker.internal}"
echo "Running deterministic M7/M8 function and integration tests"
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e "SUPABASE_URL=$container_url" \
  -e "SUPABASE_SECRET_KEY=$service_key" \
  -v "$repo_dir/supabase:/workspace" \
  -w /workspace \
  denoland/deno:2.1.4 \
  deno test --allow-env --allow-net \
    functions/tests \
    tests/integration/milestone_7_orchestration_integration_test.ts \
    tests/integration/milestone_7_phase_2_parity_test.ts \
    tests/integration/milestone_7_phase_3_parity_test.ts \
    tests/integration/milestone_8_phase_a_integration_test.ts

node --test \
  "$repo_dir/scripts/validate-m7-architecture.test.mjs" \
  "$repo_dir/scripts/validate-m8-phase-b-c-architecture.test.mjs" \
  "$repo_dir/scripts/validate-n8n-workflow.test.mjs"

if rg -n --hidden --glob '!.git/**' --glob '!.superpowers/**' --glob '!*.md' --glob '!*.json' --glob '!*.env*' \
  --glob '!scripts/run-milestone-7-smoke.sh' \
  --glob '!scripts/run-milestone-7-phase-1-smoke.sh' \
  --glob '!scripts/run-milestone-8-phase-a-smoke.sh' \
  --glob '!scripts/run-milestone-8-phase-b-c-smoke.sh' \
  'sk-[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9._-]{20,}' "$repo_dir"; then
  echo "secret-like value found in source tree" >&2
  exit 1
fi

git -C "$repo_dir" diff --check
echo "Milestone 8 Phase B/C local smoke passed; no external provider or production URL was used."
