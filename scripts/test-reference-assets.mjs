#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  collectReferenceAssets,
  normalizeReferenceAsset,
  selectContinuityAnchorAsset,
  validateReferenceAssets,
} from "./reference-assets.mjs";
import { compilePagePrompts } from "./compile-prompts.mjs";

const input = {
  version: 3,
  mode: "series-continuation",
  visual: {
    styleMode: "reference",
    referenceImages: [
      { file: "/refs/style.png", roles: ["style", "page-grammar"], assetType: "style-reference" },
      { file: "/refs/approved-page.png", assetType: "approved-page" },
    ],
  },
  series: {
    enabled: true,
    continuityAnchorFile: "/refs/approved-page.png",
    characterAnchorFiles: [{
      file: "/refs/xiaoqing-three-view.png",
      assetType: "three-view",
      characterIds: ["xiaoqing"],
      views: ["front", "side", "back", "expression"],
    }],
    styleAnchorFiles: ["/refs/style.png"],
  },
  output: { aspectRatio: "3:4", textStrategy: "native", quality: "final" },
};

const characterBible = {
  version: 3,
  seriesMode: true,
  characters: [{
    id: "xiaoqing",
    role: "主角",
    immutable: {
      age: "年轻人",
      face: "圆脸",
      hair: "短黑发",
      body: "简洁比例",
      outfit: "蓝色外套",
    },
    forbiddenChanges: [],
    referenceImages: [{
      file: "/refs/xiaoqing-three-view.png",
      assetType: "three-view",
      views: ["front", "side", "back", "expression"],
    }],
  }],
  seriesAssets: { characterSheetFiles: [], styleAnchorFiles: [] },
};

const visualLock = {
  version: 3,
  lockId: "reference-test",
  style: {
    presetId: "reference",
    medium: "hand-drawn comic",
    line: "black ink",
    palette: ["blue", "white"],
    lighting: "flat",
    background: "minimal",
    pageGrammar: "clear panels",
    characterDesign: "simple shapes",
    typography: "legible Chinese",
    avoid: ["photorealism"],
  },
  characters: [{ id: "xiaoqing", immutable: characterBible.characters[0].immutable }],
  output: input.output,
  referenceImages: [
    { file: "/refs/style.png", roles: ["style", "page-grammar"], assetType: "style-reference" },
    { file: "/refs/approved-page.png", assetType: "approved-page" },
    {
      file: "/refs/xiaoqing-three-view.png",
      roles: ["identity"],
      assetType: "three-view",
      characterIds: ["xiaoqing"],
      views: ["front", "side", "back", "expression"],
    },
  ],
};

const assets = collectReferenceAssets({ input, visualLock, characterBible });
assert.deepEqual(assets.map((asset) => asset.file), [
  "/refs/style.png",
  "/refs/approved-page.png",
  "/refs/xiaoqing-three-view.png",
]);
assert.deepEqual(assets[0].roles, ["style", "page-grammar"]);
assert.deepEqual(assets[2].roles, ["identity"]);
assert.deepEqual(assets[2].characterIds, ["xiaoqing"]);
assert.deepEqual(assets[2].views, ["front", "side", "back", "expression"]);
assert.equal(selectContinuityAnchorAsset({ input, visualLock, characterBible })?.file, "/refs/approved-page.png");
assert.deepEqual(validateReferenceAssets({ input, visualLock, characterBible }), []);

const plainCharacterReference = normalizeReferenceAsset("/refs/plain.png", {
  roles: ["identity"],
  assetType: "character-reference",
});
assert.deepEqual(plainCharacterReference.views, []);

const provenanceReference = normalizeReferenceAsset({
  file: "reference-assets/01-owned.png",
  assetId: "owned-asset-1",
  roles: ["identity"],
  continuityAnchor: true,
  provenance: { source: "image_assets", ownerVerified: true, contentSha256: "abc" },
});
assert.equal(provenanceReference.assetId, "owned-asset-1");
assert.equal(provenanceReference.continuityAnchor, true);
assert.equal(provenanceReference.provenance.ownerVerified, true);

