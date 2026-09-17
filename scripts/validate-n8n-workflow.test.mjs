import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const validator = path.join(root, "scripts/validate-n8n-workflow.mjs");
const fixturePath = path.join(
  root,
  "scripts/fixtures/n8n/instagram-collector-task-7.json",
);

function readFixture() {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function runValidator(workflow) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-validator-"));
  const workflowPath = path.join(directory, "workflow.json");
  fs.writeFileSync(workflowPath, JSON.stringify(workflow));
  return spawnSync(process.execPath, [validator, workflowPath], {
    encoding: "utf8",
  });
}

function intelligence(workflow) {
  return workflow.nodes.find((node) => node.name === "Run Content Intelligence");
}

function collector(workflow) {
  return workflow.nodes.find((node) =>
    node.name === "Collect Active Instagram Accounts"
  );
}

test("accepts the collector-to-intelligence workflow contract", () => {
  const result = runValidator(readFixture());
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("rejects a workflow without the collector-to-intelligence edge", () => {
  const workflow = readFixture();
  delete workflow.connections[collector(workflow).name];
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /collector.*intelligence edge/i);
});

test("rejects a workflow that can invoke intelligence more than once", () => {
  const workflow = readFixture();
  workflow.connections["Every 30 Minutes"].main[0].push({
    node: "Run Content Intelligence",
    type: "main",
    index: 0,
  });
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schedule.*exactly one outgoing edge/i);
});

test("rejects an intelligence request that is not POST", () => {
  const workflow = readFixture();
  intelligence(workflow).parameters.method = "GET";
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /intelligence.*POST/i);
});

test("rejects a request that does not target the intelligence endpoint", () => {
  const workflow = readFixture();
  intelligence(workflow).parameters.url =
    "https://byymtttpwmllqvggnddm.supabase.co/functions/v1/collect-instagram";
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /intelligence endpoint/i);
});

test("rejects intelligence responses that are not JSON", () => {
  const workflow = readFixture();
  delete intelligence(workflow).parameters.options.response.response
    .responseFormat;
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /response must be JSON/i);
});

test("rejects intelligence responses that cannot preserve HTTP 202 already_running", () => {
  const workflow = readFixture();
  intelligence(workflow).parameters.options.response.response.neverError = false;
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /202/i);
});

test("rejects an intelligence request without the 120-second timeout", () => {
  const workflow = readFixture();
  intelligence(workflow).parameters.options.timeout = 30000;
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /120.?second timeout/i);
});

test("rejects an intelligence request without the existing credential reference", () => {
  const workflow = readFixture();
  delete intelligence(workflow).credentials;
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /credential reference/i);
});

test("rejects an intelligence request that does not continue on failure", () => {
  const workflow = readFixture();
  delete intelligence(workflow).continueOnFail;
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /continue.?on.?failure/i);
});

test("rejects exported credential values or secret-like markers", () => {
  const workflow = readFixture();
  workflow.nodes[1].credentials.httpHeaderAuth.value = "fixture-secret-value";
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /secret|credential value/i);
});
