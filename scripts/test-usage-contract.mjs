#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildUsageArtifact,
  sha256Bytes,
  stableHash,
  summarizeUsageStatus,
  upsertUsageCall,
  validateUsageCall,
} from "./usage-contract.mjs";

function successful(callId, role, usage) {
  return {
    callId,
    role,
    stage: role === "image" ? "generate" : role === "planner" ? "plan" : "evaluate",
    operation: role === "image" ? "generation" : "chat",
    status: "succeeded",
    meteringStatus: usage ? "available" : "unavailable",
    provider: "mock",
    model: "mock-model",
    pricingModel: "mock:mock-model",
    inputHash: stableHash(`${callId}:input`),
    outputHash: stableHash(`${callId}:output`),
    completedAt: "2026-07-21T00:00:00.000Z",
    usage,
  };
}

const metered = { input_tokens: 10, output_tokens: 5 };
const cases = [];

assert.equal(summarizeUsageStatus([]), "not_applicable");
cases.push("no-model-call-is-not-applicable");

assert.equal(summarizeUsageStatus([successful("run:plan", "planner", metered)]), "complete");
cases.push("all-successful-model-calls-metered-is-complete");

assert.equal(summarizeUsageStatus([
  successful("run:plan", "planner", metered),
  successful("run:page:1", "image", null),
]), "partial");
cases.push("one-missing-role-usage-is-partial");

assert.equal(summarizeUsageStatus([
  successful("run:plan", "planner", null),
  successful("run:page:1", "image", null),
]), "unavailable");
cases.push("all-provider-metering-missing-is-unavailable");

const started = {
  callId: "run:page:1",
  role: "image",
  stage: "generate",
  operation: "generation",
  status: "started",
  meteringStatus: "pending",
  inputHash: stableHash("input"),
};
assert.deepEqual(validateUsageCall(started), []);
cases.push("started-call-remains-an-ambiguous-intent");

const updated = upsertUsageCall([started], successful("run:page:1", "image", metered));
assert.equal(updated.length, 1);
assert.equal(updated[0].status, "succeeded");
cases.push("stable-call-id-upserts-instead-of-duplicating");

const localCompose = {
  callId: "run:compose",
  role: "compositor",
  stage: "compose",
  operation: "compose",
  status: "succeeded",
  meteringStatus: "not_applicable",
  inputHash: stableHash("layout"),
  outputHash: stableHash("lettered-page"),
};
assert.deepEqual(validateUsageCall(localCompose), []);
assert.equal(buildUsageArtifact([localCompose]).status, "not_applicable");
cases.push("local-compose-is-not-a-zero-token-model-call");

const invalidAvailable = successful("run:evaluate", "evaluator", {});
invalidAvailable.meteringStatus = "available";
assert.ok(validateUsageCall(invalidAvailable).some((error) => error.includes("positive metering")));
cases.push("zero-usage-cannot-claim-available");

assert.equal(stableHash({ a: 1 }), stableHash({ a: 1 }));
assert.equal(
  sha256Bytes(Buffer.from("raw-image-bytes")),
  createHash("sha256").update(Buffer.from("raw-image-bytes")).digest("hex"),
);
assert.notEqual(sha256Bytes(Buffer.from("raw-image-bytes")), stableHash(Buffer.from("raw-image-bytes").toString("base64")));
cases.push("receipt-hashes-are-deterministic");

console.log(JSON.stringify({ valid: true, cases }, null, 2));
