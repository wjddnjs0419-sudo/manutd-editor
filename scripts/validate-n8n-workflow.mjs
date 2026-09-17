import assert from "node:assert/strict";
import fs from "node:fs";

const path = process.argv[2];
assert.ok(path, "usage: node scripts/validate-n8n-workflow.mjs <workflow.json>");

const workflow = JSON.parse(fs.readFileSync(path, "utf8"));
assert.equal(workflow.name, "Instagram Collector Schedule");
assert.equal(workflow.settings?.timezone, "Asia/Seoul");
assert.equal(workflow.active, false);
assert.deepEqual(
  workflow.nodes.map((node) => node.type).sort(),
  [
    "n8n-nodes-base.httpRequest",
    "n8n-nodes-base.scheduleTrigger",
  ].sort(),
);

const schedule = workflow.nodes.find((node) =>
  node.type === "n8n-nodes-base.scheduleTrigger"
);
assert.deepEqual(schedule?.parameters?.rule?.interval, [{
  field: "minutes",
  minutesInterval: 30,
}]);

const request = workflow.nodes.find((node) =>
  node.type === "n8n-nodes-base.httpRequest"
);
assert.equal(request?.parameters?.method, "POST");
assert.match(
  request?.parameters?.url ?? "",
  /\/functions\/v1\/collect-instagram$/,
);
assert.equal(request?.parameters?.authentication, "genericCredentialType");
assert.equal(request?.parameters?.genericAuthType, "httpHeaderAuth");
assert.equal(request?.parameters?.sendBody, false);
assert.equal(request?.credentials, undefined, "export must not bind a credential");

const serialized = JSON.stringify(workflow);
for (const forbidden of [
  "META_ACCESS_TOKEN",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SECRET_KEYS",
  "sb_secret_",
  "EAAB",
  "Bearer ",
  "Authorization",
]) {
  assert.equal(
    serialized.includes(forbidden),
    false,
    `forbidden credential marker: ${forbidden}`,
  );
}

console.log("workflow validation passed");
