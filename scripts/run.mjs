#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, usage } from "./cli-options.mjs";
import {
  buildDiagnosis,
  buildEvalReport,
  buildEvaluatorPrompt,
  buildEvaluatorRepairPrompt,
  normalizeSubjectiveEvaluation,
  validateSubjectiveEvaluation,
} from "./evaluation-utils.mjs";
import { postLayoutSourceFile } from "./post-layout.mjs";
import { loadRoute, runJsonChat } from "./provider-clients.mjs";
import {
  collectReferenceAssets,
  selectContinuityAnchorAsset,
} from "./reference-assets.mjs";
import { ensureRunFilesExist, hashRunFiles, resolveRunReferenceFile } from "./run-file-utils.mjs";
import { createComposeStage } from "./run-compose-stage.mjs";
import { createGenerateStage } from "./run-generate-stage.mjs";
import { createPlanStage } from "./run-plan-stage.mjs";
import {
  initializeRunArtifacts,
  pngMetadata,
  readJson,
  readJsonIfExists,
  updateDebug,
  updateResult,
  updateUsage,
  writeJsonAtomic,
} from "./run-artifacts.mjs";
import {
  buildUsageArtifact,
  stableHash,
  upsertUsageCall,
  usageHasMetering,
} from "./usage-contract.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(scriptDir, "..");
const validatorPath = path.join(scriptDir, "validate-run.mjs");
const styleCatalogPath = path.join(skillDir, "references", "style-presets.json");

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exit(2);
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

const inputPath = path.resolve(args.input);
const runDir = path.resolve(args.runDir);
const inputBaseDir = path.dirname(inputPath);

function now() {
  return new Date().toISOString();
}

function serializeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function directoryHasEntries(directory) {
  try {
    const entries = await readdir(directory);
    return entries.some((entry) => entry !== "input.json" && entry !== "reference-assets");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function addDebugEvent(stage, status, detail = {}) {
  const filePath = path.join(runDir, "debug.json");
  const current = (await readJsonIfExists(filePath)) || { version: 3, events: [], errors: [] };
  const event = { at: now(), stage, status, ...detail };
  const errors = status === "failed" || status === "blocked"
    ? [...(current.errors || []), event]
    : (current.errors || []);
  return updateDebug(runDir, {
    status,
    stage,
    updatedAt: event.at,
    events: [...(current.events || []), event],
    errors,
  });
}

let usageWriteQueue = Promise.resolve();

function recordUsage(call) {
  const write = usageWriteQueue.then(async () => {
    const filePath = path.join(runDir, "usage.json");
    const current = (await readJsonIfExists(filePath)) || { version: 3, status: "not_applicable", calls: [] };
    const calls = upsertUsageCall(current.calls || [], call);
    return updateUsage(runDir, buildUsageArtifact(calls));
  });
  usageWriteQueue = write.catch(() => {});
  return write;
}

function runIdentity() {
  return path.basename(runDir);
}

function callIdFor(suffix) {
  return `${runIdentity()}:${suffix}`;
}

function modelCallIntent({ callId, role, stage, operation, inputHash, pageId = null, outputFile = null }) {
  return {
    callId,
    role,
    stage,
    operation,
    pageId,
    outputFile,
    status: "started",
    meteringStatus: "pending",
    inputHash,
    outputHash: null,
    requestId: null,
    startedAt: now(),
    completedAt: null,
    usage: null,
  };
}

function completedModelCall(intent, result, outputHash) {
  return {
    ...intent,
    status: "succeeded",
    meteringStatus: usageHasMetering(result.usage) ? "available" : "unavailable",
    provider: result.provider,
    model: result.model,
    pricingModel: result.pricingModel,
    attempts: result.attempts,
    requestId: result.requestId ?? null,
    outputHash,
    completedAt: now(),
    usage: usageHasMetering(result.usage) ? result.usage : null,
  };
}

function failedModelCall(intent, error) {
  return {
    ...intent,
    status: "failed",
    meteringStatus: "unavailable",
    completedAt: now(),
    error: serializeError(error),
  };
}

function requireAuthorized(routePath, optionName, stage) {
  if (!args.authorizeModelCalls) {
    throw new Error(`${stage} requires --authorize-model-calls; no model call was made.`);
  }
  if (!routePath) {
    throw new Error(`${stage} requires ${optionName}; no model call was made.`);
  }
}

function runValidator() {
  const completed = spawnSync(process.execPath, [validatorPath, runDir], {
    encoding: "utf8",
    cwd: skillDir,
  });
  let report = null;
  try {
    report = JSON.parse(completed.stdout || "null");
  } catch {
    // The full raw output is included in the error below.
  }
  if (completed.status !== 0 || report?.valid !== true) {
    const detail = report ? JSON.stringify(report.errors || report, null, 2) : (completed.stderr || completed.stdout);
    throw new Error(`Run validation failed:\n${detail}`);
  }
  return report;
}

const stageContext = {
  args,
  runDir,
  inputBaseDir,
  now,
  sameJson,
  addDebugEvent,
  recordUsage,
  callIdFor,
  modelCallIntent,
  completedModelCall,
  failedModelCall,
  requireAuthorized,
  runValidator,
};
const runPlan = createPlanStage(stageContext);
const runGenerate = createGenerateStage(stageContext);
const runCompose = createComposeStage(stageContext);

async function runEvaluate(input) {
  await addDebugEvent("evaluate", "running");
  const resultBefore = await readJson(path.join(runDir, "result.json"));
  if (resultBefore.status !== "generated") {
    throw new Error(`Evaluation requires result.status generated, got ${resultBefore.status}`);
  }
  runValidator();
  requireAuthorized(args.evaluatorRouteJson, "--evaluator-route-json", "Evaluation");
  const route = await loadRoute(args.evaluatorRouteJson, "vision");
  const [story, characterBible, plan, visualLock, copywriting] = await Promise.all([
    readJson(path.join(runDir, "story.json")),
    readJson(path.join(runDir, "character-bible.json")),
    readJson(path.join(runDir, "comic-plan.json")),
    readJson(path.join(runDir, "visual-lock.json")),
    readJson(path.join(runDir, "copywriting.json")),
  ]);
  const letteringReport = plan.textStrategy === "post-layout"
    ? await readJson(path.join(runDir, "lettering-report.json"))
    : null;
  const externalReferenceAssets = collectReferenceAssets({ input, visualLock, characterBible });
  const continuityAnchorAsset = input.mode === "series-continuation"
    ? selectContinuityAnchorAsset({ input, visualLock, characterBible })
    : null;
  const orderedExternalAssets = continuityAnchorAsset
    ? [continuityAnchorAsset, ...externalReferenceAssets.filter((asset) => asset.file !== continuityAnchorAsset.file)]
    : externalReferenceAssets;
  const externalAnchor = continuityAnchorAsset ? resolveRunReferenceFile(inputBaseDir, continuityAnchorAsset.file) : null;
  const pageFiles = plan.pages.map((page) => path.join(runDir, page.outputFile));
  const externalFiles = orderedExternalAssets.map((asset) => resolveRunReferenceFile(inputBaseDir, asset.file));
  const imageFiles = [...externalFiles, ...pageFiles];
  await ensureRunFilesExist(imageFiles);
  const imageOrder = externalAnchor
    ? `The first supplied image is the canonical external series continuity anchor. External reference images follow in this exact order before the new pages: ${orderedExternalAssets.map((asset, index) => `image ${index + 1}=${asset.file} [${asset.roles.join(",")}]`).join("; ")}. The remaining images are new pages in this order: ${plan.pages.map((page) => page.id).join(", ")}.`
    : externalFiles.length > 0
      ? `The first ${externalFiles.length} supplied images are supporting references in this order: ${orderedExternalAssets.map((asset, index) => `image ${index + 1}=${asset.file} [${asset.roles.join(",")}]`).join("; ")}. They are not a canonical continuity anchor. The remaining images are new pages in this order: ${plan.pages.map((page) => page.id).join(", ")}. Page 1 is the internal anchor.`
      : `The supplied images are new pages in this order: ${plan.pages.map((page) => page.id).join(", ")}. Page 1 is the internal anchor.`;
  const evaluationContext = { input, story, characterBible, plan, visualLock, copywriting };
  const evaluatorPrompt = `${imageOrder}\n\n${buildEvaluatorPrompt(evaluationContext)}`;
  const evaluatorInputHash = stableHash({
    prompt: evaluatorPrompt,
    images: await hashRunFiles(imageFiles),
  });
  const intent = modelCallIntent({
    callId: callIdFor(`evaluate:${evaluatorInputHash}`),
    role: "evaluator",
    stage: "evaluate",
    operation: "vision-chat",
    inputHash: evaluatorInputHash,
  });
  await recordUsage(intent);
  let response;
  try {
    response = await runJsonChat({
      route,
      prompt: evaluatorPrompt,
      imageFiles,
      timeoutMs: args.timeoutMs,
    });
    await recordUsage(completedModelCall(intent, response, stableHash(response.data)));
  } catch (error) {
    await recordUsage(failedModelCall(intent, error));
    throw error;
  }
  response.data = normalizeSubjectiveEvaluation(response.data);
  let subjectiveErrors = validateSubjectiveEvaluation(response.data, { plan, input, visualLock, characterBible });
  if (subjectiveErrors.length > 0) {
    await addDebugEvent("evaluate-contract-repair", "running", { validationErrors: subjectiveErrors });
    const repairPrompt = `${imageOrder}\n\n${buildEvaluatorRepairPrompt({
      ...evaluationContext,
      invalidEvaluation: response.data,
      validationErrors: subjectiveErrors,
    })}`;
    const repairInputHash = stableHash({
      prompt: repairPrompt,
      images: await hashRunFiles(imageFiles),
    });
    const repairIntent = modelCallIntent({
      callId: callIdFor(`evaluate-contract-repair:${repairInputHash}`),
      role: "evaluator",
      stage: "evaluate-contract-repair",
      operation: "vision-chat",
      inputHash: repairInputHash,
    });
    await recordUsage(repairIntent);
    try {
      response = await runJsonChat({
        route,
        prompt: repairPrompt,
        imageFiles,
        timeoutMs: args.timeoutMs,
      });
      await recordUsage(completedModelCall(repairIntent, response, stableHash(response.data)));
    } catch (error) {
      await recordUsage(failedModelCall(repairIntent, error));
      throw error;
    }
    response.data = normalizeSubjectiveEvaluation(response.data);
    subjectiveErrors = validateSubjectiveEvaluation(response.data, { plan, input, visualLock, characterBible });
    if (subjectiveErrors.length > 0) {
      throw new Error(`Evaluator output failed its contract after one image-free repair attempt:\n${subjectiveErrors.join("\n")}`);
    }
    await addDebugEvent("evaluate-contract-repair", "completed");
  }
  const pageMetadata = await Promise.all(pageFiles.map(pngMetadata));
  const actualDimensions = pageMetadata.map((metadata, index) => ({
    file: plan.pages[index].outputFile,
    width: metadata.width,
    height: metadata.height,
  }));
  const hashes = pageMetadata.map((metadata, index) => ({
    file: plan.pages[index].outputFile,
    sha256: metadata.sha256,
  }));
  const evaluator = {
    type: "multimodal-agent",
    provider: response.provider,
    model: response.model,
    rubric: "references/eval-contract.md",
    anchorPage: externalAnchor ? null : plan.pages[0].outputFile,
    externalAnchor: continuityAnchorAsset?.file || null,
    externalReferences: orderedExternalAssets,
  };
  const evalReport = buildEvalReport({
    subjective: response.data,
    plan,
    input,
    visualLock,
    characterBible,
    actualDimensions,
    evaluator,
    hashes,
    letteringReport,
  });
  const diagnosis = buildDiagnosis({ evalReport, plan });
  await writeJsonAtomic(path.join(runDir, "eval-report.json"), evalReport);
  await writeJsonAtomic(path.join(runDir, "diagnosis.json"), diagnosis);
  await updateResult(runDir, {
    ...resultBefore,
    status: evalReport.status === "pass" && diagnosis.status === "no-material-failure" ? "reviewed" : "needs-review",
    error: null,
  });
  const report = runValidator();
  await addDebugEvent("evaluate", "completed", {
    evalStatus: evalReport.status,
    diagnosisStatus: diagnosis.status,
    validatorWarnings: report.warnings || [],
  });
}

async function prepareInput() {
  const input = await readJson(inputPath);
  if (input.version !== 3) throw new Error("input.version must be 3");
  const existing = await readJsonIfExists(path.join(runDir, "input.json"));
  if (existing && !sameJson(existing, input)) {
    throw new Error("The supplied --input does not match the existing run input; use a new --run-dir.");
  }
  await writeJsonAtomic(path.join(runDir, "input.json"), input);
  return input;
}

async function collectGeneratedEvidence(plan, input) {
  const pages = [];
  const actualDimensions = [];
  for (const page of plan?.pages || []) {
    const file = input?.output?.textStrategy === "post-layout" ? postLayoutSourceFile(page) : page.outputFile;
    try {
      const metadata = await pngMetadata(path.join(runDir, file));
      pages.push(file);
      actualDimensions.push({
        file,
        width: metadata.width,
        height: metadata.height,
      });
    } catch {
      // A failed run may stop before later pages exist. Preserve only measured files.
    }
  }
  return { pages, actualDimensions };
}

function buildComposeFailureDiagnosis(error, plan) {
  const message = serializeError(error);
  const contractFailure = message.includes("POST_LAYOUT_CONTRACT") || message.includes("POST_LAYOUT_PLAN_STALE");
  return {
    version: 3,
    status: "action-required",
    comparisons: (plan?.pages || []).map((page, index) => ({
      pageId: page.id,
      contractFile: `lettering-plan.json#pages[${index}]`,
      promptFile: page.promptFile,
      outputFile: page.outputFile,
      promptAudit: "pass",
      outputEval: "fail",
    })),
    issues: [{
      issueId: contractFailure ? "post-layout-contract-invalid" : "post-layout-runtime-failed",
      evalPath: null,
      faultDomain: contractFailure ? "contract" : "runtime",
      evidence: {
        contract: "The immutable provider source images are preserved separately from final deliverables.",
        prompt: "No image prompt or story change is implied by a deterministic composition failure.",
        output: message,
        evalFinding: "Composition stopped before a complete lettered deliverable set was available.",
      },
      responsibleArtifact: contractFailure ? "lettering-plan.json" : "post-layout compositor/runtime",
      recommendedChange: contractFailure
        ? "Correct the structured lettering plan without changing the user's required text or lowering validation rules."
        : "Repair the compositor, bundled font, or runtime dependency, then resume composition without repeating paid image generation.",
      autoAction: "none",
    }],
    observations: ["Diagnosis is deterministic and does not authorize a new image-model call."],
  };
}

function buildGenerationFailureDiagnosis(error, plan) {
  const message = serializeError(error);
  const outputMismatch = message.includes("PROVIDER_OUTPUT_DIMENSION_MISMATCH");
  const routeCapabilityFailure = message.includes("IMAGE_ROUTE_");
  const faultDomain = outputMismatch ? "model-execution" : "runtime";
  const issueId = outputMismatch
    ? "provider-output-dimension-mismatch"
    : routeCapabilityFailure
      ? "image-route-capability-preflight-failed"
      : "generation-runtime-failed";
  const recommendedChange = outputMismatch
    ? "Inspect the provider response for the same provider/model/operation/size. Do not change the story, prompt contract, aspect requirement, or Eval threshold; authorize another paid call only after the route capability is corrected or re-verified."
    : routeCapabilityFailure
      ? "Select or verify an image route whose executable dimension control, required generation/edit operations, and quality mapping satisfy this plan before authorizing any image call."
      : "Inspect the runtime/provider error and retry only when the cause is transient; do not weaken the comic contract or automatically spend on a redraw.";
  return {
    version: 3,
    status: "action-required",
    comparisons: (plan?.pages || []).map((page, index) => ({
      pageId: page.id,
      contractFile: `comic-plan.json#pages[${index}]`,
      promptFile: page.promptFile,
      outputFile: page.outputFile,
      promptAudit: "pass",
      outputEval: "fail",
    })),
    issues: [{
      issueId,
      evalPath: null,
      faultDomain,
      evidence: {
        contract: "comic-plan.json and compiled prompts passed deterministic validation before generation.",
        prompt: "No prompt or content-contract change is implied by this runtime failure.",
        output: message,
        evalFinding: "Generation stopped before a publishable, dimension-compliant page set was available.",
      },
      responsibleArtifact: outputMismatch ? "images/" : "image route/runtime",
      recommendedChange,
      autoAction: "none",
    }],
    observations: ["Diagnosis is deterministic and read-only. It does not authorize a paid retry or redraw."],
  };
}

async function markFailed(stage, error, input, plan = null) {
  const current = await readJsonIfExists(path.join(runDir, "result.json"));
  const result = {
    status: "failed",
    stage,
    error: serializeError(error),
  };
  if (plan) {
    result.pageCount = plan.pageCount;
    result.aspectRatio = plan.aspectRatio;
    result.contentPackage = {
      story: "story.json",
      characters: "character-bible.json",
      copywriting: "copywriting.json",
    };
    if (input?.output?.exactSize) result.exactSize = input.output.exactSize;
    if (stage === "generate") {
      const measured = await collectGeneratedEvidence(plan, input);
      if (input?.output?.textStrategy === "post-layout") {
        result.sourcePages = measured.pages.length > 0 ? measured.pages : current?.sourcePages;
        result.sourceActualDimensions = measured.actualDimensions.length > 0 ? measured.actualDimensions : current?.sourceActualDimensions;
        result.letteringPlan = "lettering-plan.json";
      } else {
        const preservedPages = measured.pages.length > 0 ? measured.pages : current?.pages;
        const preservedDimensions = measured.actualDimensions.length > 0 ? measured.actualDimensions : current?.actualDimensions;
        result.pages = Array.isArray(preservedPages) && preservedPages.length > 0 ? preservedPages : undefined;
        result.actualDimensions = Array.isArray(preservedDimensions) && preservedDimensions.length > 0
          ? preservedDimensions
          : undefined;
      }
      await writeJsonAtomic(path.join(runDir, "diagnosis.json"), buildGenerationFailureDiagnosis(error, plan));
    } else if (stage === "compose") {
      const measured = await collectGeneratedEvidence(plan, input);
      result.sourcePages = measured.pages.length > 0 ? measured.pages : current?.sourcePages;
      result.sourceActualDimensions = measured.actualDimensions.length > 0 ? measured.actualDimensions : current?.sourceActualDimensions;
      result.letteringPlan = "lettering-plan.json";
      result.pages = undefined;
      result.actualDimensions = undefined;
      result.letteringReport = undefined;
      await writeJsonAtomic(path.join(runDir, "diagnosis.json"), buildComposeFailureDiagnosis(error, plan));
    } else {
      result.pages = undefined;
      result.actualDimensions = undefined;
    }
  }
  await updateResult(runDir, result);
  await addDebugEvent(stage, "failed", { error: serializeError(error) });
}

async function main() {
  if (!args.resume && ["plan", "all"].includes(args.stage) && await directoryHasEntries(runDir)) {
    throw new Error("Run directory is not empty. Use --resume to continue or choose a new --run-dir.");
  }
  const input = await readJson(inputPath);
  await initializeRunArtifacts({
    runDir,
    stage: args.stage,
    resume: args.resume || !["plan", "all"].includes(args.stage),
    inputPath,
    now: now(),
  });
  await prepareInput();
  await updateDebug(runDir, { contentMode: input.mode });
  const styleCatalog = await readJson(styleCatalogPath);

  const stages = args.stage === "all" ? ["plan", "generate", "compose", "evaluate"] : [args.stage];
  for (const stage of stages) {
    try {
      if (stage === "plan") await runPlan(input, styleCatalog);
      if (stage === "generate") await runGenerate(input);
      if (stage === "compose") await runCompose(input);
      if (stage === "evaluate") await runEvaluate(input);
    } catch (error) {
      if (stage === "evaluate") {
        await updateResult(runDir, {
          ...(await readJson(path.join(runDir, "result.json"))),
          status: "generated",
          error: null,
        });
        await addDebugEvent("evaluate", "blocked", { error: serializeError(error) });
      } else {
        const plan = await readJsonIfExists(path.join(runDir, "comic-plan.json"));
        await markFailed(stage, error, input, plan);
      }
      throw error;
    }
  }
  const finalResult = await readJson(path.join(runDir, "result.json"));
  console.log(JSON.stringify({ ok: true, runDir, result: finalResult }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, runDir, error: serializeError(error) }, null, 2));
  process.exit(1);
});
