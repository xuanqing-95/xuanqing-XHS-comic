#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildDeliveryManifest } from "./delivery-manifest.mjs";

const sourceIdentity = {
  policy: "github-release-pinned",
  repository: "https://github.com/xuanqing-95/xuanqing-XHS-comic",
  canonicalPath: ".",
  commit: "a".repeat(40),
  releaseTag: "v0.3.9",
  version: "0.3.9",
  artifactVersion: 3,
  sourceSha256: "b".repeat(64),
  publicConfigSha256: "c".repeat(64),
};

function tinyPng(width, height, marker) {
  const bytes = Buffer.alloc(25);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = marker;
  return bytes;
}

async function writeJson(root, file, value) {
  await writeFile(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "social-comic-delivery-"));
const cases = [];
try {
  await mkdir(path.join(tempDir, "images"));
  await mkdir(path.join(tempDir, "source-images"));
  await writeFile(path.join(tempDir, "images", "01.png"), tinyPng(3, 4, 1));
  await writeFile(path.join(tempDir, "source-images", "01.png"), tinyPng(3, 4, 2));
  await writeJson(tempDir, "input.json", { version: 3, output: { textStrategy: "post-layout" } });
  await writeJson(tempDir, "comic-plan.json", { version: 3, pageCount: 1 });
  await writeJson(tempDir, "result.json", {
    version: 3,
    status: "reviewed",
    pageCount: 1,
    aspectRatio: "3:4",
    pages: ["images/01.png"],
    sourcePages: ["source-images/01.png"],
  });
  await writeJson(tempDir, "usage.json", {
    version: 3,
    status: "complete",
    calls: [
      { callId: "task:plan", role: "planner", status: "succeeded", meteringStatus: "available", pricingModel: "mock:text", usage: { input_tokens: 1 } },
      { callId: "task:image", role: "image", status: "succeeded", meteringStatus: "available", pricingModel: "mock:image", usage: { output_tokens: 1 } },
      { callId: "task:eval", role: "evaluator", status: "succeeded", meteringStatus: "available", pricingModel: "mock:vision", usage: { input_tokens: 1 } },
    ],
  });
  await writeJson(tempDir, "eval-report.json", { version: 3, status: "pass", hardGates: { outputIntegrity: { status: "pass" } } });
  await writeJson(tempDir, "diagnosis.json", { version: 3, status: "no-material-failure", issues: [] });
  for (const file of ["story.json", "character-bible.json", "visual-lock.json", "copywriting.json", "lettering-plan.json", "lettering-report.json"]) {
    await writeJson(tempDir, file, { version: 3 });
  }

  const manifest = await buildDeliveryManifest({
    runDir: tempDir,
    runId: "run-1",
    hostItemId: "item-1",
    hostActionId: "comic.generate",
    hostMetadata: { workspace: "example" },
    sourceIdentity,
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  assert.equal(manifest.deliveryState, "publishable");
  assert.equal(manifest.pages.length, 1);
  assert.equal(manifest.pages[0].relativePath, "images/01.png");
  assert.equal(manifest.pages[0].width, 3);
  assert.equal(manifest.pages[0].height, 4);
  assert.deepEqual(manifest.host, {
    actionId: "comic.generate",
    itemId: "item-1",
    metadata: { workspace: "example" },
  });
  cases.push("reviewed-complete-run-builds-publishable-manifest");

  assert.deepEqual(manifest.privateArtifacts.filter((item) => item.role === "provider-source").map((item) => item.relativePath), ["source-images/01.png"]);
  assert.equal(manifest.pages.some((item) => item.relativePath.startsWith("source-images/")), false);
  cases.push("provider-sources-never-enter-public-pages");

  assert.equal(JSON.stringify(manifest).includes(tempDir), false);
  assert.equal(manifest.privateArtifacts.some((item) => path.isAbsolute(item.relativePath)), false);
  cases.push("manifest-contains-no-local-absolute-paths");

  const usagePath = path.join(tempDir, "usage.json");
  const completeUsage = JSON.parse(await readFile(usagePath, "utf8"));
  await writeJson(tempDir, "usage.json", { ...completeUsage, status: "partial" });
  await assert.rejects(() => buildDeliveryManifest({
    runDir: tempDir,
    runId: "run-1",
    hostItemId: "item-1",
    hostActionId: "comic.generate",
    sourceIdentity,
  }), /complete provider metering/);
  await writeJson(tempDir, "usage.json", completeUsage);
  cases.push("partial-usage-fails-closed-before-delivery");

  const resultPath = path.join(tempDir, "result.json");
  const reviewedResult = JSON.parse(await readFile(resultPath, "utf8"));
  await writeJson(tempDir, "result.json", { ...reviewedResult, status: "needs-review" });
  await assert.rejects(() => buildDeliveryManifest({
    runDir: tempDir,
    runId: "run-1",
    hostItemId: "item-1",
    hostActionId: "comic.generate",
    sourceIdentity,
  }), /result.status reviewed/);
  cases.push("needs-review-never-becomes-public-delivery");

  console.log(JSON.stringify({ valid: true, cases }, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
