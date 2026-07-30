#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!fixture) {
  console.error("Usage: node scripts/test-content-gates.mjs <valid-run-dir>");
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(scriptDir, "validate-run.mjs");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function validate(runDir) {
  const result = spawnSync(process.execPath, [validator, runDir], { encoding: "utf8" });
  return { status: result.status, output: JSON.parse(result.stdout) };
}

function cloneFixture(label) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `social-comic-content-${label}-`));
  const runDir = path.join(tempDir, "run");
  fs.cpSync(fixture, runDir, { recursive: true });
  return { tempDir, runDir };
}

const results = [];

{
  const { tempDir, runDir } = cloneFixture("real-style-preset");
  try {
    const catalogPath = path.join(scriptDir, "..", "references", "style-presets.json");
    const preset = readJson(catalogPath).presets.find((item) => item.id === "minimalist-doodle-personification");
    assert.ok(preset, "minimalist personification preset must exist");

    const inputPath = path.join(runDir, "input.json");
    const input = readJson(inputPath);
    input.visual = {
      styleMode: "preset",
      preset: preset.id,
      customStyle: null,
      referenceImages: [],
    };
    writeJson(inputPath, input);

    const lockPath = path.join(runDir, "visual-lock.json");
    const lock = readJson(lockPath);
    lock.style = { presetId: preset.id, ...preset.lock };
    writeJson(lockPath, lock);

    const plan = readJson(path.join(runDir, "comic-plan.json"));
    for (const page of plan.pages) {
      const promptPath = path.join(runDir, page.promptFile);
      const presetText = Object.values(preset.lock).flatMap((value) => Array.isArray(value) ? value : [value]).join("\n");
      fs.appendFileSync(promptPath, `\nPRESET LOCK\n${presetText}\n`);
    }

    const checked = validate(runDir);
    assert.equal(checked.status, 0, `real style preset failed: ${checked.output.errors.join("; ")}`);
    results.push({ case: "real-style-preset-expands-to-full-lock", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("unknown-style-preset");
  try {
    const inputPath = path.join(runDir, "input.json");
    const input = readJson(inputPath);
    input.visual = {styleMode: "preset", preset: "not-a-real-preset", customStyle: null, referenceImages: []};
    writeJson(inputPath, input);
    const checked = validate(runDir);
    assert.notEqual(checked.status, 0);
    assert.ok(checked.output.errors.some((error) => error.includes("input.visual.preset is unknown")));
    results.push({ case: "unknown-style-preset-is-rejected", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("preset-lock-drift");
  try {
    const catalogPath = path.join(scriptDir, "..", "references", "style-presets.json");
    const preset = readJson(catalogPath).presets.find((item) => item.id === "minimalist-doodle-personification");
    const inputPath = path.join(runDir, "input.json");
    const input = readJson(inputPath);
    input.visual = {styleMode: "preset", preset: preset.id, customStyle: null, referenceImages: []};
    writeJson(inputPath, input);
    const lockPath = path.join(runDir, "visual-lock.json");
    const lock = readJson(lockPath);
    lock.style = {presetId: preset.id, ...preset.lock, line: "generic clean line"};
    writeJson(lockPath, lock);
    const checked = validate(runDir);
    assert.notEqual(checked.status, 0);
    assert.ok(checked.output.errors.some((error) => error.includes("visual-lock.style.line must match preset")));
    results.push({ case: "preset-lock-drift-is-rejected", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("user-fixed-panel-count");
  try {
    const inputPath = path.join(runDir, "input.json");
    const input = readJson(inputPath);
    input.layout = {countMode: "user-fixed", totalPanelCount: 999, preferredPanelsPerPage: null};
    writeJson(inputPath, input);
    const checked = validate(runDir);
    assert.notEqual(checked.status, 0);
    assert.ok(checked.output.errors.some((error) => error.includes("must equal input.layout.totalPanelCount")));
    results.push({ case: "user-fixed-panel-count-is-enforced", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("story-route");
  try {
    const inputPath = path.join(runDir, "input.json");
    const input = readJson(inputPath);
    input.mode = "story-to-comic";
    input.source.topic = null;
    input.source.story = "早晨妈妈不断催促，孩子越来越乱；妈妈停下来听孩子说完，再改成一次一个步骤。";
    writeJson(inputPath, input);

    const anglesPath = path.join(runDir, "topic-angles.json");
    const angles = readJson(anglesPath);
    angles.status = "skipped";
    angles.angles = [];
    angles.selectedAngleId = null;
    angles.selectionReason = null;
    angles.skipReason = "用户已经提供可直接改编的完整剧情。";
    writeJson(anglesPath, angles);

    const storyPath = path.join(runDir, "story.json");
    const story = readJson(storyPath);
    story.sourceMode = "user-supplied";
    story.sourceFaithfulness = "保留用户给出的冲突、转折和解决顺序，只压缩对白。";
    writeJson(storyPath, story);

    const debugPath = path.join(runDir, "debug.json");
    const debug = readJson(debugPath);
    debug.contentMode = "story-to-comic";
    writeJson(debugPath, debug);

    const checked = validate(runDir);
    assert.equal(checked.status, 0, `valid story-to-comic route failed: ${checked.output.errors.join("; ")}`);
    results.push({ case: "story-route-skips-angle-invention", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("missing-angles");
  try {
    const inputPath = path.join(runDir, "input.json");
    const input = readJson(inputPath);
    input.mode = "topic-to-comic";
    input.source.topic = input.source.topic || "测试主题";
    input.source.story = null;
    input.source.draft = null;
    writeJson(inputPath, input);

    const debugPath = path.join(runDir, "debug.json");
    const debug = readJson(debugPath);
    debug.contentMode = "topic-to-comic";
    writeJson(debugPath, debug);

    const anglesPath = path.join(runDir, "topic-angles.json");
    const angles = readJson(anglesPath);
    angles.status = "skipped";
    angles.angles = [];
    angles.selectedAngleId = null;
    angles.skipReason = "incorrect skip";
    writeJson(anglesPath, angles);
    const checked = validate(runDir);
    assert.notEqual(checked.status, 0);
    assert.ok(checked.output.errors.some((error) => error.includes("topic-based input requires generated topic angles")));
    results.push({ case: "topic-route-requires-angles", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("locked-direction");
  try {
    const planPath = path.join(runDir, "comic-plan.json");
    const plan = readJson(planPath);
    plan.compositionFreedom = "director-locked";
    plan.compositionReason = "Test strict direction.";
    writeJson(planPath, plan);
    const checked = validate(runDir);
    assert.notEqual(checked.status, 0);
    assert.ok(checked.output.errors.some((error) => error.includes(".direction must be a non-empty string")));
    results.push({ case: "director-locked-requires-directions", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const { tempDir, runDir } = cloneFixture("copy-count");
  try {
    const copyPath = path.join(runDir, "copywriting.json");
    const copy = readJson(copyPath);
    copy.titleCandidates = copy.titleCandidates.slice(0, 2);
    writeJson(copyPath, copy);
    const checked = validate(runDir);
    assert.notEqual(checked.status, 0);
    assert.ok(checked.output.errors.some((error) => error.includes("copywriting.titleCandidates must contain exactly 5 items")));
    results.push({ case: "publishing-package-counts", pass: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ valid: true, results }, null, 2));
