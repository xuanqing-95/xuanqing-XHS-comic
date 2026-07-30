#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ingestCodexBuiltinResult } from "./ingest-codex-builtin-result.mjs";

const scriptPath = fileURLToPath(new URL("./ingest-codex-builtin-result.mjs", import.meta.url));
const roots = [];
const cases = [];

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

async function writeJson(root, relativePath, value) {
  await writeFile(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function invocation(pageId, expectedProviderOutput, dependsOn = []) {
  return {
    id: `codex-builtin-${pageId}`,
    pageId,
    dependsOn,
    prompt: { canonicalFile: `prompts/${pageId}.md`, derivedFile: `codex-prompts/${pageId}.md` },
    attachments: [],
    expectedProviderOutput,
    finalOutputFile: expectedProviderOutput,
    validation: {
      providerDirect: true,
      requiredAspectRatio: "3:4",
      measureReturnedPngImmediately: true,
    },
    guardrails: {
      automaticRetry: false,
      preserveNoncompliantOutputAsEvidence: true,
      prohibitedPostProcessing: ["crop", "resize", "pad", "stretch", "stitch"],
    },
  };
}

async function createRun({ invocations = [invocation("page-01", "images/01.png")] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-builtin-ingestion-"));
  roots.push(root);
  await Promise.all([
    mkdir(path.join(root, "images")),
    mkdir(path.join(root, "source-images")),
  ]);
  await writeJson(root, "codex-builtin-invocations.json", {
    version: 3,
    adapter: "codex-builtin",
    status: "prepared",
    providerCalls: 0,
    invocations,
  });
  await writeJson(root, "result.json", { version: 3, status: "planned" });
  await writeJson(root, "eval-report.json", { version: 3, status: "fail", issues: ["not evaluated"] });
  return root;
}

async function providerFile(root, name, bytes) {
  const file = path.join(root, name);
  await writeFile(file, bytes);
  return file;
}

async function mustNotExist(filePath) {
  await assert.rejects(() => access(filePath), (error) => error?.code === "ENOENT");
}

try {
  const acceptedRun = await createRun();
  const acceptedBytes = tinyPng(1086, 1448, 1);
  const acceptedProvider = await providerFile(acceptedRun, "returned-page-01.png", acceptedBytes);
  const resultBefore = await readFile(path.join(acceptedRun, "result.json"));
  const evalBefore = await readFile(path.join(acceptedRun, "eval-report.json"));
  const accepted = await ingestCodexBuiltinResult({
    runDir: acceptedRun,
    pageId: "page-01",
    providerOutput: acceptedProvider,
  });
  const acceptedHash = crypto.createHash("sha256").update(acceptedBytes).digest("hex");
  assert.deepEqual(accepted, {
    status: "accepted",
    pageId: "page-01",
    providerDirect: true,
    dimensions: { width: 1086, height: 1448 },
    sha256: acceptedHash,
    outputFile: "images/01.png",
    replayed: false,
    providerCalls: 0,
  });
  assert.deepEqual(await readFile(path.join(acceptedRun, "images/01.png")), acceptedBytes);
  const acceptedPlan = JSON.parse(await readFile(path.join(acceptedRun, "codex-builtin-invocations.json"), "utf8"));
  assert.equal(acceptedPlan.status, "accepted");
  assert.equal(acceptedPlan.providerCalls, 0);
  assert.equal(acceptedPlan.invocations[0].status, "accepted");
  assert.equal(acceptedPlan.invocations[0].providerDirect, true);
  assert.deepEqual(acceptedPlan.invocations[0].dimensions, { width: 1086, height: 1448 });
  assert.equal(acceptedPlan.invocations[0].sha256, acceptedHash);
  assert.deepEqual(await readFile(path.join(acceptedRun, "result.json")), resultBefore);
  assert.deepEqual(await readFile(path.join(acceptedRun, "eval-report.json")), evalBefore);
  cases.push("native-3x4-copies-identical-bytes-and-records-acceptance-only");

  const inPlaceRun = await createRun();
  const inPlaceBytes = tinyPng(300, 400, 8);
  const inPlaceProvider = path.join(inPlaceRun, "images/01.png");
  await writeFile(inPlaceProvider, inPlaceBytes);
  const inPlace = await ingestCodexBuiltinResult({
    runDir: inPlaceRun,
    pageId: "page-01",
    providerOutput: inPlaceProvider,
  });
  assert.equal(inPlace.replayed, true);
  assert.deepEqual(await readFile(inPlaceProvider), inPlaceBytes);
  cases.push("provider-output-already-at-expected-path-is-not-recopied");

  const replay = await ingestCodexBuiltinResult({
    runDir: acceptedRun,
    pageId: "page-01",
    providerOutput: acceptedProvider,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.providerCalls, 0);
  await writeFile(path.join(acceptedRun, "images/01.png"), tinyPng(1086, 1448, 9));
  await assert.rejects(
    () => ingestCodexBuiltinResult({ runDir: acceptedRun, pageId: "page-01", providerOutput: acceptedProvider }),
    /ACCEPTED_OUTPUT_TAMPERED/,
  );
  cases.push("identical-repeat-is-idempotent-and-tampered-accepted-output-is-rejected");

  const dependencyRun = await createRun({
    invocations: [
      invocation("page-01", "images/01.png"),
      invocation("page-02", "images/02.png", ["page-01"]),
    ],
  });
  const dependencyOne = await providerFile(dependencyRun, "provider-01.png", tinyPng(600, 800, 1));
  const dependencyTwo = await providerFile(dependencyRun, "provider-02.png", tinyPng(601, 801, 2));
  await assert.rejects(
    () => ingestCodexBuiltinResult({ runDir: dependencyRun, pageId: "page-02", providerOutput: dependencyTwo }),
    /DEPENDENCY_NOT_ACCEPTED/,
  );
  await mustNotExist(path.join(dependencyRun, "images/02.png"));
  await ingestCodexBuiltinResult({ runDir: dependencyRun, pageId: "page-01", providerOutput: dependencyOne });
  const dependencyAccepted = await ingestCodexBuiltinResult({
    runDir: dependencyRun,
    pageId: "page-02",
    providerOutput: dependencyTwo,
  });
  assert.equal(dependencyAccepted.status, "accepted");
  const dependencyPlan = JSON.parse(await readFile(path.join(dependencyRun, "codex-builtin-invocations.json"), "utf8"));
  assert.equal(dependencyPlan.status, "accepted");
  assert.equal(dependencyPlan.providerCalls, 0);
  cases.push("dependent-page-is-blocked-until-recorded-anchor-bytes-are-accepted");

  const noncompliantRun = await createRun();
  const wrongBytes = tinyPng(1024, 1536, 3);
  const wrongProvider = await providerFile(noncompliantRun, "wrong-2x3.png", wrongBytes);
  const cli = spawnSync(process.execPath, [
    scriptPath,
    "--run-dir", noncompliantRun,
    "--page-id", "page-01",
    "--provider-output", wrongProvider,
  ], { encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stderr || cli.stdout);
  assert.match(cli.stderr, /PROVIDER_OUTPUT_ASPECT_MISMATCH/);
  const noncompliantPlan = JSON.parse(await readFile(path.join(noncompliantRun, "codex-builtin-invocations.json"), "utf8"));
  const noncompliant = noncompliantPlan.invocations[0];
  assert.equal(noncompliantPlan.status, "noncompliant");
  assert.equal(noncompliantPlan.providerCalls, 0);
  assert.equal(noncompliant.status, "noncompliant");
  assert.equal(noncompliant.providerDirect, true);
  assert.equal(noncompliant.automaticRetry, false);
  assert.deepEqual(noncompliant.dimensions, { width: 1024, height: 1536 });
  assert.deepEqual(await readFile(path.join(noncompliantRun, noncompliant.evidenceFile)), wrongBytes);
  await mustNotExist(path.join(noncompliantRun, "images/01.png"));
  await assert.rejects(
    () => ingestCodexBuiltinResult({ runDir: noncompliantRun, pageId: "page-01", providerOutput: wrongProvider }),
    /NONCOMPLIANT_RETRY_FORBIDDEN/,
  );
  const preservedResult = JSON.parse(await readFile(path.join(noncompliantRun, "result.json"), "utf8"));
  const preservedEval = JSON.parse(await readFile(path.join(noncompliantRun, "eval-report.json"), "utf8"));
  assert.equal(preservedResult.status, "planned");
  assert.equal(preservedEval.status, "fail");
  cases.push("wrong-2x3-exits-nonzero-preserves-evidence-and-locks-no-retry");

  const escapeRun = await createRun({ invocations: [invocation("page-01", "../escaped.png")] });
  const escapeProvider = await providerFile(escapeRun, "valid.png", tinyPng(300, 400, 4));
  await assert.rejects(
    () => ingestCodexBuiltinResult({ runDir: escapeRun, pageId: "page-01", providerOutput: escapeProvider }),
    /RUN_PATH_ESCAPE/,
  );
  await mustNotExist(path.join(path.dirname(escapeRun), "escaped.png"));
  await assert.rejects(
    () => ingestCodexBuiltinResult({ runDir: escapeRun, pageId: "page-01", providerOutput: "relative.png" }),
    /PROVIDER_OUTPUT_NOT_ABSOLUTE/,
  );
  const symlinkRun = await createRun();
  const outside = await mkdtemp(path.join(os.tmpdir(), "codex-builtin-outside-"));
  roots.push(outside);
  await rm(path.join(symlinkRun, "images"), { recursive: true, force: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(outside, path.join(symlinkRun, "images"));
  const symlinkProvider = await providerFile(symlinkRun, "valid.png", tinyPng(300, 400, 5));
  await assert.rejects(
    () => ingestCodexBuiltinResult({ runDir: symlinkRun, pageId: "page-01", providerOutput: symlinkProvider }),
    /SYMLINK_FORBIDDEN|RUN_PATH_ESCAPE/,
  );
  await mustNotExist(path.join(outside, "01.png"));
  cases.push("absolute-provider-and-run-contained-non-symlink-destinations-are-enforced");

  console.log(JSON.stringify({ valid: true, providerCalls: 0, cases }, null, 2));
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
