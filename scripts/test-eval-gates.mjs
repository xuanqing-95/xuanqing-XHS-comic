#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!fixture) {
  console.error("Usage: node scripts/test-eval-gates.mjs <reviewed-run-dir>");
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(scriptDir, "validate-run.mjs");

function validate(runDir) {
  const result = spawnSync(process.execPath, [validator, runDir], { encoding: "utf8" });
  return {
    status: result.status,
    output: JSON.parse(result.stdout),
  };
}

function cloneFixture(label) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `social-comic-${label}-`));
  const runDir = path.join(tempDir, "run");
  fs.cpSync(fixture, runDir, { recursive: true });
  return { tempDir, runDir };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function pngDimensions(file) {
  const bytes = fs.readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function migrateToDirectOutput(runDir) {
  const inputPath = path.join(runDir, "input.json");
  const input = readJson(inputPath);
  delete input.output.exactSize;
  writeJson(inputPath, input);

  const planPath = path.join(runDir, "comic-plan.json");
  const plan = readJson(planPath);
  delete plan.width;
  delete plan.height;
  delete plan.exactSize;
  writeJson(planPath, plan);
  for (const page of plan.pages) {
    const promptPath = path.join(runDir, page.promptFile);
    const prompt = fs.readFileSync(promptPath, "utf8").replace(/\b\d{2,5}\s*[x×]\s*\d{2,5}\b/g, "portrait 3:4");
    fs.writeFileSync(promptPath, prompt);
  }

  const lockPath = path.join(runDir, "visual-lock.json");
  const lock = readJson(lockPath);
  delete lock.output.width;
  delete lock.output.height;
  delete lock.output.exactSize;
  writeJson(lockPath, lock);

  const resultPath = path.join(runDir, "result.json");
  const result = readJson(resultPath);
  delete result.width;
  delete result.height;
  delete result.exactSize;
  result.actualDimensions = result.pages.map((file) => ({ file, ...pngDimensions(path.join(runDir, file)) }));
  writeJson(resultPath, result);

  const reportPath = path.join(runDir, "eval-report.json");
  const report = readJson(reportPath);
  if (report.hardGates.directDimensions) {
    report.hardGates.directOutput = report.hardGates.directDimensions;
    delete report.hardGates.directDimensions;
  }
  writeJson(reportPath, report);
}

const results = [];
const baseline = validate(fixture);
assert.equal(baseline.status, 0, "reviewed fixture must pass before negative tests");
results.push({ case: "baseline", pass: true });

{
  const { tempDir, runDir } = cloneFixture("early-failed-run");
  try {
    for (const name of [
      "topic-angles.json",
      "story.json",
      "character-bible.json",
      "comic-plan.json",
      "visual-lock.json",
      "copywriting.json",
      "eval-report.json",
      "diagnosis.json",
    ]) {
      fs.rmSync(path.join(runDir, name), { force: true });
    }
    fs.rmSync(path.join(runDir, "prompts"), { recursive: true, force: true });
    fs.rmSync(path.join(runDir, "images"), { recursive: true, force: true });
    writeJson(path.join(runDir, "result.json"), {
      version: 3,
      status: "failed",
      stage: "planning",
      error: "Planner provider unavailable before any model call.",
    });
    writeJson(path.join(runDir, "usage.json"), {
      version: 3,
      status: "unavailable",
      reason: "No provider call started.",
    });
    const debugPath = path.join(runDir, "debug.json");
    const debug = readJson(debugPath);
    debug.errors = ["Planner provider unavailable before any model call."];
    writeJson(debugPath, debug);

    const checked = validate(runDir);
    assert.equal(checked.status, 0, `minimal failed run did not validate: ${checked.output.errors.join("; ")}`);
    results.push({ case: "early-failure-needs-no-fake-planning-artifacts", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("failed-generation-preserves-evidence");
  try {
    migrateToDirectOutput(runDir);
    const plan = readJson(path.join(runDir, "comic-plan.json"));
    const firstImage = path.join(runDir, plan.pages[0].outputFile);
    const bytes = fs.readFileSync(firstImage);
    bytes.writeUInt32BE(941, 16);
    bytes.writeUInt32BE(1672, 20);
    fs.writeFileSync(firstImage, bytes);

    const resultPath = path.join(runDir, "result.json");
    const result = readJson(resultPath);
    result.status = "failed";
    result.stage = "generate";
    result.error = "Direct provider output was 941x1672 instead of portrait 3:4.";
    result.actualDimensions = result.pages.map((file) => ({ file, ...pngDimensions(path.join(runDir, file)) }));
    writeJson(resultPath, result);

    const reportPath = path.join(runDir, "eval-report.json");
    const report = readJson(reportPath);
    report.hardGates.directOutput = {
      status: "fail",
      evidence: ["Direct output images/01.png measured 941x1672, not portrait 3:4."],
    };
    report.status = "fail";
    report.humanReviewRequired = true;
    report.issues = ["The provider returned a materially wrong aspect ratio."];
    writeJson(reportPath, report);

    const diagnosisPath = path.join(runDir, "diagnosis.json");
    const diagnosis = readJson(diagnosisPath);
    diagnosis.status = "action-required";
    diagnosis.comparisons[0].outputEval = "fail";
    diagnosis.issues = [{
      issueId: "runtime-size-001",
      evalPath: "hardGates.directOutput",
      faultDomain: "runtime",
      evidence: {
        contract: "portrait 3:4 direct output",
        prompt: plan.pages[0].promptFile,
        output: plan.pages[0].outputFile,
        evalFinding: "Measured 941x1672.",
      },
      responsibleArtifact: plan.pages[0].outputFile,
      recommendedChange: "Fix the provider size execution route before another authorized generation.",
      autoAction: "none",
    }];
    writeJson(diagnosisPath, diagnosis);

    const checked = validate(runDir);
    assert.equal(checked.status, 0, `failed generation evidence did not validate: ${checked.output.errors.join("; ")}`);
    results.push({ case: "failed-generation-preserves-noncompliant-output-evidence", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("aspect-only-size");
  try {
    migrateToDirectOutput(runDir);
    const checked = validate(runDir);
    assert.equal(checked.status, 0, `aspect-only direct output failed: ${checked.output.errors.join("; ")}`);
    results.push({ case: "aspect-only-does-not-invent-exact-pixels", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("invented-prompt-size");
  try {
    migrateToDirectOutput(runDir);
    const plan = readJson(path.join(runDir, "comic-plan.json"));
    fs.appendFileSync(path.join(runDir, plan.pages[0].promptFile), "\nInvented exact size: 1080x1440\n");
    const checked = validate(runDir);
    assert.notEqual(checked.status, 0, "prompt must not invent exact pixels for an aspect-only request");
    assert.ok(checked.output.errors.some((error) => error.includes("must not invent an exact pixel size")));
    results.push({ case: "aspect-only-prompt-cannot-invent-pixels", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("partial-exact-size");
  try {
    migrateToDirectOutput(runDir);
    const inputPath = path.join(runDir, "input.json");
    const input = readJson(inputPath);
    input.output.exactSize = { width: 1080 };
    writeJson(inputPath, input);
    const checked = validate(runDir);
    assert.notEqual(checked.status, 0, "partial exact size must fail validation");
    assert.ok(checked.output.errors.some((error) => error.includes("exactSize.width") && error.includes("exactSize.height")));
    results.push({ case: "exact-size-requires-width-and-height", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("explicit-size-match");
  try {
    migrateToDirectOutput(runDir);
    const resultPath = path.join(runDir, "result.json");
    const result = readJson(resultPath);
    const first = result.actualDimensions[0];
    assert.ok(result.actualDimensions.every((item) => item.width === first.width && item.height === first.height));
    const exactSize = { width: first.width, height: first.height };

    const inputPath = path.join(runDir, "input.json");
    const input = readJson(inputPath);
    input.output.exactSize = exactSize;
    writeJson(inputPath, input);

    const planPath = path.join(runDir, "comic-plan.json");
    const plan = readJson(planPath);
    plan.exactSize = exactSize;
    writeJson(planPath, plan);

    const lockPath = path.join(runDir, "visual-lock.json");
    const lock = readJson(lockPath);
    lock.output.exactSize = exactSize;
    writeJson(lockPath, lock);

    result.exactSize = exactSize;
    writeJson(resultPath, result);
    for (const page of plan.pages) {
      fs.appendFileSync(path.join(runDir, page.promptFile), `\nExact execution size: ${exactSize.width}x${exactSize.height}\n`);
    }

    const checked = validate(runDir);
    assert.equal(checked.status, 0, `explicit matching size failed: ${checked.output.errors.join("; ")}`);
    results.push({ case: "user-requested-exact-size-match", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("explicit-size-mismatch");
  try {
    migrateToDirectOutput(runDir);
    const exactSize = { width: 1080, height: 1440 };
    const inputPath = path.join(runDir, "input.json");
    const input = readJson(inputPath);
    input.output.exactSize = exactSize;
    writeJson(inputPath, input);

    const planPath = path.join(runDir, "comic-plan.json");
    const plan = readJson(planPath);
    plan.exactSize = exactSize;
    writeJson(planPath, plan);

    const lockPath = path.join(runDir, "visual-lock.json");
    const lock = readJson(lockPath);
    lock.output.exactSize = exactSize;
    writeJson(lockPath, lock);

    const resultPath = path.join(runDir, "result.json");
    const result = readJson(resultPath);
    result.exactSize = exactSize;
    writeJson(resultPath, result);
    for (const page of plan.pages) {
      fs.appendFileSync(path.join(runDir, page.promptFile), `\nExact execution size: ${exactSize.width}x${exactSize.height}\n`);
    }

    const checked = validate(runDir);
    assert.notEqual(checked.status, 0, "explicit size mismatch must fail validation");
    assert.ok(checked.output.errors.some((error) => error.includes("user-requested exact size")));
    results.push({ case: "user-requested-exact-size-mismatch", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("external-series-anchor");
  try {
    const inputPath = path.join(runDir, "input.json");
    const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    input.mode = "series-continuation";
    input.visual.referenceImages = [{
      file: "/fixtures/approved-series-anchor.png",
      roles: ["identity", "style", "page-grammar"],
      assetType: "approved-page",
    }];
    fs.writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);

    const debugPath = path.join(runDir, "debug.json");
    const debug = JSON.parse(fs.readFileSync(debugPath, "utf8"));
    debug.contentMode = "series-continuation";
    fs.writeFileSync(debugPath, `${JSON.stringify(debug, null, 2)}\n`);

    const plan = JSON.parse(fs.readFileSync(path.join(runDir, "comic-plan.json"), "utf8"));
    const reportPath = path.join(runDir, "eval-report.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    report.pairwise = plan.pages.map((page) => ({
      referencePageId: "external-series-anchor",
      referenceFile: "/fixtures/approved-series-anchor.png",
      pageId: page.id,
      checks: {characterIdentity: 4, wardrobeAndProps: 4, artStyle: 4, pageGrammar: 4},
      evidence: "Every new page was compared with the approved external anchor.",
    }));
    const scores = [
      ...Object.values(report.content),
      ...report.pages.flatMap((page) => Object.values(page.checks)),
      ...report.pairwise.flatMap((pair) => Object.values(pair.checks)),
      ...Object.values(report.series),
    ];
    report.scoreMean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    const result = validate(runDir);
    assert.equal(result.status, 0, `external series anchor failed: ${result.output.errors.join("; ")}`);
    results.push({ case: "external-series-anchor-compares-every-new-page", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("required-text-contract");
  try {
    const planPath = path.join(runDir, "comic-plan.json");
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    for (const page of plan.pages) {
      if (Array.isArray(page.allowedText)) {
        page.requiredText = page.allowedText;
        delete page.allowedText;
      }
    }
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    const reportPath = path.join(runDir, "eval-report.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    for (const page of report.pages) {
      page.textAudit.observations = ["A harmless environmental digit may exist; required copy remains correct."];
    }
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    const result = validate(runDir);
    assert.equal(result.status, 0, `requiredText contract failed: ${result.output.errors.join("; ")}`);
    results.push({ case: "required-text-is-not-a-whole-image-whitelist", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("duplicate");
  try {
    fs.copyFileSync(path.join(runDir, "images/01.png"), path.join(runDir, "images/02.png"));
    const result = validate(runDir);
    assert.notEqual(result.status, 0, "duplicate page must fail validation");
    assert.ok(result.output.errors.some((error) => error.includes("duplicates another page")));
    results.push({ case: "duplicate-page-hash", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("threshold");
  try {
    const reportPath = path.join(runDir, "eval-report.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    report.threshold = 3;
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const result = validate(runDir);
    assert.notEqual(result.status, 0, "weakened threshold must fail validation");
    assert.ok(result.output.errors.some((error) => error.includes("threshold must remain 3.25")));
    results.push({ case: "fixed-threshold", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("false-reviewed");
  try {
    const reportPath = path.join(runDir, "eval-report.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    report.hardGates.comicPageForm.status = "fail";
    report.status = "fail";
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const result = validate(runDir);
    assert.notEqual(result.status, 0, "reviewed result with failed eval must fail validation");
    assert.ok(result.output.errors.some((error) => error.includes("reviewed result requires eval-report.status pass")));
    results.push({ case: "no-false-reviewed", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ valid: true, results }, null, 2));
