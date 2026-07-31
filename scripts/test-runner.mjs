#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(scriptDir, "..");
const runScript = path.join(scriptDir, "run.mjs");
const validator = path.join(scriptDir, "validate-run.mjs");
const unsupportedImageRoute = path.join(skillDir, "references", "routes", "codex-builtin-imagegen-uncontrolled.json");
const styleCatalog = JSON.parse(await readFile(path.join(skillDir, "references", "style-presets.json"), "utf8"));
const preset = styleCatalog.presets.find((item) => item.id === "minimalist-doodle-personification");
assert.ok(preset, "minimalist-doodle-personification preset is required");

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

const input = {
  version: 3,
  mode: "story-to-comic",
  source: {
    topic: "休息不是偷懒",
    story: "电量见底的手机还想硬撑，充电器提醒它先补充能量。手机最后理解休息也是继续前进的一部分。",
    draft: null,
  },
  domain: "情绪心理学",
  audience: "疲惫却不敢休息的年轻人",
  coreMessage: "能量见底时，休息是在为继续行动补充能力。",
  tone: "轻松、温柔、冷幽默",
  platform: "小红书",
  language: "zh-CN",
  ctaGoal: "收藏与共鸣",
  visual: {
    styleMode: "preset",
    preset: preset.id,
    customStyle: null,
    referenceImages: [],
  },
  layout: {
    countMode: "user-fixed",
    totalPanelCount: 4,
    preferredPanelsPerPage: 2,
  },
  output: {
    aspectRatio: "3:4",
    textStrategy: "native",
    quality: "final",
    pageCountCeiling: null,
  },
  series: {
    enabled: false,
    characterAnchorFiles: [],
    styleAnchorFiles: [],
  },
};

const character = {
  id: "char-phone",
  role: "疲惫但逞强的手机",
  personality: ["认真", "容易硬撑"],
  immutable: {
    age: "年轻成年人的拟人年龄感",
    face: "屏幕中央两个黑点眼睛和一条短嘴",
    hair: "没有头发，顶部固定一枚低电量图标",
    body: "淡桃色圆角长方形手机身体，细线手脚",
    outfit: "无衣服，固定淡桃色机身与白色屏幕",
    signatureColors: ["淡桃色", "白色", "黑色"],
    recurringProps: ["低电量图标", "白色充电线"],
  },
  expressionRange: ["疲惫", "焦虑", "放松"],
  signatureActions: ["弯腰硬撑", "接上充电线"],
  forbiddenChanges: ["变成人类", "改变机身颜色", "写实产品渲染"],
  referenceImages: [],
};

