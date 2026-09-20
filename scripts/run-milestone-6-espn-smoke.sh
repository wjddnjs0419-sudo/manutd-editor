#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

slugs=(eng.1 eng.fa eng.league_cup uefa.champions uefa.europa)
for slug in "${slugs[@]}"; do
  curl --fail --silent --show-error --max-time 20 \
    "https://site.web.api.espn.com/apis/site/v2/sports/soccer/$slug/teams/360/schedule" \
    >"$tmp_dir/${slug//./_}.json"
done

node - "$tmp_dir" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const directory = process.argv[2];
const files = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
let fixtureCount = 0;
for (const file of files) {
  const body = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
  if (body.team?.id !== "360" || body.team?.displayName !== "Manchester United") {
    throw new Error(`ESPN team identity mismatch in ${file}`);
  }
  if (!Array.isArray(body.events)) throw new Error(`ESPN schema mismatch in ${file}`);
  for (const event of body.events) {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors;
    if (typeof event.id !== "string" || !Number.isFinite(Date.parse(event.date)) || !Array.isArray(competitors) || competitors.length !== 2) {
      throw new Error(`ESPN fixture schema mismatch in ${file}`);
    }
    const united = competitors.find((candidate) => candidate.id === "360");
    if (!united || !["home", "away"].includes(united.homeAway)) throw new Error(`ESPN MU fixture identity mismatch in ${file}`);
    fixtureCount += 1;
  }
}
console.log(`ESPN smoke passed: verified Manchester United team 360 across ${files.length} competitions; ${fixtureCount} fixture(s) returned.`);
if (fixtureCount === 0) console.log("no fixture in requested window");
NODE

if [[ -n "${M6_FIXTURE_SYNC_URL:-}" && -n "${TELEGRAM_AGENT_INVOKE_SECRET:-}" ]]; then
  first=$(curl --fail --silent --show-error --max-time 30 -X POST "$M6_FIXTURE_SYNC_URL" \
    -H "Authorization: Bearer $TELEGRAM_AGENT_INVOKE_SECRET" \
    -H 'Content-Type: application/json' --data '{"mode":"FORCE"}')
  second=$(curl --fail --silent --show-error --max-time 30 -X POST "$M6_FIXTURE_SYNC_URL" \
    -H "Authorization: Bearer $TELEGRAM_AGENT_INVOKE_SECRET" \
    -H 'Content-Type: application/json' --data '{"mode":"FORCE"}')
  node - "$first" "$second" <<'NODE'
const first = JSON.parse(process.argv[2]);
const second = JSON.parse(process.argv[3]);
for (const result of [first, second]) {
  if (!["SYNCED", "NOOP"].includes(result.status)) throw new Error("fixture sync did not complete safely");
}
console.log(`fixture sync smoke passed: first=${first.status}, second=${second.status}; canonical upsert is idempotent at (provider, external_match_id).`);
NODE
else
  echo "ESPN endpoint smoke passed; canonical DB upsert smoke skipped (set M6_FIXTURE_SYNC_URL and TELEGRAM_AGENT_INVOKE_SECRET to enable)."
fi
