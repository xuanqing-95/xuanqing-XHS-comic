#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validatePlannerPackage } from "./compile-prompts.mjs";
import { buildPlannerPrompt, normalizePlannerPackage } from "./run-plan-stage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styleCatalog = JSON.parse(await readFile(path.join(root, "references", "style-presets.json"), "utf8"));
const preset = styleCatalog.presets.find((entry) => entry.id === "black-white-screentone-manga");
assert.ok(preset);

const storyInput = {
  version: 3,
  mode: "story-to-comic",
  source: {
    topic: "爱自己才是最好的风水",
    story: "爱自己才是最好的风水",
    draft: null,
  },
  domain: "情绪心理学",
  audience: "希望学会自我关怀的年轻人",
  coreMessage: "爱自己才是最好的风水",
  tone: "温暖、共鸣",
  platform: "小红书",
  language: "zh-CN",
  ctaGoal: "收藏与讨论",
  visual: {
    styleMode: "preset",
    preset: preset.id,
    customStyle: null,
    referenceImages: [],
  },
  layout: {
    countMode: "auto",
    totalPanelCount: null,
    preferredPanelsPerPage: null,
  },
  output: {
    aspectRatio: "3:4",
    textStrategy: "native",
    quality: "standard",
    pageCountCeiling: null,
  },
  series: {
    enabled: false,
    characterAnchorFiles: [],
    styleAnchorFiles: [],
  },
};

const malformedDeterministicFields = {
  topicAngles: {
    version: 3,
    status: "generated",
    angles: [{ id: "wrong" }],
    selectedAngleId: "wrong",
    selectionReason: "错误地生成了角度",
    skipReason: null,
  },
  story: {
    version: 3,
    sourceMode: "generated",
    title: "爱自己才是最好的风水",
    logline: "一个人开始认真照顾自己。",
    coreMessage: storyInput.coreMessage,
    summary: storyInput.source.story,
    structure: {
      hook: "她总把自己放在最后",
      escalation: "疲惫逐渐累积",
      turn: "她第一次停下来听见自己的需要",
      resolution: "她开始照顾自己的感受",
      endingHook: "爱自己，生活才慢慢顺起来",
    },
    claims: [],
    sourceFaithfulness: "保留用户原句，并把它展开成可视化剧情。",
  },
  characterBible: {
    version: 3,
    seriesMode: true,
    characters: [
      {
        id: "char-01",
        role: "主角",
        personality: ["逐渐学会自我关怀"],
        immutable: {
          age: 30,
          face: "圆脸",
          hair: "黑色短发",
          body: "成年女性比例",
          outfit: "黑色针织衫",
          signatureColors: ["black", "white"],
          recurringProps: ["马克杯"],
        },
        expressionRange: ["疲惫", "释然"],
        signatureActions: ["双手捧杯"],
        forbiddenChanges: [],
        referenceImages: [],
      },
    ],
    relationships: [],
    seriesAssets: {
      characterSheetFiles: [],
      styleAnchorFiles: [],
      columnName: null,
    },
  },
  comicPlan: {},
  visualLock: {
    version: 3,
    style: {
      medium: "black-and-white manga with screentone shading",
    },
  },
  copywriting: {},
};

const normalizedMalformed = normalizePlannerPackage(
  malformedDeterministicFields,
  storyInput,
  styleCatalog,
);

assert.deepEqual(normalizedMalformed.topicAngles, {
  version: 3,
  status: "skipped",
  angles: [],
  selectedAngleId: null,
  selectionReason: null,
  skipReason: "用户已提供可直接改编的故事，因此跳过传播角度生成。",
});
assert.equal(normalizedMalformed.story.sourceMode, "user-supplied");
assert.equal(normalizedMalformed.characterBible.seriesMode, false);
assert.equal(normalizedMalformed.characterBible.characters[0].immutable.age, "30");
assert.deepEqual(normalizedMalformed.visualLock.style, {
  presetId: preset.id,
  ...preset.lock,
});

const malformedErrors = validatePlannerPackage(normalizedMalformed, storyInput, styleCatalog);
for (const resolvedError of [
  "topicAngles.angles must be empty when angle planning is skipped",
  "topicAngles.selectedAngleId must be null when skipped",
  "topicAngles.skipReason must be a non-empty string",
  "story.sourceMode must be user-supplied for input.mode story-to-comic",
  "characterBible.seriesMode must match the series input",
  "characterBible.characters[0].immutable.age must be a non-empty string or string array",
  "visualLock.style.presetId must be a non-empty string",
  "visualLock.style.presetId must match input.visual.preset",
]) {
  assert.ok(!malformedErrors.includes(resolvedError), `normalization should resolve: ${resolvedError}`);
}
assert.ok(
  malformedErrors.includes("story.emotionalCurve must be a non-empty string array"),
  "semantic emotionalCurve must not be fabricated by deterministic normalization",
);

const prompt = buildPlannerPrompt(storyInput, styleCatalog);
assert.match(prompt, /INPUT-DETERMINED CONTRACT FACTS/);
assert.match(prompt, /"storySourceMode": "user-supplied"/);
assert.match(prompt, /"seriesMode": false/);
assert.match(prompt, /"presetId": "black-white-screentone-manga"/);
assert.match(prompt, /emotionalCurve must be an array containing at least two non-empty, story-specific emotional states/);
assert.match(prompt, /never omit it, return an empty array, or use generic placeholder values/);
assert.match(prompt, /Write age as a descriptive string/);
assert.match(prompt, /never as a JSON number/);

const topicInput = structuredClone(storyInput);
topicInput.mode = "topic-to-comic";
topicInput.source.story = null;
const topicPackage = {
  topicAngles: malformedDeterministicFields.topicAngles,
  story: { ...malformedDeterministicFields.story, sourceMode: "user-supplied" },
  visualLock: malformedDeterministicFields.visualLock,
};
const normalizedTopic = normalizePlannerPackage(topicPackage, topicInput, styleCatalog);
assert.equal(normalizedTopic.story.sourceMode, "generated");
assert.deepEqual(
  normalizedTopic.topicAngles,
  topicPackage.topicAngles,
  "topic-led semantic angles must not be overwritten",
);

const customInput = structuredClone(storyInput);
customInput.visual = {
  styleMode: "custom",
  preset: null,
  customStyle: "蓝色铅笔速写",
  referenceImages: [],
};
const customStyle = {
  presetId: "custom",
  medium: "blue-pencil sketch comic",
};
const normalizedCustom = normalizePlannerPackage(
  { visualLock: { style: customStyle } },
  customInput,
  styleCatalog,
);
assert.deepEqual(normalizedCustom.visualLock.style, customStyle, "custom styles must remain planner-authored");

console.log(JSON.stringify({
  valid: true,
  deterministicCorrections: [
    "supplied-story topicAngles",
    "story sourceMode",
    "character seriesMode",
    "numeric age serialization",
    "preset style lock",
  ],
  semanticFieldsStillValidated: ["story.emotionalCurve"],
}, null, 2));
