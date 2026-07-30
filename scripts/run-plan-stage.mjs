import { writeFile } from "node:fs/promises";
import path from "node:path";

import { compilePagePrompts, validatePlannerPackage } from "./compile-prompts.mjs";
import { buildLetteringPlan } from "./post-layout.mjs";
import { loadRoute, runJsonChat } from "./provider-clients.mjs";
import { updateDebug, updateResult, writeJsonAtomic } from "./run-artifacts.mjs";
import { stableHash } from "./usage-contract.mjs";

function buildPlannerPrompt(input, styleCatalog) {
  return `You are the planning engine for an executable social-comic production run.\n` +
    `Return one strict JSON object and no Markdown. Your output will be rejected unless every contract field is complete.\n\n` +
    `USER INPUT\n${JSON.stringify(input, null, 2)}\n\n` +
    `STYLE CATALOG\n${JSON.stringify(styleCatalog, null, 2)}\n\n` +
    `Return exactly these six top-level keys: topicAngles, story, characterBible, comicPlan, visualLock, copywriting. ` +
    `Every artifact must have version 3.\n\n` +
    `CONTENT RULES\n` +
    `- For topic-to-comic, create exactly three distinct angles and select one. For supplied-story modes, preserve the story and mark topicAngles skipped.\n` +
    `- Story requires sourceMode, title, logline, coreMessage, summary, structure.hook/escalation/turn/resolution/endingHook, emotionalCurve, claims, sourceFaithfulness.\n` +
    `- CharacterBible requires seriesMode, at least one reproducible character, relationships, and seriesAssets. Each character requires id, role, personality, immutable.age/face/hair/body/outfit/signatureColors/recurringProps, expressionRange, signatureActions, forbiddenChanges, referenceImages.\n` +
    `- Copywriting requires platform, exactly 5 titleCandidates, summary, exactly 3 pullQuotes, exactly 10 tags, exactly 3 seriesNames, cta.\n\n` +
    `COMIC PLAN RULES\n` +
    `- Derive page and panel counts from the content when countMode is auto. Do not default to a fixed number. Honor totalPanelCount exactly when user-fixed.\n` +
    `- Each page is one directly generated standalone 3:4 final comic image containing its own panels, borders, bubbles/captions, actions, and readable flow. Never plan naked illustrations or later cropping/stitching.\n` +
    `- comicPlan requires title, coreMessage, compositionFreedom, compositionReason, pageCount, countReason, aspectRatio 3:4, quality, textStrategy, generationStrategy, pages.\n` +
    `- If textStrategy is post-layout, compositionFreedom must be director-locked. Every page must add textPlacements with exactly one item for each requiredText index: id, requiredTextIndex, exact text, panelId, kind title|speech|thought|caption, tail none|left|right, and a non-overlapping normalized integer box x/y/width/height on a 0..1000 page. Keep boxes at least 100x60 and inside the page. Panel directions must keep faces, bodies, props, borders, and important detail outside those boxes.\n` +
    `- If textStrategy is native, omit textPlacements.\n` +
    `- generationStrategy is reference-parallel, anchor-first-fanout, local-identity-lock, or style-lock-parallel. Choose based on actual identity/reference needs.\n` +
    `- Each page requires id, purpose, change, scene, panelCount, panels, requiredText, promptFile prompts/NN.md, outputFile images/NN.png.\n` +
    `- Each panel requires id, change, action, emotion, dialogue array, and direction. direction may be null only for model-arranged.\n` +
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

    const plannerErrors = validatePlannerPackage(response.data, input, styleCatalog);
    if (plannerErrors.length > 0) throw new Error(`Planner output failed its contract:\n${plannerErrors.join("\n")}`);
    await writePlannerArtifacts(runDir, response.data);
    const letteringPlan = buildLetteringPlan(response.data.comicPlan);
    if (letteringPlan) await writeJsonAtomic(path.join(runDir, "lettering-plan.json"), letteringPlan);
    const compiled = compilePagePrompts({
      input,
      plan: response.data.comicPlan,
      visualLock: response.data.visualLock,
      characterBible: response.data.characterBible,
    });
    for (const prompt of compiled) await writeFile(path.join(runDir, prompt.file), prompt.content, "utf8");

    const plan = response.data.comicPlan;
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
