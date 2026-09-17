import assert from "node:assert/strict";
import fs from "node:fs";

const path = process.argv[2];
assert.ok(path, "usage: node scripts/validate-n8n-workflow.mjs <workflow.json>");

const workflow = JSON.parse(fs.readFileSync(path, "utf8"));
const nodes = workflow.nodes ?? [];
const httpNodes = nodes.filter((node) =>
  node.type === "n8n-nodes-base.httpRequest"
);

assert.equal(workflow.name, "Instagram Collector Schedule");
assert.equal(workflow.settings?.timezone, "Asia/Seoul");
assert.equal(workflow.active, false);
assert.deepEqual(
  nodes.map((node) => node.type).sort(),
  [
    "n8n-nodes-base.httpRequest",
    "n8n-nodes-base.httpRequest",
    "n8n-nodes-base.scheduleTrigger",
  ].sort(),
);

const schedule = nodes.find((node) =>
  node.type === "n8n-nodes-base.scheduleTrigger"
);
assert.deepEqual(schedule?.parameters?.rule?.interval, [{
  field: "minutes",
  minutesInterval: 30,
}]);

const collector = nodes.find((node) =>
  node.name === "Collect Active Instagram Accounts"
);
const intelligence = nodes.find((node) =>
  node.name === "Run Content Intelligence"
);
assert.equal(httpNodes.length, 2, "workflow must have exactly two HTTP nodes");
assert.ok(collector, "collector HTTP node is required");
assert.ok(intelligence, "intelligence HTTP node is required");

function responseOptions(node) {
  return node.parameters?.options?.response?.response ?? {};
}

function assertHttpContract(node, label, endpoint) {
  assert.equal(node.parameters?.method, "POST", `${label} method must be POST`);
  assert.match(
    node.parameters?.url ?? "",
    new RegExp(`/functions/v1/${endpoint}$`),
    `${label} endpoint must be ${endpoint}`,
  );
  assert.equal(
    node.parameters?.authentication,
    "genericCredentialType",
    `${label} must use generic credential authentication`,
  );
  assert.equal(
    node.parameters?.genericAuthType,
    "httpHeaderAuth",
    `${label} must use Header Auth`,
  );
  assert.equal(node.parameters?.sendBody, false, `${label} must not send a body`);
  assert.equal(
    responseOptions(node).responseFormat,
    "json",
    `${label} response must be JSON`,
  );
  const credential = node.credentials?.httpHeaderAuth;
  assert.ok(
    credential && typeof credential === "object",
    `${label} credential reference is required`,
  );
  assert.equal(
    credential.name,
    "Instagram Collector Invoke Secret",
    `${label} credential reference must use the existing credential`,
  );
  assert.deepEqual(
    Object.keys(credential).sort(),
    Object.keys(credential).filter((key) => key === "id" || key === "name").sort(),
    `${label} credential reference must not contain a credential value`,
  );
}

assertHttpContract(collector, "collector", "collect-instagram");
assertHttpContract(intelligence, "intelligence", "intelligence");
assert.equal(
  intelligence.continueOnFail,
  true,
  "intelligence must continue-on-failure",
);
assert.equal(
  intelligence.parameters?.options?.timeout,
  120000,
  "intelligence must use a 120-second timeout",
);
assert.equal(
  responseOptions(intelligence).neverError,
  true,
  "intelligence must preserve non-error JSON responses including HTTP 202",
);
assert.equal(
  responseOptions(intelligence).includeResponseHeadersAndStatus,
  true,
  "intelligence must expose HTTP status for already_running handling",
);

function outgoingTargets(sourceName) {
  return (workflow.connections?.[sourceName]?.main ?? [])
    .flat()
    .filter(Boolean);
}

const scheduleTargets = outgoingTargets(schedule.name);
assert.equal(
  scheduleTargets.length,
  1,
  "schedule must have exactly one outgoing edge to collector",
);
assert.equal(
  scheduleTargets[0].node,
  collector.name,
  "schedule must connect to collector",
);

const collectorTargets = outgoingTargets(collector.name);
assert.equal(
  collectorTargets.length,
  1,
  "collector must have exactly one intelligence edge",
);
assert.equal(
  collectorTargets[0].node,
  intelligence.name,
  "collector must connect to intelligence",
);

const intelligenceTargets = outgoingTargets(intelligence.name);
assert.equal(
  intelligenceTargets.length,
  0,
  "intelligence must be the final node in this workflow",
);

const serialized = JSON.stringify(workflow);
for (const forbidden of [
  "META_ACCESS_TOKEN",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SECRET_KEYS",
  "sb_secret_",
  "EAAB",
  "Bearer ",
]) {
  assert.equal(
    serialized.includes(forbidden),
    false,
    `forbidden secret marker: ${forbidden}`,
  );
}

console.log("workflow validation passed");
