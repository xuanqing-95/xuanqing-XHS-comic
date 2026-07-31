import { writeFile } from "node:fs/promises";
import path from "node:path";

import { compilePagePrompts, validatePlannerPackage } from "./compile-prompts.mjs";
import { buildLetteringPlan } from "./post-layout.mjs";
import { loadRoute, runJsonChat } from "./provider-clients.mjs";
import { updateDebug, updateResult, writeJsonAtomic } from "./run-artifacts.mjs";
import { stableHash } from "./usage-contract.mjs";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function usesSuppliedStory(input) {
  if (input?.mode === "story-to-comic") return true;
  if (input?.mode !== "series-continuation") return false;
  return nonEmptyString(input?.source?.story) || nonEmptyString(input?.source?.draft);
}

function resolvePreset(input, styleCatalog) {
  if (input?.visual?.styleMode !== "preset") return null;
  return (styleCatalog?.presets ?? []).find((entry) => entry.id === input?.visual?.preset) ?? null;
}

function wrapNonEmptyStringAsArray(value) {
  if (Array.isArray(value)) return value;
  if (nonEmptyString(value)) return [value.trim()];
  return value;
}

function normalizeCompositionFreedom(comicPlan) {
  if (!comicPlan || typeof comicPlan !== "object" || Array.isArray(comicPlan)) return;
  const panels = Array.isArray(comicPlan.pages)
    ? comicPlan.pages.flatMap((page) => Array.isArray(page?.panels) ? page.panels : [])
    : [];
  if (panels.length === 0) return;
  const hasDirection = panels.some((panel) => nonEmptyString(panel?.direction));
  const accepted = comicPlan.compositionFreedom === "model-arranged"
    || comicPlan.compositionFreedom === "director-locked";
  if (!accepted || (comicPlan.compositionFreedom === "model-arranged" && hasDirection)) {
    comicPlan.compositionFreedom = hasDirection ? "director-locked" : "model-arranged";
  }
}

function normalizePageFiles(comicPlan) {
  if (!comicPlan || typeof comicPlan !== "object" || Array.isArray(comicPlan)) return;
  if (!Array.isArray(comicPlan.pages)) return;
  comicPlan.pages.forEach((page, index) => {
    if (!page || typeof page !== "object" || Array.isArray(page)) return;
    const number = String(index + 1).padStart(2, "0");
    page.promptFile = `prompts/${number}.md`;
    page.outputFile = `images/${number}.png`;
  });
}

function plannerContractFacts(input, styleCatalog) {
  const suppliedStory = usesSuppliedStory(input);
  const preset = resolvePreset(input, styleCatalog);
  return {
    topicAngles: suppliedStory
      ? {
          version: 3,
          status: "skipped",
          angles: [],
          selectedAngleId: null,
          selectionReason: null,
          skipReason: "用户已提供可直接改编的故事，因此跳过传播角度生成。",
        }
      : {
          version: 3,
          status: "generated",
          angles: "exactly 3 complete angle objects",
          selectedAngleId: "one generated angle id",
          selectionReason: "non-empty string",
          skipReason: null,
        },
    storySourceMode: suppliedStory ? "user-supplied" : "generated",
    seriesMode: input?.mode === "series-continuation" || input?.series?.enabled === true,
    presetStyle: preset ? { presetId: preset.id, ...structuredClone(preset.lock) } : null,
  };
}

/**
 * Canonicalize only values already determined by the accepted input contract.
 * Narrative judgments such as emotionalCurve remain the planner's responsibility.
 */
export function normalizePlannerPackage(pkg, input, styleCatalog) {
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) return pkg;
  const normalized = structuredClone(pkg);
  const suppliedStory = usesSuppliedStory(input);

  if (suppliedStory && normalized.topicAngles && typeof normalized.topicAngles === "object" &&
      !Array.isArray(normalized.topicAngles)) {
    normalized.topicAngles = {
      version: 3,
      status: "skipped",
      angles: [],
      selectedAngleId: null,
      selectionReason: null,
      skipReason: "用户已提供可直接改编的故事，因此跳过传播角度生成。",
    };
  }

  if (normalized.story && typeof normalized.story === "object" && !Array.isArray(normalized.story)) {
    normalized.story.sourceMode = suppliedStory ? "user-supplied" : "generated";
  }

  if (normalized.characterBible && typeof normalized.characterBible === "object" &&
      !Array.isArray(normalized.characterBible)) {
    normalized.characterBible.seriesMode =
      input?.mode === "series-continuation" || input?.series?.enabled === true;
    for (const character of normalized.characterBible.characters ?? []) {
      if (!character || typeof character !== "object" || Array.isArray(character)) continue;
      if (character.immutable && typeof character.immutable === "object" &&
          !Array.isArray(character.immutable) && Number.isFinite(character.immutable.age)) {
        character.immutable.age = String(character.immutable.age);
      }
      character.expressionRange = wrapNonEmptyStringAsArray(character.expressionRange);
      character.signatureActions = wrapNonEmptyStringAsArray(character.signatureActions);
      character.forbiddenChanges = wrapNonEmptyStringAsArray(character.forbiddenChanges);
    }
  }

  const preset = resolvePreset(input, styleCatalog);
  if (preset && normalized.visualLock && typeof normalized.visualLock === "object" &&
      !Array.isArray(normalized.visualLock)) {
    normalized.visualLock.style = {
      presetId: preset.id,
      ...structuredClone(preset.lock),
    };
  }

  normalizeCompositionFreedom(normalized.comicPlan);
  normalizePageFiles(normalized.comicPlan);

  return normalized;
}

