import assert from "node:assert/strict";
import fs from "node:fs";

const path = process.argv[2];
assert.ok(path, "usage: node scripts/validate-n8n-workflow.mjs <workflow.json>");

const workflow = JSON.parse(fs.readFileSync(path, "utf8"));
const nodes = workflow.nodes ?? [];
const httpNodes = nodes.filter((node) =>
  node.type === "n8n-nodes-base.httpRequest"
);

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_AGENT_INVOKE_SECRET",
    "OPENAI_API_KEY", "NOTION_TOKEN", "SUPABASE_SECRET_KEY", "sb_secret_", "Bearer ",
  ]) assert.equal(serialized.includes(forbidden), false, `forbidden secret marker: ${forbidden}`);
}

function validateMilestone6() {
  assert.equal(workflow.active, false, "M6 workflows must be inactive in git");
  assert.equal(workflow.settings?.timezone, "Asia/Seoul");
  assert.equal(nodes.some((node) => node.type === "n8n-nodes-base.code"), false, "M6 workflows must not contain Code nodes");
  assertNoSecrets(workflow);
  const http = nodes.filter((node) => node.type === "n8n-nodes-base.httpRequest");
  for (const node of http) {
    assert.equal(node.parameters?.method, "POST", `${node.name} method must be POST`);
    assert.match(node.parameters?.url ?? "", /\/functions\/v1\/(fixture-sync|telegram-alerts|telegram-morning-brief|telegram-agent)$/u);
    assert.equal(node.parameters?.authentication, "genericCredentialType");
    assert.equal(node.parameters?.genericAuthType, "httpHeaderAuth");
    assert.equal(node.credentials?.httpHeaderAuth?.name, "Telegram Agent Invoke Secret");
    assert.deepEqual(Object.keys(node.credentials.httpHeaderAuth).sort(), ["name"], "credential references cannot contain values");
  }
  if (workflow.name === "Fixture Sync Schedule") {
    const schedule = nodes.find((node) => node.type === "n8n-nodes-base.scheduleTrigger");
    assert.deepEqual(schedule?.parameters?.rule?.interval, [{ field: "minutes", minutesInterval: 15 }]);
    assert.equal(http.length, 2);
    assert.match(http[0].parameters.url, /\/fixture-sync$/u);
    assert.equal(http[0].parameters.jsonBody, "{\"mode\":\"AUTO\"}");
    assert.match(http[1].parameters.url, /\/telegram-alerts$/u);
    assert.equal(http[1].continueOnFail, true, "Telegram alert dispatch must continue-on-failure");
  } else if (workflow.name === "Telegram Morning Brief") {
    const schedule = nodes.find((node) => node.type === "n8n-nodes-base.scheduleTrigger");
    assert.deepEqual(schedule?.parameters?.rule?.interval, [{ field: "cron", expression: "0 9 * * *" }]);
    assert.equal(http.length, 1);
    assert.match(http[0].parameters.url, /\/telegram-morning-brief$/u);
  } else if (workflow.name === "Telegram Editorial Agent") {
    const trigger = nodes.find((node) => node.type === "n8n-nodes-base.telegramTrigger");
    assert.ok(trigger, "Telegram Trigger is required");
    assert.ok(trigger.credentials?.telegramApi?.name, "Telegram Trigger credential reference is required");
    assert.equal(http.length, 1);
    assert.match(http[0].parameters.url, /\/telegram-agent$/u);
    assert.equal(http[0].parameters.sendBody, true);
  } else throw new Error(`unknown M6 workflow: ${workflow.name}`);
  console.log("workflow validation passed");
}

if (workflow.name !== "Instagram Collector Schedule") {
  validateMilestone6();
  process.exit(0);
}