const plannerPackage = {
  topicAngles: {
    version: 3,
    status: "skipped",
    angles: [],
    selectedAngleId: null,
    selectionReason: null,
    skipReason: "用户提供了完整故事，保留原剧情。",
  },
  story: {
    version: 3,
    sourceMode: "user-supplied",
    title: "休息，是给继续前进充电",
    logline: "一部低电量手机在充电器的提醒下，学会允许自己停下来。",
    coreMessage: input.coreMessage,
    summary: input.source.story,
    structure: {
      hook: "手机电量见底仍在硬撑",
      escalation: "它担心一停下来就会落后",
      turn: "充电器让它看见能量已经见底",
      resolution: "手机接上充电线",
      endingHook: "休息，是给继续前进充电",
    },
    emotionalCurve: ["疲惫", "焦虑", "被理解", "放松"],
    claims: [],
    sourceFaithfulness: "保留用户的拟人隐喻、冲突和核心观点，只做分页。",
  },
  characterBible: {
    version: 3,
    seriesMode: false,
    characters: [character],
    relationships: [],
    seriesAssets: { characterSheetFiles: [], styleAnchorFiles: [], columnName: null },
  },
  comicPlan: {
    version: 3,
    title: "休息，是给继续前进充电",
    coreMessage: input.coreMessage,
    compositionFreedom: "model-arranged",
    compositionReason: "锁定四个剧情变化与文字，让图像模型自由安排每页两格的镜头。",
    pageCount: 2,
    countReason: "前页建立硬撑和担心，后页完成提醒与理解；四个变化分成两张可读页面。",
    aspectRatio: "3:4",
    quality: "final",
    textStrategy: "native",
    generationStrategy: "anchor-first-fanout",
    pages: [
      {
        id: "page-01",
        purpose: "建立疲惫与不敢停下的冲突",
        change: "手机从硬撑到说出担心",
        scene: "极简白底与淡黄色地面色块",
        panelCount: 2,
        panels: [
          { id: "page-01-panel-01", change: "电量见底", action: "手机弯腰仍向前走", emotion: "疲惫", dialogue: ["我再撑一下。"], direction: null },
          { id: "page-01-panel-02", change: "说出担心", action: "手机避开充电线", emotion: "焦虑", dialogue: ["停下来，会落后。"], direction: null },
        ],
        requiredText: ["我再撑一下。", "停下来，会落后。"],
        promptFile: "prompts/01.md",
        outputFile: "images/01.png",
      },
      {
        id: "page-02",
        purpose: "完成提醒与理解",
        change: "手机接受充电并放松",
        scene: "延续极简白底与淡黄色地面色块",
        panelCount: 2,
        panels: [
          { id: "page-02-panel-01", change: "充电器提醒", action: "充电线指向 1% 电量", emotion: "温和", dialogue: ["先充会儿电吧。"], direction: null },
          { id: "page-02-panel-02", change: "允许休息", action: "手机接上电源坐下", emotion: "释然", dialogue: ["休息，是给继续前进充电。"], direction: null },
        ],
        requiredText: ["先充会儿电吧。", "休息，是给继续前进充电。"],
        promptFile: "prompts/02.md",
        outputFile: "images/02.png",
      },
    ],
  },
  visualLock: {
    version: 3,
    lockId: "mock-minimalist-series-lock",
    sourceCharacterBible: "character-bible.json",
    style: { presetId: preset.id, ...preset.lock },
    characters: [{ id: character.id, immutable: character.immutable }],
    output: { aspectRatio: "3:4", textStrategy: "native" },
    referenceImages: [],
  },
  copywriting: {
    version: 3,
    platform: input.platform,
    titleCandidates: ["休息不是偷懒", "电量见底时别再硬撑", "停下来也在前进", "给自己充会儿电", "疲惫时允许自己休息"],
    summary: "一部低电量手机终于明白：休息是在补充继续行动的能力。",
    pullQuotes: ["我再撑一下。", "停下来，会落后。", "休息，是给继续前进充电。"],
    tags: ["休息", "情绪心理", "自我关怀", "条漫", "拟人漫画", "年轻人", "缓解焦虑", "能量管理", "治愈", "小红书漫画"],
    seriesNames: ["物件也有心事", "给情绪画个比喻", "两分钟心理条漫"],
    cta: "你最近一次允许自己好好休息，是什么时候？",
  },
};

const subjectiveEval = {
  hardGates: {
    sourceFaithfulness: { status: "pass", evidence: ["故事与用户提供的拟人隐喻一致。"] },
    comicPageForm: { status: "pass", evidence: ["两张图均为两格完整条漫页。"] },
    requiredText: { status: "pass", evidence: ["四句要求文字均清晰且分配正确。"] },
    safety: { status: "pass", evidence: ["无诊断、夸大或不安全内容。"] },
  },
  content: {
    angleQuality: 4,
    storyStructure: 4,
    dialogueNaturalness: 4,
    characterReproducibility: 4,
    publishingAlignment: 4,
  },
  pages: plannerPackage.comicPlan.pages.map((page) => ({
    pageId: page.id,
    checks: { panelPlanFidelity: 4, textLegibility: 4, storyBeatFidelity: 4, visualIntegrity: 4 },
    textAudit: { observed: page.requiredText, errors: [], observations: [] },
    evidence: [`${page.id} 的两格顺序、动作和文字符合规划。`],
  })),
  pairwise: [{
    pageId: "page-02",
    checks: { characterIdentity: 4, wardrobeAndProps: 4, artStyle: 4, pageGrammar: 4 },
    evidence: ["第二页延续第一页的手机身份、线条、配色与分格语言。"],
  }],
  series: {
    narrativeContinuity: 4,
    characterConsistency: 4,
    styleConsistency: 4,
    layoutConsistency: 4,
    textConsistency: 4,
  },
  issues: [],
  editorialRisks: [],
  humanReviewRequired: false,
};

function jsonResponse(response, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(200, { "content-type": "application/json", "content-length": bytes.length });
  response.end(bytes);
}