export function buildPlannerPrompt(input, styleCatalog) {
  const contractFacts = plannerContractFacts(input, styleCatalog);
  return `You are the planning engine for an executable social-comic production run.\n` +
    `Return one strict JSON object and no Markdown. Your output will be rejected unless every contract field is complete.\n\n` +
    `USER INPUT\n${JSON.stringify(input, null, 2)}\n\n` +
    `STYLE CATALOG\n${JSON.stringify(styleCatalog, null, 2)}\n\n` +
    `INPUT-DETERMINED CONTRACT FACTS\n${JSON.stringify(contractFacts, null, 2)}\n` +
    `These facts come from validated input, not creative judgment. Return values consistent with them. The runtime will canonicalize these exact fields before validation.\n\n` +
    `Return exactly these six top-level keys: topicAngles, story, characterBible, comicPlan, visualLock, copywriting. ` +
    `Every artifact must have version 3.\n\n` +
    `REQUIRED JSON SHAPES\n` +
    `- topicAngles: {version, status, angles, selectedAngleId, selectionReason, skipReason}. A generated angle requires id, title, audienceTension, conflict, emotion, turn, comicFit.\n` +
    `- story: {version, sourceMode, title, logline, coreMessage, summary, structure, emotionalCurve, claims, sourceFaithfulness}. structure requires hook, escalation, turn, resolution, endingHook.\n` +
    `- characterBible: {version, seriesMode, characters, relationships, seriesAssets}.\n` +
    `- comicPlan: {version, title, coreMessage, compositionFreedom, compositionReason, pageCount, countReason, aspectRatio, quality, textStrategy, generationStrategy, pages}.\n` +
    `- visualLock: {version, lockId, sourceCharacterBible, style, characters, output, referenceImages}.\n` +
    `- copywriting: {version, platform, titleCandidates, summary, pullQuotes, tags, seriesNames, cta}.\n\n` +
    `CONTENT RULES\n` +
    `- Follow INPUT-DETERMINED CONTRACT FACTS exactly. For topic-led planning, create exactly three distinct angles and select one. For supplied-story planning, preserve the supplied story and do not invent angles.\n` +
    `- emotionalCurve must be an array containing at least two non-empty, story-specific emotional states in narrative order. Derive it from the actual story; never omit it, return an empty array, or use generic placeholder values.\n` +
    `- claims must be an array, including [] when the story makes no claims needing review.\n` +
    `- CharacterBible requires seriesMode, at least one reproducible character, relationships, and seriesAssets. characterBible.seriesMode must equal INPUT-DETERMINED CONTRACT FACTS.seriesMode exactly.\n` +
    `- Each character requires id, role, personality, immutable.age/face/hair/body/outfit/signatureColors/recurringProps, expressionRange, signatureActions, forbiddenChanges, referenceImages. expressionRange, signatureActions, forbiddenChanges, and referenceImages must be JSON arrays, never prose strings. Every immutable field must be a non-empty string or a non-empty array of strings. Write age as a descriptive string such as "30岁" or "成年", never as a JSON number.\n` +
    `- Copywriting requires platform, exactly 5 titleCandidates, summary, exactly 3 pullQuotes, exactly 10 tags, exactly 3 seriesNames, cta.\n\n` +
    `COMIC PLAN RULES\n` +
    `- Derive page and panel counts from the content when countMode is auto. Do not default to a fixed number. Honor totalPanelCount exactly when user-fixed.\n` +
    `- Each page is one directly generated standalone 3:4 final comic image containing its own panels, borders, bubbles/captions, actions, and readable flow. Never plan naked illustrations or later cropping/stitching.\n` +
    `- comicPlan requires title, coreMessage, compositionFreedom, compositionReason, pageCount, countReason, aspectRatio 3:4, quality, textStrategy, generationStrategy, pages. compositionFreedom must be exactly "model-arranged" or "director-locked", with no translated label or extra explanation.\n` +
    `- If textStrategy is post-layout, compositionFreedom must be director-locked. Every page must add textPlacements with exactly one item for each requiredText index: id, requiredTextIndex, exact text, panelId, kind title|speech|thought|caption, tail none|left|right, and a non-overlapping normalized integer box x/y/width/height on a 0..1000 page. Keep boxes at least 100x60 and inside the page. Panel directions must keep faces, bodies, props, borders, and important detail outside those boxes.\n` +
    `- If textStrategy is native, omit textPlacements.\n` +
    `- generationStrategy is reference-parallel, anchor-first-fanout, local-identity-lock, or style-lock-parallel. Choose based on actual identity/reference needs.\n` +
    `- Each page requires id, purpose, change, scene, panelCount, panels, requiredText, promptFile, outputFile. Page 1 must use promptFile "prompts/01.md" and outputFile "images/01.png"; page 2 must use "prompts/02.md" and "images/02.png"; continue with the same zero-padded index. Do not translate, rename, or add prefixes to these paths.\n` +
    `- Each panel requires id, change, action, emotion, dialogue array, and direction. If any panel has a non-empty direction, compositionFreedom must be "director-locked" and every panel needs a direction. For "model-arranged", every panel direction must be null.\n` +
    `- requiredText contains only exact title/dialogue/narration that must render; it is not a whitelist of harmless environmental marks.\n` +
    `- Omit exactSize everywhere unless input.output.exactSize exists. If it exists, copy it unchanged to comicPlan.exactSize and visualLock.output.exactSize.\n\n` +
    `VISUAL LOCK RULES\n` +
    `- visualLock requires lockId, sourceCharacterBible character-bible.json, style, characters, output, referenceImages.\n` +
    `- Preset mode: copy every selected preset lock field exactly, not merely the preset name.\n` +
    `- Custom/reference modes: compile an equally complete style object with medium, line, palette, lighting, background, pageGrammar, characterDesign, typography, avoid.\n` +
    `- visualLock.characters must repeat every character id and immutable object exactly.\n` +
    `- Use the user's references and series anchors; do not invent file paths.\n` +
    `- Preserve the user's topic/story, coreMessage, tone, platform, and safety boundaries. Use concise natural Simplified Chinese when language is zh-CN.`;
}

