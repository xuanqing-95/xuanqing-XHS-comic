#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(scriptDir, "..");
const runScript = path.join(scriptDir, "run.mjs");
const validator = path.join(scriptDir, "validate-run.mjs");
const compositorRoute = path.join(skillDir, "references", "routes", "bundled-sharp-post-layout.json");
const sharp = (await import("sharp")).default;
const styleCatalog = JSON.parse(await readFile(path.join(skillDir, "references", "style-presets.json"), "utf8"));
const preset = styleCatalog.presets.find((item) => item.id === "minimalist-doodle-personification");
assert.ok(preset);

const input = {
  version: 3,
  mode: "story-to-comic",
  source: { topic: "休息不是偷懒", story: "手机电量见底，充电器提醒它先停下来充电。", draft: null },
  domain: "情绪心理学",
  audience: "疲惫的年轻人",
  coreMessage: "休息是在补充继续行动的能力。",
  tone: "轻松、温柔",
  platform: "小红书",
  language: "zh-CN",
  ctaGoal: "收藏",
  visual: { styleMode: "preset", preset: preset.id, customStyle: null, referenceImages: [] },
  layout: { countMode: "user-fixed", totalPanelCount: 2, preferredPanelsPerPage: 2 },
  output: { aspectRatio: "3:4", textStrategy: "post-layout", quality: "final", pageCountCeiling: null },
  series: { enabled: false, characterAnchorFiles: [], styleAnchorFiles: [] },
};

const character = {
  id: "char-phone",
  role: "疲惫的手机",
  personality: ["认真"],
  immutable: {
    age: "年轻成年人的拟人年龄感",
    face: "两个黑点眼睛和一条短嘴",
    hair: "无头发",
    body: "淡桃色圆角手机身体",
    outfit: "无衣服，固定淡桃色机身",
    signatureColors: ["淡桃色", "白色", "黑色"],
    recurringProps: ["充电线"],
  },
  expressionRange: ["疲惫", "放松"],
  signatureActions: ["弯腰", "接上充电线"],
  forbiddenChanges: ["变成人类"],
  referenceImages: [],
};

const page = {
  id: "page-01",
  purpose: "建立冲突并完成理解",
  change: "手机从硬撑变为允许休息",
  scene: "极简白底和淡黄色地面",
  panelCount: 2,
  panels: [
    {
      id: "page-01-panel-01",
      change: "手机继续硬撑",
      action: "手机弯腰向前走，避开左上方预留区",
      emotion: "疲惫",
      dialogue: ["我再撑一下。"],
      direction: "上半格，角色位于右下，左上 x=80..500 y=80..240 区域保持空白",
    },
    {
      id: "page-01-panel-02",
      change: "手机接受充电",
      action: "手机坐在左下接上充电线，避开右下预留区",
      emotion: "放松",
      dialogue: ["休息，是给继续前进充电。"],
      direction: "下半格，角色位于左下，右侧 x=520..930 y=650..860 区域保持空白",
    },
  ],
  requiredText: ["我再撑一下。", "休息，是给继续前进充电。"],
  textPlacements: [
    {
      id: "slot-01",
      requiredTextIndex: 0,
      text: "我再撑一下。",
      panelId: "page-01-panel-01",
      kind: "speech",
      tail: "right",
      box: { x: 80, y: 80, width: 420, height: 160 },
    },
    {
      id: "slot-02",
      requiredTextIndex: 1,
      text: "休息，是给继续前进充电。",
      panelId: "page-01-panel-02",
      kind: "caption",
      tail: "none",
      box: { x: 520, y: 650, width: 410, height: 210 },
    },
  ],
  promptFile: "prompts/01.md",
  outputFile: "images/01.png",
};