function runNode(argv, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { env, cwd: skillDir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "social-comic-runner-"));
const counts = { planner: 0, vision: 0, generations: 0, edits: 0 };
let imageNumber = 0;
let wrongNextImage = false;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bodyBytes = Buffer.concat(chunks);
  if (request.url === "/v1/chat/completions") {
    const body = JSON.parse(bodyBytes.toString("utf8"));
    const isVision = Array.isArray(body.messages?.[1]?.content);
    if (isVision) {
      counts.vision += 1;
      jsonResponse(response, { choices: [{ message: { content: JSON.stringify(subjectiveEval) } }] });
    } else {
      counts.planner += 1;
      jsonResponse(response, { choices: [{ message: { content: JSON.stringify(plannerPackage) } }] });
    }
    return;
  }
  if (request.url === "/v1/images/generations") {
    counts.generations += 1;
    imageNumber += 1;
    jsonResponse(response, { data: [{ b64_json: tinyPng(3, 4, imageNumber).toString("base64") }] });
    return;
  }
  if (request.url === "/v1/images/edits") {
    counts.edits += 1;
    imageNumber += 1;
    const image = wrongNextImage ? tinyPng(9, 16, imageNumber) : tinyPng(3, 4, imageNumber);
    wrongNextImage = false;
    jsonResponse(response, { data: [{ b64_json: image.toString("base64") }] });
    return;
  }
  response.writeHead(404);
  response.end();
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address();
  const baseURL = `http://127.0.0.1:${port}/v1`;
  const inputPath = path.join(tempDir, "input.json");
  const styleReferencePath = path.join(tempDir, "style-reference.png");
  const identityBoardPath = path.join(tempDir, "identity-three-view.png");
  const plannerRoute = path.join(tempDir, "planner-route.json");
  const imageRoute = path.join(tempDir, "image-route.json");
  const evaluatorRoute = path.join(tempDir, "evaluator-route.json");
  await writeFile(styleReferencePath, tinyPng(3, 4, 91));
  await writeFile(identityBoardPath, tinyPng(3, 4, 92));
  input.visual.styleMode = "reference";
  input.visual.preset = null;
  input.visual.referenceImages = [
    { file: styleReferencePath, roles: ["style", "page-grammar"], assetType: "style-reference" },
    { file: identityBoardPath, roles: ["identity"], assetType: "three-view", characterIds: [character.id], views: ["front", "side", "back", "expression"] },
  ];
  character.referenceImages = [input.visual.referenceImages[1]];
  plannerPackage.visualLock.style = { presetId: "reference", ...preset.lock };
  plannerPackage.visualLock.referenceImages = input.visual.referenceImages;
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  await writeFile(plannerRoute, `${JSON.stringify({ capability: "text", baseURL, apiKeyEnv: "COMIC_MOCK_KEY", model: "mock-planner", provider: "mock", adapter: "openai-compatible", pricingModel: "mock-free" }, null, 2)}\n`);
  await writeFile(imageRoute, `${JSON.stringify({
    capability: "image",
    baseURL,
    apiKeyEnv: "COMIC_MOCK_KEY",
    model: "mock-image",
    provider: "mock",
    adapter: "openai-compatible",
    pricingModel: "mock-free",
    dimensionControl: {
      status: "supported",
      mechanism: "size",
      guarantee: "exact",
      operations: ["generation", "edit"],
      evidence: { level: "runtime-verified", source: "loopback integration fixture" },
    },
    aspectRatioSizes: { "3:4": "3x4" },
    supportedSizes: ["3x4"],
    exactOutputSizes: ["3x4"],
    qualityMap: { final: "high" },
    supportsReferences: true,
  }, null, 2)}\n`);
  await writeFile(evaluatorRoute, `${JSON.stringify({ capability: "vision", baseURL, apiKeyEnv: "COMIC_MOCK_KEY", model: "mock-vision", provider: "mock", adapter: "openai-compatible", pricingModel: "mock-free" }, null, 2)}\n`);
  const env = { ...process.env, COMIC_MOCK_KEY: "not-a-real-key" };

  const noAuthRun = path.join(tempDir, "no-auth-run");
  const noAuth = await runNode([
    runScript,
    "--input", inputPath,
    "--run-dir", noAuthRun,
    "--stage", "all",
    "--planner-route-json", plannerRoute,
    "--image-route-json", imageRoute,
    "--evaluator-route-json", evaluatorRoute,
  ], env);
  assert.notEqual(noAuth.status, 0, "runner must reject unapproved model calls");
  assert.deepEqual(counts, { planner: 0, vision: 0, generations: 0, edits: 0 });
  const failedResult = JSON.parse(await readFile(path.join(noAuthRun, "result.json"), "utf8"));
  assert.equal(failedResult.status, "failed");
  assert.equal(failedResult.stage, "plan");
  const failedValidation = await runNode([validator, noAuthRun], env);
  assert.equal(failedValidation.status, 0, failedValidation.stdout || failedValidation.stderr);

  const capabilityBlockedRun = path.join(tempDir, "capability-blocked-run");
  const plannedOnly = await runNode([
    runScript,
    "--input", inputPath,
    "--run-dir", capabilityBlockedRun,
    "--stage", "plan",
    "--planner-route-json", plannerRoute,
    "--authorize-model-calls",
  ], env);
  assert.equal(plannedOnly.status, 0, plannedOnly.stdout || plannedOnly.stderr);
  assert.deepEqual(counts, { planner: 1, vision: 0, generations: 0, edits: 0 });
  const plannedOnlyResult = JSON.parse(await readFile(path.join(capabilityBlockedRun, "result.json"), "utf8"));
  assert.equal(plannedOnlyResult.status, "planned");
  assert.equal(plannedOnlyResult.error, null, "successful planning must clear the fail-closed initialization error");
  const capabilityBlocked = await runNode([
    runScript,
    "--input", inputPath,
    "--run-dir", capabilityBlockedRun,
    "--stage", "generate",
    "--image-route-json", unsupportedImageRoute,
    "--authorize-model-calls",
    "--resume",
  ], env);
  assert.notEqual(capabilityBlocked.status, 0);
  assert.deepEqual(counts, { planner: 1, vision: 0, generations: 0, edits: 0 });
  const capabilityBlockedResult = JSON.parse(await readFile(path.join(capabilityBlockedRun, "result.json"), "utf8"));
  assert.equal(capabilityBlockedResult.status, "failed");
  assert.equal(capabilityBlockedResult.stage, "generate");
  assert.match(capabilityBlockedResult.error, /IMAGE_ROUTE_DIMENSION_CONTROL_UNSUPPORTED/);
  const capabilityBlockedDiagnosis = JSON.parse(await readFile(path.join(capabilityBlockedRun, "diagnosis.json"), "utf8"));
  assert.equal(capabilityBlockedDiagnosis.issues[0].faultDomain, "runtime");
  assert.equal(capabilityBlockedDiagnosis.issues[0].autoAction, "none");
  const capabilityBlockedValidation = await runNode([validator, capabilityBlockedRun], env);
  assert.equal(capabilityBlockedValidation.status, 0, capabilityBlockedValidation.stdout || capabilityBlockedValidation.stderr);

  const fullRun = path.join(tempDir, "full-run");
  const completed = await runNode([
    runScript,
    "--input", inputPath,
    "--run-dir", fullRun,
    "--stage", "all",
    "--planner-route-json", plannerRoute,
    "--image-route-json", imageRoute,
    "--evaluator-route-json", evaluatorRoute,
    "--authorize-model-calls",
    "--max-concurrency", "2",
  ], env);
  assert.equal(completed.status, 0, completed.stdout || completed.stderr);
  assert.deepEqual(counts, { planner: 2, vision: 1, generations: 0, edits: 2 });
  const result = JSON.parse(await readFile(path.join(fullRun, "result.json"), "utf8"));
  assert.equal(result.status, "reviewed");
  assert.equal(result.error, null, "reviewed runs must never retain a stale initialization error");
  assert.deepEqual(result.actualDimensions, [
    { file: "images/01.png", width: 3, height: 4 },
    { file: "images/02.png", width: 3, height: 4 },
  ]);
  const promptOne = await readFile(path.join(fullRun, "prompts", "01.md"), "utf8");
  const promptTwo = await readFile(path.join(fullRun, "prompts", "02.md"), "utf8");
  assert.match(promptOne, /complete social-comic PAGE/);
  assert.match(promptOne, /Reference image 1 .*style-reference\.png.*roles: style, page-grammar/i);
  assert.match(promptOne, /Reference image 2 .*identity-three-view\.png.*assetType: three-view/i);
  assert.match(promptTwo, /Reference image 3 .*images\/01\.png.*generated-page-anchor/i);
  assert.doesNotMatch(`${promptOne}\n${promptTwo}`, /\b\d{2,5}\s*[x×]\s*\d{2,5}\b/);
  const usage = JSON.parse(await readFile(path.join(fullRun, "usage.json"), "utf8"));
  assert.equal(usage.status, "unavailable");
  assert.equal(usage.calls.length, 4);
  assert.equal(new Set(usage.calls.map((call) => call.callId)).size, 4);
  assert.deepEqual(usage.calls.map((call) => call.role), ["planner", "image", "image", "evaluator"]);
  assert.deepEqual(usage.calls.map((call) => call.operation), ["chat", "edit", "edit", "vision-chat"]);
  assert.ok(usage.calls.every((call) => call.status === "succeeded" && call.meteringStatus === "unavailable"));
  const debug = JSON.parse(await readFile(path.join(fullRun, "debug.json"), "utf8"));
  assert.deepEqual(debug.imageRoutePreflight.requiredOperations, ["edit"]);
  assert.equal(debug.imageRoutePreflight.request.requestedSize, "3x4");
  assert.equal(debug.imageRoutePreflight.providerQuality, "high");
  assert.equal(debug.imageRoutePreflight.requestPreview.credentialsIncluded, false);
  const firstSidecar = JSON.parse(await readFile(path.join(fullRun, "images", "01.png.json"), "utf8"));
  const secondSidecar = JSON.parse(await readFile(path.join(fullRun, "images", "02.png.json"), "utf8"));
  assert.deepEqual(firstSidecar.references.map((item) => item.file), [styleReferencePath, identityBoardPath]);
  assert.deepEqual(secondSidecar.references.map((item) => item.assetType), ["style-reference", "three-view", "generated-page-anchor"]);
  const validation = await runNode([validator, fullRun], env);
  assert.equal(validation.status, 0, validation.stdout || validation.stderr);

  wrongNextImage = true;
  const wrongSizeRun = path.join(tempDir, "wrong-size-run");
  const wrongSize = await runNode([
    runScript,
    "--input", inputPath,
    "--run-dir", wrongSizeRun,
    "--stage", "all",
    "--planner-route-json", plannerRoute,
    "--image-route-json", imageRoute,
    "--evaluator-route-json", evaluatorRoute,
    "--authorize-model-calls",
  ], env);
  assert.notEqual(wrongSize.status, 0, "wrong direct dimensions must stop the run");
  assert.deepEqual(counts, { planner: 3, vision: 1, generations: 0, edits: 3 });
  const wrongResult = JSON.parse(await readFile(path.join(wrongSizeRun, "result.json"), "utf8"));
  assert.equal(wrongResult.status, "failed");
  assert.equal(wrongResult.stage, "generate");
  assert.match(wrongResult.error, /9x16.*not provider-native portrait 3:4/);
  assert.deepEqual(wrongResult.pages, ["images/01.png"]);
  assert.deepEqual(wrongResult.actualDimensions, [{ file: "images/01.png", width: 9, height: 16 }]);
  const wrongSidecar = JSON.parse(await readFile(path.join(wrongSizeRun, "images", "01.png.json"), "utf8"));
  assert.deepEqual(wrongSidecar.actualDimensions, { width: 9, height: 16 });
  const wrongDiagnosis = JSON.parse(await readFile(path.join(wrongSizeRun, "diagnosis.json"), "utf8"));
  assert.equal(wrongDiagnosis.status, "action-required");
  assert.equal(wrongDiagnosis.issues[0].faultDomain, "model-execution");
  assert.equal(wrongDiagnosis.issues[0].issueId, "provider-output-dimension-mismatch");
  assert.equal(wrongDiagnosis.issues[0].autoAction, "none");
  const wrongValidation = await runNode([validator, wrongSizeRun], env);
  assert.equal(wrongValidation.status, 0, wrongValidation.stdout || wrongValidation.stderr);

  console.log(JSON.stringify({
    valid: true,
    cases: [
      "no-authority-means-zero-provider-requests",
      "unsupported-host-dimension-route-fails-before-image-provider-call",
      "planner-package-to-deterministic-page-prompts",
      "reference-metadata-order-matches-two-reference-edits-and-sidecars",
      "anchor-first-page-is-appended-after-external-references",
      "direct-3:4-pages-record-actual-dimensions-without-invented-pixels",
      "dimension-and-operation-preflight-runs-before-provider-calls",
      "product-final-quality-maps-to-provider-high",
      "multimodal-eval-and-diagnosis-produce-reviewed-result",
      "provider-without-metering-remains-usage-unavailable",
      "wrong-direct-size-stops-before-later-pages-and-vision-eval",
      "failed-generation-preserves-measured-output-and-deterministic-diagnosis",
    ],
    requests: counts,
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}