async function writePlannerArtifacts(runDir, pkg) {
  const artifacts = {
    "topic-angles.json": pkg.topicAngles,
    "story.json": pkg.story,
    "character-bible.json": pkg.characterBible,
    "comic-plan.json": pkg.comicPlan,
    "visual-lock.json": pkg.visualLock,
    "copywriting.json": pkg.copywriting,
  };
  for (const [file, value] of Object.entries(artifacts)) {
    await writeJsonAtomic(path.join(runDir, file), value);
  }
}

export function createPlanStage(context) {
  const {
    args, runDir, addDebugEvent, requireAuthorized, modelCallIntent, callIdFor,
    recordUsage, completedModelCall, failedModelCall, runValidator,
  } = context;

  return async function runPlan(input, styleCatalog) {
    await addDebugEvent("plan", "running");
    requireAuthorized(args.plannerRouteJson, "--planner-route-json", "Planning");
    const route = await loadRoute(args.plannerRouteJson, "text");
    const prompt = buildPlannerPrompt(input, styleCatalog);
    const intent = modelCallIntent({
      callId: callIdFor("plan"),
      role: "planner",
      stage: "plan",
      operation: "chat",
      inputHash: stableHash(prompt),
    });
    await recordUsage(intent);
    let response;
    try {
      response = await runJsonChat({ route, prompt, timeoutMs: args.timeoutMs });
      await recordUsage(completedModelCall(intent, response, stableHash(response.data)));
    } catch (error) {
      await recordUsage(failedModelCall(intent, error));
      throw error;
    }

    const plannerPackage = normalizePlannerPackage(response.data, input, styleCatalog);
    const plannerErrors = validatePlannerPackage(plannerPackage, input, styleCatalog);
    if (plannerErrors.length > 0) throw new Error(`Planner output failed its contract:\n${plannerErrors.join("\n")}`);
    await writePlannerArtifacts(runDir, plannerPackage);
    const letteringPlan = buildLetteringPlan(plannerPackage.comicPlan);
    if (letteringPlan) await writeJsonAtomic(path.join(runDir, "lettering-plan.json"), letteringPlan);
    const compiled = compilePagePrompts({
      input,
      plan: plannerPackage.comicPlan,
      visualLock: plannerPackage.visualLock,
      characterBible: plannerPackage.characterBible,
    });
    for (const prompt of compiled) await writeFile(path.join(runDir, prompt.file), prompt.content, "utf8");

    const plan = plannerPackage.comicPlan;
    const result = {
      status: "planned",
      pageCount: plan.pageCount,
      aspectRatio: plan.aspectRatio,
      contentPackage: { story: "story.json", characters: "character-bible.json", copywriting: "copywriting.json" },
    };
    if (input.output?.exactSize) result.exactSize = input.output.exactSize;
    await updateResult(runDir, result);
    await updateDebug(runDir, {
      contentMode: input.mode,
      generationStrategy: plan.generationStrategy,
      anchorPageId: plan.generationStrategy === "anchor-first-fanout" ? plan.pages[0].id : undefined,
    });
    const report = runValidator();
    await addDebugEvent("plan", "completed", { validatorWarnings: report.warnings || [] });
  };
}