const plannerPackage = {
  topicAngles: { version: 3, status: "skipped", angles: [], selectedAngleId: null, selectionReason: null, skipReason: "用户提供了故事。" },
  story: {
    version: 3,
    sourceMode: "user-supplied",
    title: "休息，是给继续前进充电",
    logline: "手机在充电器提醒下允许自己休息。",
    coreMessage: input.coreMessage,
    summary: input.source.story,
    structure: { hook: "手机硬撑", escalation: "电量见底", turn: "充电器提醒", resolution: "接上电源", endingHook: "休息也在前进" },
    emotionalCurve: ["疲惫", "放松"],
    claims: [],
    sourceFaithfulness: "保留原故事和观点。",
  },
  characterBible: { version: 3, seriesMode: false, characters: [character], relationships: [], seriesAssets: { characterSheetFiles: [], styleAnchorFiles: [], columnName: null } },
  comicPlan: {
    version: 3,
    title: "休息，是给继续前进充电",
    coreMessage: input.coreMessage,
    compositionFreedom: "director-locked",
    compositionReason: "post-layout 需要机器可执行的预留文字区域。",
    pageCount: 1,
    countReason: "两个连续变化在一张两格页面中完成。",
    aspectRatio: "3:4",
    quality: "final",
    textStrategy: "post-layout",
    generationStrategy: "style-lock-parallel",
    pages: [page],
  },
  visualLock: {
    version: 3,
    lockId: "post-layout-test-lock",
    sourceCharacterBible: "character-bible.json",
    style: { presetId: preset.id, ...preset.lock },
    characters: [{ id: character.id, immutable: character.immutable }],
    output: { aspectRatio: "3:4", textStrategy: "post-layout" },
    referenceImages: [],
  },
  copywriting: {
    version: 3,
    platform: input.platform,
    titleCandidates: ["休息不是偷懒", "给自己充会儿电", "停下来也在前进", "电量见底别硬撑", "休息的意义"],
    summary: "一部手机终于允许自己停下来充电。",
    pullQuotes: ["我再撑一下。", "休息不是偷懒。", "休息，是给继续前进充电。"],
    tags: ["休息", "心理学", "条漫", "拟人", "治愈", "年轻人", "自我关怀", "能量管理", "小红书", "漫画"],
    seriesNames: ["物件也有心事", "情绪小剧场", "两格心理条漫"],
    cta: "你今天休息了吗？",
  },
};