const incompleteThreeViewInput = structuredClone(input);
incompleteThreeViewInput.series.characterAnchorFiles[0].views = ["front", "side"];
const missingViewErrors = validateReferenceAssets({
  input: incompleteThreeViewInput,
  visualLock,
  characterBible,
});
assert.ok(missingViewErrors.some((error) => error.includes("missing view: back")));

const noForcedSheetInput = structuredClone(input);
noForcedSheetInput.series.characterAnchorFiles = ["/refs/plain.png"];
noForcedSheetInput.series.continuityAnchorFile = "/refs/plain.png";
const noForcedSheetLock = structuredClone(visualLock);
noForcedSheetLock.referenceImages.push({ file: "/refs/plain.png", roles: ["identity"] });
assert.deepEqual(validateReferenceAssets({
  input: noForcedSheetInput,
  visualLock: noForcedSheetLock,
  characterBible,
}), []);

const internalOnlyLock = structuredClone(visualLock);
internalOnlyLock.referenceImages = ["images/01.png"];
assert.deepEqual(collectReferenceAssets({
  input: { ...input, visual: { ...input.visual, referenceImages: [] }, series: { enabled: false, characterAnchorFiles: [], styleAnchorFiles: [] } },
  visualLock: internalOnlyLock,
  characterBible: { ...characterBible, characters: characterBible.characters.map((character) => ({ ...character, referenceImages: [] })), seriesAssets: { characterSheetFiles: [], styleAnchorFiles: [] } },
}), []);

const plan = {
  version: 3,
  title: "参考图测试",
  coreMessage: "参考图语义必须与附件顺序一致",
  compositionFreedom: "model-arranged",
  compositionReason: "让模型安排自然分镜",
  pageCount: 1,
  countReason: "一个页面足够",
  aspectRatio: "3:4",
  quality: "final",
  textStrategy: "native",
  generationStrategy: "reference-parallel",
  pages: [{
    id: "page-01",
    purpose: "测试",
    change: "角色看向参考图",
    scene: "白底",
    panelCount: 1,
    panels: [{
      id: "page-01-panel-01",
      change: "角色出现",
      action: "角色挥手",
      emotion: "自然",
      dialogue: ["你好"],
      direction: null,
    }],
    requiredText: ["你好"],
    promptFile: "prompts/01.md",
    outputFile: "images/01.png",
  }],
};

const [compiled] = compilePagePrompts({ input, plan, visualLock, characterBible });
const firstIndex = compiled.content.indexOf("Reference image 1");
const secondIndex = compiled.content.indexOf("Reference image 2");
const thirdIndex = compiled.content.indexOf("Reference image 3");
assert.ok(firstIndex >= 0 && firstIndex < secondIndex && secondIndex < thirdIndex);
assert.match(compiled.content, /Reference image 1 .*\/refs\/style\.png.*roles: style, page-grammar/);
assert.match(compiled.content, /Reference image 3 .*assetType: three-view.*characterIds: xiaoqing.*views: front, side, back, expression/);

const anchorPlan = structuredClone(plan);
anchorPlan.generationStrategy = "anchor-first-fanout";
anchorPlan.pages.push({
  ...structuredClone(anchorPlan.pages[0]),
  id: "page-02",
  promptFile: "prompts/02.md",
  outputFile: "images/02.png",
});
anchorPlan.pageCount = 2;
const anchorPrompts = compilePagePrompts({ input, plan: anchorPlan, visualLock, characterBible });
assert.match(anchorPrompts[1].content, /Reference image 4 .*images\/01\.png.*generated-page-anchor/);

console.log(JSON.stringify({
  valid: true,
  cases: [
    "first-seen-order-and-metadata-merge",
    "explicit-continuity-anchor",
    "three-view-requires-front-side-back-only-when-declared",
    "plain-character-reference-does-not-require-three-view",
    "derived-internal-page-is-not-an-external-attachment",
    "compiled-reference-image-numbering-matches-attachment-order",
    "generated-page-anchor-follows-external-reference-numbering",
  ],
}, null, 2));
