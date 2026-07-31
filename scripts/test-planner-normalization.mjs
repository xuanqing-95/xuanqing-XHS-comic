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
        expressionRange: "从强颜欢笑、皱眉焦虑，到眼神温柔的微笑。",
        signatureActions: "双手捧杯",
        forbiddenChanges: "不要改变黑色短发和黑色针织衫",
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
  comicPlan: {
    compositionFreedom: "自由构图",
    pages: [
      {
        promptFile: "提示词/第一页.md",
        outputFile: "成图/第一页.png",
        panels: [
          {
            direction: "中景，人物位于画面左侧。",
          },
        ],
      },
    ],
  },
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
assert.deepEqual(normalizedMalformed.characterBible.characters[0].expressionRange, [
  "从强颜欢笑、皱眉焦虑，到眼神温柔的微笑。",
]);
assert.deepEqual(normalizedMalformed.characterBible.characters[0].signatureActions, ["双手捧杯"]);
assert.deepEqual(normalizedMalformed.characterBible.characters[0].forbiddenChanges, [
  "不要改变黑色短发和黑色针织衫",
]);
assert.equal(normalizedMalformed.comicPlan.compositionFreedom, "director-locked");
assert.equal(normalizedMalformed.comicPlan.pages[0].promptFile, "prompts/01.md");
assert.equal(normalizedMalformed.comicPlan.pages[0].outputFile, "images/01.png");
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
  "characterBible.characters[0].expressionRange must be a non-empty string array",
  "comicPlan.compositionFreedom must be model-arranged or director-locked",
  "comicPlan.pages[0].panels[0].direction must be null for model-arranged composition",
  "comicPlan.pages[0].promptFile must be prompts/01.md",
  "comicPlan.pages[0].outputFile must be images/01.png",
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
assert.match(prompt, /expressionRange, signatureActions, forbiddenChanges, and referenceImages must be JSON arrays/);
assert.match(prompt, /compositionFreedom must be exactly "model-arranged" or "director-locked"/);
assert.match(prompt, /If any panel has a non-empty direction, compositionFreedom must be "director-locked"/);
assert.match(prompt, /Page 1 must use promptFile "prompts\/01\.md"/);

const topicInput = structuredClone(storyInput);
topicInput.mode = "topic-to-comic";
topicInput.source.story = null;
const topicStoryWithoutSourceFaithfulness = {
  ...malformedDeterministicFields.story,
  sourceMode: "user-supplied",
};
delete topicStoryWithoutSourceFaithfulness.sourceFaithfulness;
const topicPackage = {
  topicAngles: malformedDeterministicFields.topicAngles,
  story: topicStoryWithoutSourceFaithfulness,
  copywriting: {
    version: 2,
    platform: "错误平台",
  },
  visualLock: malformedDeterministicFields.visualLock,
  comicPlan: {
    version: 2,
    aspectRatio: "错误比例",
    quality: "错误质量",
    textStrategy: "错误文字策略",
    pageCount: 99,
    pages: [{
      panelCount: 99,
      requiredText: ["页面标题"],
      panels: [{
        dialogue: ["小满，明天能替我值班吗？"],
        narration: "她犹豫了一下，打字：好。",
      }],
    }],
  },
};
const normalizedTopic = normalizePlannerPackage(topicPackage, topicInput, styleCatalog);
assert.equal(normalizedTopic.story.sourceMode, "generated");
assert.equal(
  normalizedTopic.story.sourceFaithfulness,
  "围绕用户提供的主题与核心观点「爱自己才是最好的风水」进行原创展开，不改变其表达方向。",
);
assert.deepEqual(
  normalizedTopic.topicAngles,
  topicPackage.topicAngles,
  "topic-led semantic angles must not be overwritten",
);
assert.equal(normalizedTopic.copywriting.version, 3);
assert.equal(normalizedTopic.copywriting.platform, "小红书");
assert.equal(
  normalizedTopic.copywriting.cta,
  "如果这篇条漫对你有启发，欢迎收藏，并在评论区聊聊你的看法。",
);
assert.equal(normalizedTopic.comicPlan.version, 3);
assert.equal(normalizedTopic.comicPlan.aspectRatio, "3:4");
assert.equal(normalizedTopic.comicPlan.quality, "standard");
assert.equal(normalizedTopic.comicPlan.textStrategy, "native");
assert.equal(normalizedTopic.comicPlan.pageCount, 1);
assert.equal(normalizedTopic.comicPlan.pages[0].panelCount, 1);
assert.deepEqual(normalizedTopic.comicPlan.pages[0].requiredText, [
  "页面标题",
  "小满，明天能替我值班吗？",
  "她犹豫了一下，打字：好。",
]);
assert.ok(
  !validatePlannerPackage(normalizedTopic, topicInput, styleCatalog).includes(
    "story.sourceFaithfulness must be a non-empty string",
  ),
  "topic-led source provenance must be compiled from validated input instead of left to planner formatting",
);

const topicPrompt = buildPlannerPrompt(topicInput, styleCatalog);
assert.match(
  topicPrompt,
  /"storySourceFaithfulness": "围绕用户提供的主题与核心观点「爱自己才是最好的风水」进行原创展开，不改变其表达方向。"/,
);
assert.match(
  topicPrompt,
  /"copywritingCtaFallback": "如果这篇条漫对你有启发，欢迎收藏，并在评论区聊聊你的看法。"/,
);
assert.match(
  topicPrompt,
  /runtime merges every panel dialogue and narration string into each page requiredText array/,
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
    "topic-led story source faithfulness",
    "artifact versions",
    "copywriting platform and missing CTA fallback",
    "native requiredText from panel dialogue and narration",
    "character seriesMode",
    "numeric age serialization",
    "character list-shaped fields",
    "composition freedom from panel directions",
    "page prompt and output paths",
    "preset style lock",
  ],
  semanticFieldsStillValidated: ["story.emotionalCurve"],
}, null, 2));