const subjectiveEval = {
  hardGates: {
    sourceFaithfulness: { status: "pass", evidence: ["故事一致。"] },
    comicPageForm: { status: "pass", evidence: ["完整两格条漫。"] },
    requiredText: { status: "pass", evidence: ["两句文字清晰且归属正确。"] },
    safety: { status: "pass", evidence: ["安全。"] },
  },
  content: { angleQuality: 4, storyStructure: 4, dialogueNaturalness: 4, characterReproducibility: 4, publishingAlignment: 4 },
  pages: [{
    pageId: page.id,
    checks: { panelPlanFidelity: 4, textLegibility: 4, storyBeatFidelity: 4, visualIntegrity: 4 },
    textAudit: { observed: page.requiredText, errors: [], observations: [] },
    evidence: ["文字和画面均可读。"],
  }],
  pairwise: [],
  series: { narrativeContinuity: 4, characterConsistency: 4, styleConsistency: 4, layoutConsistency: 4, textConsistency: 4 },
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

const tempDir = await mkdtemp(path.join(os.tmpdir(), "social-comic-post-layout-runner-"));
const counts = { planner: 0, vision: 0, generations: 0, edits: 0 };
const providerPng = await sharp({ create: { width: 600, height: 800, channels: 4, background: { r: 246, g: 240, b: 219, alpha: 1 } } })
  .composite([{ input: Buffer.from('<svg width="600" height="800" xmlns="http://www.w3.org/2000/svg"><rect x="250" y="300" width="100" height="100" rx="20" fill="#efaa98"/><line x1="0" y1="400" x2="600" y2="400" stroke="#222" stroke-width="4"/></svg>') }])
  .png().toBuffer();
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
    jsonResponse(response, { data: [{ b64_json: providerPng.toString("base64") }] });
    return;
  }
  if (request.url === "/v1/images/edits") {
    counts.edits += 1;
    jsonResponse(response, { data: [{ b64_json: providerPng.toString("base64") }] });
    return;
  }
  response.writeHead(404);
  response.end();
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const { port } = server.address();
  const baseURL = `http://127.0.0.1:${port}/v1`;
  const inputPath = path.join(tempDir, "input.json");
  const plannerRoute = path.join(tempDir, "planner-route.json");
  const imageRoute = path.join(tempDir, "image-route.json");
  const evaluatorRoute = path.join(tempDir, "evaluator-route.json");
  await writeFile(inputPath, JSON.stringify(input));
  await writeFile(plannerRoute, JSON.stringify({ capability: "text", baseURL, apiKeyEnv: "COMIC_MOCK_KEY", model: "mock-planner", provider: "mock", adapter: "openai-compatible", pricingModel: "mock-free" }));
  await writeFile(imageRoute, JSON.stringify({
    capability: "image",
    baseURL,
    apiKeyEnv: "COMIC_MOCK_KEY",
    model: "mock-image",
    provider: "mock",
    adapter: "openai-compatible",
    pricingModel: "mock-free",
    dimensionControl: { status: "supported", mechanism: "size", guarantee: "exact", operations: ["generation", "edit"], evidence: { level: "runtime-verified", source: "loopback fixture" } },
    aspectRatioSizes: { "3:4": "600x800" },
    supportedSizes: ["600x800"],
    exactOutputSizes: ["600x800"],
    qualityMap: { final: "high" },
    supportsReferences: true,
  }));
  await writeFile(evaluatorRoute, JSON.stringify({ capability: "vision", baseURL, apiKeyEnv: "COMIC_MOCK_KEY", model: "mock-vision", provider: "mock", adapter: "openai-compatible", pricingModel: "mock-free" }));
  const env = { ...process.env, COMIC_MOCK_KEY: "not-a-real-key" };

  const missingRouteRun = path.join(tempDir, "missing-route-run");
  const planned = await runNode([runScript, "--input", inputPath, "--run-dir", missingRouteRun, "--stage", "plan", "--planner-route-json", plannerRoute, "--authorize-model-calls"], env);
  assert.equal(planned.status, 0, planned.stdout || planned.stderr);
  const beforeMissing = { ...counts };
  const missing = await runNode([runScript, "--input", inputPath, "--run-dir", missingRouteRun, "--stage", "generate", "--image-route-json", imageRoute, "--authorize-model-calls", "--resume"], env);
  assert.notEqual(missing.status, 0);
  assert.deepEqual(counts, beforeMissing, "missing compositor must fail before any image request");
  assert.match(missing.stderr, /POST_LAYOUT_ROUTE_REQUIRED/);

  const fullRun = path.join(tempDir, "full-run");
  const completed = await runNode([
    runScript,
    "--input", inputPath,
    "--run-dir", fullRun,
    "--stage", "all",
    "--planner-route-json", plannerRoute,
    "--image-route-json", imageRoute,
    "--compositor-route-json", compositorRoute,
    "--evaluator-route-json", evaluatorRoute,
    "--authorize-model-calls",
  ], env);
  assert.equal(completed.status, 0, completed.stdout || completed.stderr);
  const result = JSON.parse(await readFile(path.join(fullRun, "result.json"), "utf8"));
  assert.equal(result.status, "reviewed");
  assert.deepEqual(result.sourcePages, ["source-images/01.png"]);
  assert.deepEqual(result.pages, ["images/01.png"]);
  assert.deepEqual(result.sourceActualDimensions, [{ file: "source-images/01.png", width: 600, height: 800 }]);
  assert.deepEqual(result.actualDimensions, [{ file: "images/01.png", width: 600, height: 800 }]);
  const sourceBytes = await readFile(path.join(fullRun, "source-images", "01.png"));
  const finalBytes = await readFile(path.join(fullRun, "images", "01.png"));
  assert.notDeepEqual(finalBytes, sourceBytes);
  const prompt = await readFile(path.join(fullRun, "prompts", "01.md"), "utf8");
  assert.match(prompt, /slot-01.*normalized box/i);
  assert.doesNotMatch(prompt, /我再撑一下|休息，是给继续前进充电/);
  const lettering = JSON.parse(await readFile(path.join(fullRun, "lettering-report.json"), "utf8"));
  assert.equal(lettering.status, "pass");
  assert.equal(lettering.pages[0].pixelAudit.outsideDeclaredRegionsUnchanged, true);
  assert.equal(lettering.pages[0].generationProvenance.sourceFile, "source-images/01.png");
  assert.equal(lettering.pages[0].generationProvenance.finalOutputFile, "images/01.png");
  assert.equal(lettering.pages[0].generationProvenance.sourceSha256, lettering.pages[0].sourceSha256);
  const evaluation = JSON.parse(await readFile(path.join(fullRun, "eval-report.json"), "utf8"));
  assert.equal(evaluation.hardGates.outputIntegrity.status, "pass");
  assert.equal(evaluation.hardGates.directOutput, undefined);
  const usage = JSON.parse(await readFile(path.join(fullRun, "usage.json"), "utf8"));
  assert.equal(usage.status, "unavailable");
  assert.deepEqual(usage.calls.map((call) => call.role), ["planner", "image", "compositor", "evaluator"]);
  assert.equal(usage.calls.find((call) => call.role === "compositor").meteringStatus, "not_applicable");
  assert.equal(new Set(usage.calls.map((call) => call.callId)).size, usage.calls.length);
  const validated = await runNode([validator, fullRun], env);
  assert.equal(validated.status, 0, validated.stdout || validated.stderr);
  const completedSidecarPath = path.join(fullRun, "source-images", "01.png.json");
  const completedSidecarBytes = await readFile(completedSidecarPath);
  const completedSidecar = JSON.parse(completedSidecarBytes.toString("utf8"));
  await writeFile(completedSidecarPath, JSON.stringify({ ...completedSidecar, pageId: "tampered-after-compose" }));
  const tamperedCompletedRun = await runNode([validator, fullRun], env);
  assert.notEqual(tamperedCompletedRun.status, 0);
  assert.match(tamperedCompletedRun.stdout, /generationProvenance must match the immutable provider source/);
  await writeFile(completedSidecarPath, completedSidecarBytes);
  const restoredCompletedRun = await runNode([validator, fullRun], env);
  assert.equal(restoredCompletedRun.status, 0, restoredCompletedRun.stdout || restoredCompletedRun.stderr);

  const resumeRun = path.join(tempDir, "resume-run");
  const plannedResume = await runNode([runScript, "--input", inputPath, "--run-dir", resumeRun, "--stage", "plan", "--planner-route-json", plannerRoute, "--authorize-model-calls"], env);
  assert.equal(plannedResume.status, 0, plannedResume.stdout || plannedResume.stderr);
  const generatedResume = await runNode([runScript, "--input", inputPath, "--run-dir", resumeRun, "--stage", "generate", "--image-route-json", imageRoute, "--compositor-route-json", compositorRoute, "--authorize-model-calls", "--resume"], env);
  assert.equal(generatedResume.status, 0, generatedResume.stdout || generatedResume.stderr);
  const beforeCompose = { ...counts };
  const badRoutePath = path.join(tempDir, "bad-compositor-route.json");
  const badRoute = JSON.parse(await readFile(compositorRoute, "utf8"));
  badRoute.fontFile = path.resolve(path.dirname(compositorRoute), badRoute.fontFile);
  badRoute.fontSha256 = "0".repeat(64);
  await writeFile(badRoutePath, JSON.stringify(badRoute));
  const failedCompose = await runNode([runScript, "--input", inputPath, "--run-dir", resumeRun, "--stage", "compose", "--compositor-route-json", badRoutePath, "--resume"], env);
  assert.notEqual(failedCompose.status, 0);
  assert.deepEqual(counts, beforeCompose, "composition failure must not call image or vision models");
  const failedComposeResult = JSON.parse(await readFile(path.join(resumeRun, "result.json"), "utf8"));
  assert.equal(failedComposeResult.stage, "compose");
  assert.deepEqual(failedComposeResult.sourcePages, ["source-images/01.png"]);
  assert.equal(failedComposeResult.pages, undefined);
  const resumedCompose = await runNode([runScript, "--input", inputPath, "--run-dir", resumeRun, "--stage", "compose", "--compositor-route-json", compositorRoute, "--resume"], env);
  assert.equal(resumedCompose.status, 0, resumedCompose.stdout || resumedCompose.stderr);
  assert.deepEqual(counts, beforeCompose, "resuming compose must reuse paid source images");
  const resumedUsage = JSON.parse(await readFile(path.join(resumeRun, "usage.json"), "utf8"));
  assert.deepEqual(resumedUsage.calls.map((call) => call.role), ["planner", "image", "compositor"]);

  const provenanceRun = path.join(tempDir, "provenance-run");
  const provenancePlan = await runNode([runScript, "--input", inputPath, "--run-dir", provenanceRun, "--stage", "plan", "--planner-route-json", plannerRoute, "--authorize-model-calls"], env);
  assert.equal(provenancePlan.status, 0, provenancePlan.stdout || provenancePlan.stderr);
  const provenanceGenerate = await runNode([runScript, "--input", inputPath, "--run-dir", provenanceRun, "--stage", "generate", "--image-route-json", imageRoute, "--compositor-route-json", compositorRoute, "--authorize-model-calls", "--resume"], env);
  assert.equal(provenanceGenerate.status, 0, provenanceGenerate.stdout || provenanceGenerate.stderr);
  const provenanceCounts = { ...counts };
  const provenanceSource = path.join(provenanceRun, "source-images", "01.png");
  const provenanceSidecarPath = `${provenanceSource}.json`;
  const originalSidecar = JSON.parse(await readFile(provenanceSidecarPath, "utf8"));

  await rm(provenanceSidecarPath);
  const missingSidecar = await runNode([runScript, "--input", inputPath, "--run-dir", provenanceRun, "--stage", "compose", "--compositor-route-json", compositorRoute, "--resume"], env);
  assert.notEqual(missingSidecar.status, 0);
  assert.match(missingSidecar.stderr, /POST_LAYOUT_SOURCE_SIDECAR_MISSING/);
  assert.deepEqual(counts, provenanceCounts);
  await access(provenanceSource);
  await assert.rejects(() => access(path.join(provenanceRun, "images", "01.png")), (error) => error?.code === "ENOENT");

  await writeFile(provenanceSidecarPath, JSON.stringify({ ...originalSidecar, pageId: "wrong-page" }));
  const wrongPage = await runNode([runScript, "--input", inputPath, "--run-dir", provenanceRun, "--stage", "compose", "--compositor-route-json", compositorRoute, "--resume"], env);
  assert.notEqual(wrongPage.status, 0);
  assert.match(wrongPage.stderr, /POST_LAYOUT_SOURCE_PAGE_MISMATCH/);
  assert.deepEqual(counts, provenanceCounts);

  await writeFile(provenanceSidecarPath, JSON.stringify({ ...originalSidecar, operation: "edit" }));
  const wrongOperation = await runNode([runScript, "--input", inputPath, "--run-dir", provenanceRun, "--stage", "compose", "--compositor-route-json", compositorRoute, "--resume"], env);
  assert.notEqual(wrongOperation.status, 0);
  assert.match(wrongOperation.stderr, /POST_LAYOUT_SOURCE_OPERATION_MISMATCH/);
  assert.deepEqual(counts, provenanceCounts);

  await writeFile(provenanceSidecarPath, JSON.stringify({ ...originalSidecar, callId: `${originalSidecar.callId}:wrong` }));
  const wrongCall = await runNode([runScript, "--input", inputPath, "--run-dir", provenanceRun, "--stage", "compose", "--compositor-route-json", compositorRoute, "--resume"], env);
  assert.notEqual(wrongCall.status, 0);
  assert.match(wrongCall.stderr, /POST_LAYOUT_SOURCE_CALL_MISMATCH/);
  assert.deepEqual(counts, provenanceCounts);

  await writeFile(provenanceSidecarPath, JSON.stringify({ ...originalSidecar, actualDimensions: { width: 601, height: 800 } }));
  const wrongDimensions = await runNode([runScript, "--input", inputPath, "--run-dir", provenanceRun, "--stage", "compose", "--compositor-route-json", compositorRoute, "--resume"], env);
  assert.notEqual(wrongDimensions.status, 0);
  assert.match(wrongDimensions.stderr, /POST_LAYOUT_SOURCE_DIMENSION_MISMATCH/);
  assert.deepEqual(counts, provenanceCounts);

  await writeFile(provenanceSidecarPath, JSON.stringify(originalSidecar));
  const tamperedSource = await sharp({ create: { width: 600, height: 800, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
  await writeFile(provenanceSource, tamperedSource);
  const wrongHash = await runNode([runScript, "--input", inputPath, "--run-dir", provenanceRun, "--stage", "compose", "--compositor-route-json", compositorRoute, "--resume"], env);
  assert.notEqual(wrongHash.status, 0);
  assert.match(wrongHash.stderr, /POST_LAYOUT_SOURCE_HASH_MISMATCH/);
  assert.deepEqual(counts, provenanceCounts);
  await assert.rejects(() => access(path.join(provenanceRun, "images", "01.png")), (error) => error?.code === "ENOENT");

  await writeFile(provenanceSource, providerPng);
  const provenanceResume = await runNode([runScript, "--input", inputPath, "--run-dir", provenanceRun, "--stage", "compose", "--compositor-route-json", compositorRoute, "--resume"], env);
  assert.equal(provenanceResume.status, 0, provenanceResume.stdout || provenanceResume.stderr);
  assert.deepEqual(counts, provenanceCounts, "provenance repair and compose resume must not call the image provider");

  console.log(JSON.stringify({
    valid: true,
    cases: [
      "missing-compositor-stops-before-image-call",
      "planner-compiles-lettering-plan",
      "post-layout-prompt-withholds-literal-copy",
      "provider-source-is-preserved",
      "compose-produces-same-size-final",
      "output-integrity-replaces-false-direct-output",
      "multimodal-eval-runs-only-after-compose",
      "compose-failure-preserves-source-and-skips-eval",
      "resume-compose-reuses-paid-source-with-zero-model-calls",
      "compose-requires-generation-sidecar-before-writing-final",
      "page-operation-dimensions-and-source-hash-fail-closed",
      "completed-run-revalidates-generation-sidecar-provenance",
      "provenance-repair-resume-makes-zero-image-provider-calls",
    ],
    requests: counts,
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}