assert.equal(workflow.name, "Instagram Collector Schedule");
assert.equal(workflow.settings?.timezone, "Asia/Seoul");
assert.equal(workflow.active, false);
const hasAlertNode = nodes.some((node) => node.name === "Dispatch Telegram Alerts");
assert.deepEqual(
  nodes.map((node) => node.type).sort(),
  [...Array.from({ length: hasAlertNode ? 6 : 5 }, () => "n8n-nodes-base.httpRequest"), "n8n-nodes-base.scheduleTrigger"].sort(),
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
const notion = nodes.find((node) =>
  node.name === "Sync Daily Intelligence to Notion"
);
const priority = nodes.find((node) =>
  node.name === "Trigger Priority Creative Generation"
);
const selected = nodes.find((node) =>
  node.name === "Poll Selected Creative Generation"
);
const alert = nodes.find((node) => node.name === "Dispatch Telegram Alerts");
assert.ok(httpNodes.length === 5 || httpNodes.length === 6, "workflow must have five core HTTP nodes and an optional alert node");
assert.ok(collector, "collector HTTP node is required");
assert.ok(intelligence, "intelligence HTTP node is required");
assert.ok(notion, "Notion sync HTTP node is required");
assert.ok(priority, "priority creative generation HTTP node is required");
assert.ok(selected, "selected creative generation HTTP node is required");

function responseOptions(node) {
  return node.parameters?.options?.response?.response ?? {};
}

function assertHttpContract(node, label, endpoint, credentialName = "Instagram Collector Invoke Secret") {
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
    credentialName,
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
  intelligence.continueOnFail ?? false,
  false,
  "intelligence must succeed before Notion sync",
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
assertHttpContract(notion, "Notion sync", "sync-notion-intelligence");
assert.equal(
  notion.continueOnFail,
  true,
  "Notion sync must continue-on-failure",
);
assert.equal(
  responseOptions(notion).neverError,
  true,
  "Notion sync must not invalidate upstream success",
);
assert.equal(
  responseOptions(notion).includeResponseHeadersAndStatus,
  true,
  "Notion sync must expose response status",
);
assert.equal(
  notion.parameters?.options?.timeout,
  120000,
  "Notion sync must use a 120-second timeout",
);
assertHttpContract(priority, "priority creative generation", "creative-generation-priority");
assert.equal(priority.continueOnFail, true, "priority creative generation must continue-on-failure");
assert.equal(responseOptions(priority).neverError, true, "priority creative generation must not invalidate upstream success");
assert.equal(responseOptions(priority).includeResponseHeadersAndStatus, true, "priority creative generation must expose response status");
assert.equal(priority.parameters?.options?.timeout, 120000, "priority creative generation must use a 120-second timeout");
assertHttpContract(selected, "selected creative generation", "creative-generation-selected-poll");
assert.equal(selected.continueOnFail, true, "selected creative generation must continue-on-failure");
assert.equal(responseOptions(selected).neverError, true, "selected creative generation must not invalidate upstream success");
assert.equal(responseOptions(selected).includeResponseHeadersAndStatus, true, "selected creative generation must expose response status");
assert.equal(selected.parameters?.options?.timeout, 120000, "selected creative generation must use a 120-second timeout");

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
  1,
  "intelligence must have exactly one Notion sync edge",
);
assert.equal(
  intelligenceTargets[0].node,
  priority.name,
  "intelligence must connect to priority creative generation",
);

assert.equal(
  outgoingTargets(priority.name).length,
  1,
  "priority creative generation must have exactly one Notion sync edge",
);
assert.equal(
  outgoingTargets(priority.name)[0].node,
  notion.name,
  "priority creative generation must connect to Notion sync",
);

assert.equal(
  outgoingTargets(notion.name).length,
  1,
  "Notion sync must have exactly one selected creative generation edge",
);
assert.equal(
  outgoingTargets(notion.name)[0].node,
  selected.name,
  "Notion sync must connect to selected creative generation",
);

const selectedTargets = outgoingTargets(selected.name);
if (alert) {
  assert.equal(httpNodes.length, 6, "alert branch must be the sixth HTTP node");
  assertHttpContract(alert, "Telegram alert dispatch", "telegram-alerts", "Telegram Agent Invoke Secret");
  assert.equal(alert.continueOnFail, true, "Telegram alert dispatch must continue-on-failure");
  assert.equal(selectedTargets.length, 1, "selected creative generation must connect to alert dispatch");
  assert.equal(selectedTargets[0].node, alert.name, "selected creative generation must connect to alert dispatch");
  assert.equal(outgoingTargets(alert.name).length, 0, "alert dispatch must be the final node");
} else {
  assert.equal(selectedTargets.length, 0, "selected creative generation must be the final node in this workflow");
}

assertNoSecrets(workflow);

console.log("workflow validation passed");
