#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLetteringPlan,
  composePostLayoutPage,
  loadPostLayoutRoute,
  preflightPostLayout,
  validatePostLayoutPlan,
} from "./post-layout.mjs";
import { verifyPostLayoutSourceProvenance } from "./post-layout-source-provenance.mjs";
import { pngMetadata } from "./run-artifacts.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(scriptDir, "..");
const routePath = path.join(skillDir, "references", "routes", "bundled-sharp-post-layout.json");

const input = {
  version: 3,
  output: { aspectRatio: "3:4", textStrategy: "post-layout", quality: "final" },
};

const page = {
  id: "page-01",
  outputFile: "images/01.png",
  requiredText: ["休息，是给继续前进充电。", "先停一下吧！"],
  panels: [
    { id: "panel-01" },
    { id: "panel-02" },
  ],
  textPlacements: [
    {
      id: "slot-01",
      requiredTextIndex: 0,
      text: "休息，是给继续前进充电。",
      panelId: "panel-01",
      kind: "caption",
      tail: "none",
      box: { x: 80, y: 80, width: 520, height: 150 },
    },
    {
      id: "slot-02",
      requiredTextIndex: 1,
      text: "先停一下吧！",
      panelId: "panel-02",
      kind: "speech",
      tail: "right",
      box: { x: 600, y: 600, width: 320, height: 180 },
    },
  ],
};

const plan = {
  version: 3,
  textStrategy: "post-layout",
  compositionFreedom: "director-locked",
  pages: [page],
};

const tempDir = await mkdtemp(path.join(os.tmpdir(), "social-comic-post-layout-"));
try {
  assert.deepEqual(validatePostLayoutPlan({ input, plan }), []);
  const letteringPlan = buildLetteringPlan(plan);
  assert.equal(letteringPlan.pages[0].sourceFile, "source-images/01.png");
  assert.equal(letteringPlan.pages[0].placements.length, 2);

  const route = await loadPostLayoutRoute(routePath);
  const preflight = await preflightPostLayout({ input, plan, route });
  const sharp = preflight._sharp;
  assert.equal(preflight.ok, true);
  assert.equal(preflight.font.sha256, route.fontSha256);
  assert.equal(preflight.pages[0].placementCount, 2);

  const sourcePath = path.join(tempDir, "source-images", "01.png");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await sharp({
    create: { width: 600, height: 800, channels: 4, background: { r: 242, g: 238, b: 226, alpha: 0.7 } },
  }).composite([{
    input: Buffer.from('<svg width="600" height="800" xmlns="http://www.w3.org/2000/svg"><rect x="250" y="300" width="100" height="100" fill="#e07766"/></svg>'),
  }]).png().toFile(sourcePath);

  const before = await pngMetadata(sourcePath);
  await writeFile(`${sourcePath}.json`, JSON.stringify({
    version: 3,
    pageId: page.id,
    outputFile: "source-images/01.png",
    finalOutputFile: page.outputFile,
    directOutput: true,
    operation: "generation",
    references: [],
    outputSha256: before.sha256,
    actualDimensions: { width: before.width, height: before.height },
    callId: "test-run:page:page-01:generation",
    provider: "test",
    model: "test-image",
    pricingModel: "test:image",
  }));
  const sourceProvenance = await verifyPostLayoutSourceProvenance({ runDir: tempDir, page });
  const report = await composePostLayoutPage({ runDir: tempDir, page, route, preflight, sourceProvenance });
  const afterSource = await pngMetadata(sourcePath);
  const final = await pngMetadata(path.join(tempDir, "images", "01.png"));
  assert.deepEqual({ width: final.width, height: final.height }, { width: before.width, height: before.height });
  assert.equal(afterSource.sha256, before.sha256, "source image must remain byte-identical");
  assert.notEqual(final.sha256, before.sha256, "final page must contain a visible lettering overlay");
  assert.equal(report.pixelAudit.outsideDeclaredRegionsUnchanged, true);
  assert.equal(report.pixelAudit.alphaOutsideDeclaredRegionsUnchanged, true);
  assert.ok(report.pixelAudit.changedPixels > 0);
  assert.equal(report.placements[0].text, page.requiredText[0]);
  assert.equal(report.generationProvenance.sourceSha256, before.sha256);
  assert.ok(report.placements.every((placement) => placement.actualTextBounds.width > 0));

  const modelArranged = structuredClone(plan);
  modelArranged.compositionFreedom = "model-arranged";
  assert.ok(validatePostLayoutPlan({ input, plan: modelArranged }).some((error) => error.includes("director-locked")));

  const mismatched = structuredClone(plan);
  mismatched.pages[0].textPlacements[0].text = "被改掉的文字";
  assert.ok(validatePostLayoutPlan({ input, plan: mismatched }).some((error) => error.includes("must exactly equal")));

  const overlapping = structuredClone(plan);
  overlapping.pages[0].textPlacements[1].box = { x: 100, y: 100, width: 320, height: 180 };
  assert.ok(validatePostLayoutPlan({ input, plan: overlapping }).some((error) => error.includes("must not overlap")));

  const tamperedRoutePath = path.join(tempDir, "tampered-route.json");
  const tamperedRoute = JSON.parse(await readFile(routePath, "utf8"));
  tamperedRoute.fontFile = route.fontFile;
  tamperedRoute.fontSha256 = "0".repeat(64);
  await writeFile(tamperedRoutePath, JSON.stringify(tamperedRoute), "utf8");
  const loadedTamperedRoute = await loadPostLayoutRoute(tamperedRoutePath);
  await assert.rejects(
    preflightPostLayout({ input, plan, route: loadedTamperedRoute }),
    (error) => error.code === "POST_LAYOUT_FONT_HASH_MISMATCH",
  );

  console.log(JSON.stringify({
    valid: true,
    cases: [
      "bundled-font-hash-and-glyph-preflight",
      "deterministic-lettering-plan",
      "same-size-source-preserving-composite",
      "outside-box-rgba-unchanged",
      "visible-exact-chinese-text-layer",
      "model-arranged-post-layout-rejected",
      "text-mismatch-rejected",
      "overlapping-boxes-rejected",
      "tampered-font-rejected",
    ],
  }, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
