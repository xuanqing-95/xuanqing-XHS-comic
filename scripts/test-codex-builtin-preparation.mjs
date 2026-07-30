#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compilePagePrompts } from "./compile-prompts.mjs";
import {
  ASPECT_CANVAS,
  createAspectOnlyBlankPng,
  prepareCodexBuiltinRun,
} from "./prepare-codex-builtin.mjs";

const EXPECTED_BLANK_SHA256 = "122d6dbb1cc5a3b204f889ffc8b2c9ebbfd3b65abca5d1f67102e1944546f7cc";
const roots = [];
const cases = [];

async function writeJson(root, file, value) {
  await writeFile(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

function characterBible() {
  const immutable = {
    age: "adult",
    face: "round face",
    hair: "short dark hair",
    body: "natural adult proportions",
    outfit: "blue shirt and brown trousers",
  };
  return {
    version: 3,
    seriesMode: false,
    characters: [{
      id: "char-user",
      role: "user",
      immutable,
      expressionRange: ["focused"],
      forbiddenChanges: [],
      referenceImages: [],
    }],
    relationships: [],
    seriesAssets: { characterSheetFiles: [], styleAnchorFiles: [], columnName: null },
  };
}

function visualLock(bible, refs) {
  return {
    version: 3,
    lockId: "codex-preparation-test",
    sourceCharacterBible: "character-bible.json",
    style: {
      presetId: refs.length > 0 ? "reference" : "custom",
      medium: "flat comic",
      line: "dark ink",
      palette: ["cream", "blue"],
      lighting: "flat",
      background: "simple",
      pageGrammar: "clear panels",
      characterDesign: "natural adult proportions",
      typography: "legible Chinese",
      avoid: ["photorealism"],
    },
    characters: bible.characters.map((character) => ({ id: character.id, immutable: character.immutable })),
    output: { aspectRatio: "3:4", textStrategy: "native" },
    referenceImages: refs,
  };
}

function comicPlan(strategy) {
  const pages = [1, 2].map((number) => ({
    id: `page-${String(number).padStart(2, "0")}`,
    purpose: `purpose ${number}`,
    change: `change ${number}`,
    scene: "desk",
    panelCount: 1,
    panels: [{
      id: `page-${String(number).padStart(2, "0")}-panel-01`,
      change: `beat ${number}`,
      action: "user points at a note",
      emotion: "focused",
      dialogue: [`第${number}页`],
      direction: null,
    }],
    requiredText: [`第${number}页`],
    promptFile: `prompts/${String(number).padStart(2, "0")}.md`,
    outputFile: `images/${String(number).padStart(2, "0")}.png`,
  }));
  return {
    version: 3,
    title: "test",
    coreMessage: "test",
    compositionFreedom: "model-arranged",
    compositionReason: "test",
    pageCount: 2,
    countReason: "two pages",
    aspectRatio: "3:4",
    quality: "final",
    textStrategy: "native",
    generationStrategy: strategy,
    pages,
  };
}

async function createRun({ strategy = "anchor-first-fanout", refs = [], exactSize } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-builtin-preparation-"));
  roots.push(root);
  await mkdir(path.join(root, "prompts"));
  const input = {
    version: 3,
    mode: "topic-to-comic",
    visual: { styleMode: refs.length > 0 ? "reference" : "custom", referenceImages: refs },
    output: { aspectRatio: "3:4", textStrategy: "native", quality: "final", ...(exactSize ? { exactSize } : {}) },
    series: { enabled: false, characterAnchorFiles: [], styleAnchorFiles: [] },
  };
  const bible = characterBible();
  const lock = visualLock(bible, refs);
  const plan = comicPlan(strategy);
  await Promise.all([
    writeJson(root, "input.json", input),
    writeJson(root, "comic-plan.json", plan),
    writeJson(root, "visual-lock.json", lock),
    writeJson(root, "character-bible.json", bible),
  ]);
  for (const prompt of compilePagePrompts({ input, plan, visualLock: lock, characterBible: bible })) {
    await writeFile(path.join(root, prompt.file), prompt.content);
  }
  return root;
}

try {
  const blank = createAspectOnlyBlankPng();
  assert.equal(blank.readUInt32BE(16), ASPECT_CANVAS.width);
  assert.equal(blank.readUInt32BE(20), ASPECT_CANVAS.height);
  assert.equal(crypto.createHash("sha256").update(blank).digest("hex"), EXPECTED_BLANK_SHA256);
  assert.deepEqual(blank, createAspectOnlyBlankPng());
  cases.push("deterministic-1080x1440-png-and-hash");

  const anchorRun = await createRun();
  const anchorPlan = await prepareCodexBuiltinRun(anchorRun);
  assert.equal(anchorPlan.providerCalls, 0);
  assert.equal(anchorPlan.canvasReference.sha256, EXPECTED_BLANK_SHA256);
  const writtenBlank = await readFile(path.join(anchorRun, ASPECT_CANVAS.file));
  assert.equal(crypto.createHash("sha256").update(writtenBlank).digest("hex"), EXPECTED_BLANK_SHA256);
  assert.equal(writtenBlank.readUInt32BE(16), 1080);
  assert.equal(writtenBlank.readUInt32BE(20), 1440);
  assert.deepEqual(anchorPlan.executionPhases, [
    { phase: 1, pageIds: ["page-01"] },
    { phase: 2, pageIds: ["page-02"] },
  ]);
  assert.deepEqual(anchorPlan.invocations[0].attachments.map((item) => item.file), [ASPECT_CANVAS.file]);
  assert.deepEqual(anchorPlan.invocations[1].attachments.map((item) => item.file), [
    "images/01.png",
    ASPECT_CANVAS.file,
  ]);
  assert.deepEqual(anchorPlan.invocations[1].dependsOn, ["page-01"]);
  const anchorDerived = await readFile(path.join(anchorRun, "codex-prompts/01.md"), "utf8");
  assert.doesNotMatch(anchorDerived, /No external reference image is attached/);
  assert.match(anchorDerived, /controls only the portrait 3:4 canvas aspect/);
  const anchorDerivedTwo = await readFile(path.join(anchorRun, "codex-prompts/02.md"), "utf8");
  assert.match(anchorDerivedTwo, /Reference image 2 .*aspect-only-blank-canvas/);
  cases.push("anchor-first-keeps-canvas-on-every-page-and-adds-generated-anchor");

  const styleRun = await createRun({ strategy: "style-lock-parallel" });
  const stylePlan = await prepareCodexBuiltinRun(styleRun);
  assert.deepEqual(stylePlan.executionPhases, [{ phase: 1, pageIds: ["page-01", "page-02"] }]);
  assert.ok(stylePlan.invocations.every((item) => item.attachments.at(-1).file === ASPECT_CANVAS.file));
  assert.ok(stylePlan.invocations.every((item) => item.dependsOn.length === 0));
  cases.push("no-generated-anchor-attaches-canvas-to-every-page");

  const refs = [
    { file: "/refs/identity.png", roles: ["identity"], assetType: "character-reference" },
    { file: "/refs/style.png", roles: ["style", "page-grammar"], assetType: "style-reference" },
  ];
  const referenceRun = await createRun({ refs });
  const referencePlan = await prepareCodexBuiltinRun(referenceRun);
  assert.deepEqual(referencePlan.invocations[0].attachments.map((item) => item.file), [
    "/refs/identity.png",
    "/refs/style.png",
    ASPECT_CANVAS.file,
  ]);
  assert.deepEqual(referencePlan.invocations[1].attachments.map((item) => item.file), [
    "/refs/identity.png",
    "/refs/style.png",
    "images/01.png",
    ASPECT_CANVAS.file,
  ]);
  cases.push("user-reference-order-preserved-and-canvas-last");

  const derivedOne = await readFile(path.join(referenceRun, "codex-prompts/01.md"), "utf8");
  const derivedTwo = await readFile(path.join(referenceRun, "codex-prompts/02.md"), "utf8");
  assert.doesNotMatch(derivedOne, /No external reference image is attached/);
  assert.doesNotMatch(derivedTwo, /No external reference image is attached/);
  assert.match(derivedOne, /controls only the portrait 3:4 canvas aspect/);
  assert.match(derivedOne, /Reference image 3 .*aspect-only-blank-canvas/);
  assert.match(derivedTwo, /Reference image 4 .*aspect-only-blank-canvas/);
  cases.push("derived-prompts-remove-reference-contradiction");

  const exactRun = await createRun({ exactSize: { width: 1080, height: 1440 } });
  await assert.rejects(
    () => prepareCodexBuiltinRun(exactRun),
    /CODEX_BUILTIN_EXACT_SIZE_UNSUPPORTED/,
  );
  await assert.rejects(() => access(path.join(exactRun, "codex-builtin-invocations.json")));
  cases.push("exact-size-fails-closed-before-preparation");

  assert.ok(anchorPlan.invocations.every((item) => item.guardrails.automaticRetry === false));
  assert.ok(anchorPlan.invocations.every((item) => item.validation.measureReturnedPngImmediately === true));
  assert.ok(anchorPlan.invocations.every((item) => item.guardrails.prohibitedPostProcessing.join(",") === "crop,resize,pad,stretch,stitch"));
  cases.push("zero-provider-calls-and-strict-output-guardrails");

  console.log(JSON.stringify({ valid: true, providerCalls: 0, cases }, null, 2));
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
