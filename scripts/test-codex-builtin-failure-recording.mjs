#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { recordCodexBuiltinFailure } from "./record-codex-builtin-failure.mjs";

const roots = [];
const cases = [];
const recorderPath = fileURLToPath(new URL("./record-codex-builtin-failure.mjs", import.meta.url));

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

function invocation(pageId, dependsOn = []) {
  const number = pageId.slice(-2);
  return {
    id: `codex-builtin-${pageId}`,
    pageId,
    dependsOn,
    prompt: { canonicalFile: `prompts/${number}.md`, derivedFile: `codex-prompts/${number}.md` },
    attachments: [{ file: "codex-builtin-assets/aspect-only-blank-3x4.png", roles: ["canvas-aspect"] }],
    expectedProviderOutput: `images/${number}.png`,
    finalOutputFile: `images/${number}.png`,
    guardrails: { automaticRetry: false },
  };
}

async function createRun({ pageCount = 1, dependency = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-builtin-failure-"));
  roots.push(root);
  await Promise.all([
    mkdir(path.join(root, "images")),
    mkdir(path.join(root, "prompts")),
    mkdir(path.join(root, "codex-prompts")),
  ]);
  const invocations = Array.from({ length: pageCount }, (_, index) => invocation(
    `page-${String(index + 1).padStart(2, "0")}`,
    dependency && index > 0 ? ["page-01"] : [],
  ));
  for (let index = 0; index < pageCount; index += 1) {
    const number = String(index + 1).padStart(2, "0");
    await writeFile(path.join(root, `prompts/${number}.md`), `canonical prompt ${number}\n`);
    await writeFile(path.join(root, `codex-prompts/${number}.md`), `derived prompt ${number}\n`);
  }
  await Promise.all([
    writeJson(root, "input.json", { version: 3, output: { aspectRatio: "3:4", textStrategy: "native" } }),
    writeJson(root, "comic-plan.json", {
      version: 3,
      aspectRatio: "3:4",
      textStrategy: "native",
      pageCount,
      pages: invocations.map((item) => ({ id: item.pageId, outputFile: item.expectedProviderOutput })),
    }),
    writeJson(root, "result.json", { version: 3, status: "planned", contentPackage: { story: "story.json" } }),
    writeJson(root, "usage.json", { version: 3, status: "not_applicable", calls: [] }),
    writeJson(root, "debug.json", { version: 3, status: "running", stage: "generate", events: [], errors: [], counts: {} }),
    writeJson(root, "codex-builtin-invocations.json", {
      version: 3,
      adapter: "codex-builtin",
      status: "prepared",
      providerCalls: 0,
      sharedPromptContractUnchanged: true,
      invocations,
    }),
  ]);
  return root;
}

async function readJson(root, file) {
  return JSON.parse(await readFile(path.join(root, file), "utf8"));
}

async function mustNotExist(file) {
  await assert.rejects(() => access(file), (error) => error?.code === "ENOENT");
}

try {
  const pageOneRun = await createRun();
  const pageOne = await recordCodexBuiltinFailure({
    runDir: pageOneRun,
    pageId: "page-01",
    code: "HOST_TIMEOUT_NO_OUTPUT",
    message: "Host timed out before returning an image.",
    wallTimeSeconds: 677,
  });
  assert.deepEqual(pageOne, {
    status: "runtime-failed",
    pageId: "page-01",
    code: "HOST_TIMEOUT_NO_OUTPUT",
    replayed: false,
    providerCalls: 0,
    acceptedPageCount: 0,
  });
  const pageOnePlan = await readJson(pageOneRun, "codex-builtin-invocations.json");
  assert.equal(pageOnePlan.status, "runtime-failed");
  assert.equal(pageOnePlan.providerCalls, 0);
  assert.equal(pageOnePlan.invocations[0].status, "runtime-failed");
  assert.equal(pageOnePlan.invocations[0].automaticRetry, false);
  assert.equal(pageOnePlan.invocations[0].providerOutputReturned, false);
  const pageOneResult = await readJson(pageOneRun, "result.json");
  assert.equal(pageOneResult.status, "failed");
  assert.equal(pageOneResult.stage, "generate");
  assert.equal("pages" in pageOneResult, false);
  assert.equal("actualDimensions" in pageOneResult, false);
  const pageOneUsage = await readJson(pageOneRun, "usage.json");
  assert.equal(pageOneUsage.status, "not_applicable");
  assert.equal(pageOneUsage.calls.length, 1);
  assert.equal(pageOneUsage.calls[0].status, "failed");
  assert.equal(pageOneUsage.calls[0].meteringStatus, "unavailable");
  assert.equal("usage" in pageOneUsage.calls[0], false);
  assert.equal("cost" in pageOneUsage.calls[0], false);
  const pageOneDebug = await readJson(pageOneRun, "debug.json");
  assert.equal(pageOneDebug.providerCalls, 0);
  assert.equal(pageOneDebug.callCounts.image, 1);
  assert.equal(pageOneDebug.counts.visualEvaluations, 0);
  assert.equal(pageOneDebug.counts.automaticRetries, 0);
  const diagnosis = await readJson(pageOneRun, "diagnosis.json");
  assert.equal(diagnosis.faultDomain, "runtime");
  assert.equal(diagnosis.promptAudit.status, "pass");
  assert.equal(diagnosis.promptAudit.scope, "integrity-only");
  assert.equal(diagnosis.comparisons.length, 1);
  assert.equal(diagnosis.comparisons[0].promptAudit, "integrity-pass");
  assert.equal(diagnosis.comparisons[0].outputEval, "not-run");
  assert.equal(diagnosis.comparisons[0].attemptStatus, "runtime-failed-without-output");
  assert.equal(diagnosis.visualEvaluation.status, "not-run");
  assert.deepEqual(diagnosis.guardrails, {
    promptChanged: false,
    evalChanged: false,
    automaticRetry: false,
    fakeEvalReportCreated: false,
  });
  await mustNotExist(path.join(pageOneRun, "eval-report.json"));
  cases.push("page-01-timeout-without-output-is-a-runtime-failure-not-a-visual-eval");

  const pageTwoRun = await createRun({ pageCount: 2, dependency: true });
  const acceptedBytes = tinyPng(300, 400, 7);
  await writeFile(path.join(pageTwoRun, "images/01.png"), acceptedBytes);
  const pageTwoPlanBefore = await readJson(pageTwoRun, "codex-builtin-invocations.json");
  pageTwoPlanBefore.status = "receiving";
  pageTwoPlanBefore.invocations[0] = {
    ...pageTwoPlanBefore.invocations[0],
    status: "accepted",
    providerDirect: true,
    dimensions: { width: 300, height: 400 },
    sha256: crypto.createHash("sha256").update(acceptedBytes).digest("hex"),
    automaticRetry: false,
  };
  await writeJson(pageTwoRun, "codex-builtin-invocations.json", pageTwoPlanBefore);
  const pageTwo = await recordCodexBuiltinFailure({
    runDir: pageTwoRun,
    pageId: "page-02",
    code: "HOST_TIMEOUT_NO_OUTPUT",
    message: "Page 2 timed out with no image.",
  });
  assert.equal(pageTwo.acceptedPageCount, 1);
  const pageTwoResult = await readJson(pageTwoRun, "result.json");
  assert.deepEqual(pageTwoResult.pages, ["images/01.png"]);
  assert.deepEqual(pageTwoResult.actualDimensions, [{ file: "images/01.png", width: 300, height: 400 }]);
  assert.deepEqual(pageTwoResult.contentPackage, { story: "story.json" });
  const pageTwoPlan = await readJson(pageTwoRun, "codex-builtin-invocations.json");
  assert.equal(pageTwoPlan.invocations[0].status, "accepted");
  assert.equal(pageTwoPlan.invocations[1].status, "runtime-failed");
  assert.equal(pageTwoPlan.providerCalls, 0);
  const pageTwoDiagnosis = await readJson(pageTwoRun, "diagnosis.json");
  assert.equal(pageTwoDiagnosis.comparisons[0].outputEval, "not-run");
  assert.equal(pageTwoDiagnosis.comparisons[1].outputEval, "not-run");
  assert.match(pageTwoDiagnosis.visualEvaluation.reason, /complete page set is unavailable/);
  cases.push("page-02-timeout-preserves-the-accepted-page-prefix-and-measurements");

  const unmetRun = await createRun({ pageCount: 2, dependency: true });
  await assert.rejects(
    () => recordCodexBuiltinFailure({
      runDir: unmetRun,
      pageId: "page-02",
      code: "HOST_RUNTIME_FAILED",
      message: "Host failed.",
    }),
    /DEPENDENCY_NOT_ACCEPTED/,
  );
  assert.equal((await readJson(unmetRun, "codex-builtin-invocations.json")).status, "prepared");
  await mustNotExist(path.join(unmetRun, "diagnosis.json"));
  cases.push("dependent-page-failure-cannot-be-recorded-before-anchor-acceptance");

  const replayFiles = ["codex-builtin-invocations.json", "result.json", "usage.json", "debug.json", "diagnosis.json"];
  const beforeReplay = await Promise.all(replayFiles.map((file) => readFile(path.join(pageOneRun, file), "utf8")));
  const replay = await recordCodexBuiltinFailure({
    runDir: pageOneRun,
    pageId: "page-01",
    code: "HOST_TIMEOUT_NO_OUTPUT",
    message: "Host timed out before returning an image.",
    wallTimeSeconds: 677,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.providerCalls, 0);
  const afterReplay = await Promise.all(replayFiles.map((file) => readFile(path.join(pageOneRun, file), "utf8")));
  assert.deepEqual(afterReplay, beforeReplay);
  const cliReplay = spawnSync(process.execPath, [
    recorderPath,
    "--run-dir", pageOneRun,
    "--page-id", "page-01",
    "--code", "HOST_TIMEOUT_NO_OUTPUT",
    "--message", "Host timed out before returning an image.",
    "--wall-time-seconds", "677",
  ], { encoding: "utf8" });
  assert.equal(cliReplay.status, 0, cliReplay.stderr || cliReplay.stdout);
  assert.equal(JSON.parse(cliReplay.stdout).providerCalls, 0);
  await assert.rejects(
    () => recordCodexBuiltinFailure({
      runDir: pageOneRun,
      pageId: "page-01",
      code: "HOST_RUNTIME_FAILED",
      message: "A different failure.",
      wallTimeSeconds: 10,
    }),
    /FAILURE_RECORD_CONFLICT/,
  );
  assert.deepEqual(await Promise.all(replayFiles.map((file) => readFile(path.join(pageOneRun, file), "utf8"))), beforeReplay);
  cases.push("identical-replay-is-byte-stable-and-different-failure-cannot-overwrite");

  console.log(JSON.stringify({ valid: true, providerCalls: 0, cases }, null, 2));
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
