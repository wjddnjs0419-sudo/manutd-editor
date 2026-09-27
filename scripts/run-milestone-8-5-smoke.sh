#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)

echo "Running M8.5 deterministic Deno tests"
(cd "$repo_dir/supabase/functions" && deno test --allow-env --allow-net tests/trend-discovery tests/m6/editorial_console_actions_test.ts tests/m6/editorial_console_test.ts tests/orchestration-worker/worker_test.ts tests/orchestration-worker/boundary_client_test.ts)

echo "Running M8.5 and existing architecture validators"
node --test \
  "$repo_dir/scripts/validate-m8-5-trend-discovery-architecture.test.mjs" \
  "$repo_dir/scripts/validate-m8-editorial-console-architecture.test.mjs" \
  "$repo_dir/scripts/validate-m8-phase-b-c-architecture.test.mjs"

if rg -n --hidden --glob '!.git/**' --glob '!.superpowers/**' --glob '!*.md' --glob '!*.json' --glob '!*.env*' \
  'sk-[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9._-]{20,}' "$repo_dir"; then
  echo "secret-like value found in source tree" >&2
  exit 1
fi

git -C "$repo_dir" diff --check
echo "M8.5 deterministic smoke passed; no provider or production deployment was invoked."
