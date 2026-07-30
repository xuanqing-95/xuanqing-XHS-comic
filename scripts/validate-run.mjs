#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReferenceAssets } from "./reference-assets.mjs";
import {
  buildLetteringPlan,
  validatePostLayoutPlan,
} from "./post-layout.mjs";
import { validateRunOutputs } from "./validate-run-output.mjs";
import { validateRunReview } from "./validate-run-review.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const stylePresetFile = path.join(scriptDir, "..", "references", "style-presets.json");
let stylePresets = [];
try {
  const catalog = JSON.parse(fs.readFileSync(stylePresetFile, "utf8"));
  stylePresets = Array.isArray(catalog.presets) ? catalog.presets : [];
} catch (error) {
  console.error(`Invalid style preset catalog: ${error.message}`);
  process.exit(2);
}
const stylePresetById = new Map(stylePresets.map((preset) => [preset.id, preset]));

const runDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!runDir) {
  console.error("Usage: node scripts/validate-run.mjs <run-dir>");
  process.exit(2);
}

const errors = [];
const warnings = [];

function readJson(relativePath, required = true) {
  const absolutePath = path.join(runDir, relativePath);
  if (!fs.existsSync(absolutePath)) {
    if (required) errors.push(`Missing ${relativePath}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    errors.push(`Invalid JSON in ${relativePath}: ${error.message}`);
    return null;
  }
}

function requireVersion3(value, field) {
  if (value?.version !== 3) errors.push(`${field}.version must be 3`);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} must be a non-empty string`);
  }
}

function pageRequiredText(page) {
  if (Array.isArray(page?.requiredText)) return page.requiredText;
  if (Array.isArray(page?.allowedText)) return page.allowedText;
  return null;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateExactSize(value, field) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${field} must be an object with width and height`);
    return null;
  }
  if (!Number.isInteger(value.width) || value.width < 1 || !Number.isInteger(value.height) || value.height < 1) {
    errors.push(`${field}.width and ${field}.height must be positive integers`);
    return null;
  }
  if (value.width * 4 !== value.height * 3) {
    errors.push(`${field} must be an exact 3:4 size`);
    return null;
  }
  return { width: value.width, height: value.height };
}

function isProviderNativeThreeFour(width, height) {
  const scale = Math.round(((width / 3) + (height / 4)) / 2);
  return width < height && Math.abs(width - (scale * 3)) <= 1 && Math.abs(height - (scale * 4)) <= 1;
}

function collectStringLeaves(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringLeaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStringLeaves);
  return [];
}

const catalogPresetIds = new Set();
for (const [index, preset] of stylePresets.entries()) {
  requireString(preset.id, `style-presets.presets[${index}].id`);
  requireString(preset.nameZh, `style-presets.presets[${index}].nameZh`);
  requireString(preset.description, `style-presets.presets[${index}].description`);
  if (catalogPresetIds.has(preset.id)) errors.push(`Duplicate style preset id: ${preset.id}`);
  catalogPresetIds.add(preset.id);
  for (const field of ["medium", "line", "lighting", "background", "pageGrammar", "characterDesign", "typography"]) {
    requireString(preset.lock?.[field], `style-presets.presets[${index}].lock.${field}`);
  }
  for (const field of ["palette", "avoid"]) {
    if (!Array.isArray(preset.lock?.[field]) || preset.lock[field].length < 1) {
      errors.push(`style-presets.presets[${index}].lock.${field} must be a non-empty array`);
    }
  }
}

function fileExists(relativePath, field) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    errors.push(`${field} must be a non-empty path`);
    return false;
  }
  if (!fs.existsSync(path.join(runDir, relativePath))) {
    errors.push(`Missing ${field}: ${relativePath}`);
    return false;
  }
  return true;
}

function readPng(relativePath, field) {
  const absolutePath = path.join(runDir, relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  const bytes = fs.readFileSync(absolutePath);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    errors.push(`${field} is not a readable PNG: ${relativePath}`);
    return null;
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function fileSha256(relativePath) {
  const absolutePath = path.join(runDir, relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
}

const result = readJson("result.json");
const usage = readJson("usage.json");
const debug = readJson("debug.json");
const input = readJson("input.json");
const planningRequired = result?.status !== "failed";
const plan = readJson("comic-plan.json", planningRequired);
const visualLock = readJson("visual-lock.json", planningRequired);
const topicAngles = readJson("topic-angles.json", planningRequired);
const story = readJson("story.json", planningRequired);
const characterBible = readJson("character-bible.json", planningRequired);
const copywriting = readJson("copywriting.json", planningRequired);
const letteringPlan = readJson("lettering-plan.json", plan?.textStrategy === "post-layout");
const letteringReportRequired = plan?.textStrategy === "post-layout" && ["generated", "reviewed", "needs-review"].includes(result?.status);
const letteringReport = readJson("lettering-report.json", letteringReportRequired);
let requestedExactSize = null;

for (const [name, value] of Object.entries({
  input,
  topicAngles,
  story,
  characterBible,
  plan,
  visualLock,
  copywriting,
  letteringPlan,
  letteringReport,
  result,
  usage,
  debug,
})) {
  if (value) requireVersion3(value, name);
}

const allowedStrategies = new Set([
  "reference-parallel",
  "anchor-first-fanout",
  "local-identity-lock",
  "style-lock-parallel",
]);
const allowedResultStatuses = new Set([
  "planned",
  "generated-unlettered",
  "generated",
  "reviewed",
  "needs-review",
  "failed",
]);

if (result?.status === "failed") {
  requireString(result.stage, "result.stage");
  requireString(result.error, "result.error");
}

if (input) {
  if (!new Set(["topic-to-comic", "story-to-comic", "series-continuation"]).has(input.mode)) {
    errors.push("input.mode is unsupported");
  }
  if (!input.source || typeof input.source !== "object") errors.push("input.source must be an object");
  requireString(input.domain, "input.domain");
  requireString(input.audience, "input.audience");
  requireString(input.coreMessage, "input.coreMessage");
  requireString(input.tone, "input.tone");
  requireString(input.platform, "input.platform");
  requireString(input.language, "input.language");
  if (input.output?.aspectRatio !== "3:4") errors.push('input.output.aspectRatio must be "3:4"');
  requestedExactSize = validateExactSize(input.output?.exactSize, "input.output.exactSize");
  if (!new Set(["native", "post-layout"]).has(input.output?.textStrategy)) {
    errors.push("input.output.textStrategy must be native or post-layout");
  }
  if (!input.visual || typeof input.visual !== "object") {
    errors.push("input.visual must be an object");
  } else if (input.visual.styleMode !== undefined) {
    const styleMode = input.visual.styleMode;
    if (!new Set(["preset", "custom", "reference"]).has(styleMode)) {
      errors.push("input.visual.styleMode must be preset, custom, or reference");
    } else if (styleMode === "preset") {
      requireString(input.visual.preset, "input.visual.preset");
      if (typeof input.visual.preset === "string" && !stylePresetById.has(input.visual.preset)) {
        errors.push(`input.visual.preset is unknown: ${input.visual.preset}`);
      }
    } else if (styleMode === "custom") {
      requireString(input.visual.customStyle, "input.visual.customStyle");
    } else if (!Array.isArray(input.visual.referenceImages) || input.visual.referenceImages.length < 1) {
      errors.push("reference style mode requires at least one input.visual.referenceImages entry");
    }
  } else {
    requireString(input.visual.style, "input.visual.style");
  }
  if (input.visual && !Array.isArray(input.visual.referenceImages)) {
    errors.push("input.visual.referenceImages must be an array");
  }
  if (input.layout !== undefined) {
    if (!new Set(["auto", "user-fixed"]).has(input.layout?.countMode)) {
      errors.push("input.layout.countMode must be auto or user-fixed");
    }
    if (input.layout?.countMode === "user-fixed" && (!Number.isInteger(input.layout.totalPanelCount) || input.layout.totalPanelCount < 1)) {
      errors.push("user-fixed layout requires a positive input.layout.totalPanelCount");
    }
    if (
      input.layout?.preferredPanelsPerPage !== null &&
      input.layout?.preferredPanelsPerPage !== undefined &&
      (!Number.isInteger(input.layout.preferredPanelsPerPage) || input.layout.preferredPanelsPerPage < 1)
    ) {
      errors.push("input.layout.preferredPanelsPerPage must be null or a positive integer");
    }
  }
  if (input.mode === "topic-to-comic") requireString(input.source?.topic, "input.source.topic");
  if (input.mode === "story-to-comic" && ![input.source?.story, input.source?.draft].some((value) => typeof value === "string" && value.trim())) {
    errors.push("story-to-comic requires input.source.story or input.source.draft");
  }
}

if (topicAngles && input) {
  if (!new Set(["generated", "skipped"]).has(topicAngles.status)) {
    errors.push("topic-angles.status must be generated or skipped");
  }
  const shouldGenerateAngles = input.mode === "topic-to-comic" || (
    input.mode === "series-continuation" &&
    ![input.source?.story, input.source?.draft].some((value) => typeof value === "string" && value.trim())
  );
  if (shouldGenerateAngles && topicAngles.status !== "generated") {
    errors.push("topic-based input requires generated topic angles");
  }
  if (!shouldGenerateAngles && topicAngles.status !== "skipped") {
    errors.push("supplied-story input must skip angle invention unless the input mode changes");
  }
  if (topicAngles.status === "generated") {
    if (!Array.isArray(topicAngles.angles) || topicAngles.angles.length !== 3) {
      errors.push("generated topic-angles must contain exactly three angles");
    }
    const ids = new Set();
    for (const [index, angle] of (topicAngles.angles || []).entries()) {
      for (const field of ["id", "title", "audienceTension", "conflict", "emotion", "turn", "comicFit"]) {
        requireString(angle[field], `topic-angles.angles[${index}].${field}`);
      }
      if (ids.has(angle.id)) errors.push(`Duplicate topic angle id: ${angle.id}`);
      ids.add(angle.id);
    }
    if (!ids.has(topicAngles.selectedAngleId)) errors.push("topic-angles.selectedAngleId must reference one angle");
    requireString(topicAngles.selectionReason, "topic-angles.selectionReason");
  } else {
    if (!Array.isArray(topicAngles.angles) || topicAngles.angles.length !== 0) errors.push("skipped topic-angles must have an empty angles array");
    if (topicAngles.selectedAngleId !== null) errors.push("skipped topic-angles.selectedAngleId must be null");
    requireString(topicAngles.skipReason, "topic-angles.skipReason");
  }
}

if (story) {
  if (!new Set(["generated", "user-supplied"]).has(story.sourceMode)) errors.push("story.sourceMode is unsupported");
  for (const field of ["title", "logline", "coreMessage", "summary", "sourceFaithfulness"]) {
    requireString(story[field], `story.${field}`);
  }
  for (const field of ["hook", "escalation", "turn", "resolution", "endingHook"]) {
    requireString(story.structure?.[field], `story.structure.${field}`);
  }
  if (!Array.isArray(story.emotionalCurve) || story.emotionalCurve.length < 2) errors.push("story.emotionalCurve must contain at least two states");
  if (!Array.isArray(story.claims)) errors.push("story.claims must be an array");
  if (input?.coreMessage && story.coreMessage !== input.coreMessage) {
    warnings.push("story.coreMessage differs from input.coreMessage; sourceFaithfulness must explain the change");
  }
}

const characterIds = new Set();
if (characterBible) {
  if (typeof characterBible.seriesMode !== "boolean") errors.push("character-bible.seriesMode must be boolean");
  if (!Array.isArray(characterBible.characters) || characterBible.characters.length < 1) {
    errors.push("character-bible.characters must be a non-empty array");
  }
  for (const [index, character] of (characterBible.characters || []).entries()) {
    requireString(character.id, `character-bible.characters[${index}].id`);
    requireString(character.role, `character-bible.characters[${index}].role`);
    if (!character.immutable || typeof character.immutable !== "object") errors.push(`character-bible.characters[${index}].immutable must be an object`);
    for (const field of ["age", "face", "hair", "body", "outfit"]) {
      requireString(character.immutable?.[field], `character-bible.characters[${index}].immutable.${field}`);
    }
    if (characterIds.has(character.id)) errors.push(`Duplicate character id: ${character.id}`);
    characterIds.add(character.id);
    if (!Array.isArray(character.expressionRange)) errors.push(`character-bible.characters[${index}].expressionRange must be an array`);
    if (!Array.isArray(character.forbiddenChanges)) errors.push(`character-bible.characters[${index}].forbiddenChanges must be an array`);
  }
  if (!Array.isArray(characterBible.relationships)) errors.push("character-bible.relationships must be an array");
}

if (copywriting) {
  requireString(copywriting.platform, "copywriting.platform");
  requireString(copywriting.summary, "copywriting.summary");
  requireString(copywriting.cta, "copywriting.cta");
  for (const [field, length] of [["titleCandidates", 5], ["pullQuotes", 3], ["tags", 10], ["seriesNames", 3]]) {
    if (!Array.isArray(copywriting[field]) || copywriting[field].length !== length) {
      errors.push(`copywriting.${field} must contain exactly ${length} items`);
    }
  }
  if (input?.platform && copywriting.platform !== input.platform) warnings.push("copywriting.platform differs from input.platform");
}

if (plan) {
  requireString(plan.title, "comic-plan.title");
  requireString(plan.coreMessage, "comic-plan.coreMessage");
  requireString(plan.countReason, "comic-plan.countReason");
  requireString(plan.compositionReason, "comic-plan.compositionReason");
  if (!new Set(["model-arranged", "director-locked"]).has(plan.compositionFreedom)) {
    errors.push("comic-plan.compositionFreedom is unsupported");
  }
  if (!Number.isInteger(plan.pageCount) || plan.pageCount < 1) {
    errors.push("comic-plan.pageCount must be a positive integer");
  }
  if (!Array.isArray(plan.pages) || plan.pages.length < 1) {
    errors.push("comic-plan.pages must be a non-empty array");
  } else if (plan.pageCount !== plan.pages.length) {
    errors.push("comic-plan.pageCount must equal comic-plan.pages.length");
  }
  if (plan.aspectRatio !== "3:4") errors.push('comic-plan.aspectRatio must be "3:4"');
  const plannedExactSize = validateExactSize(plan.exactSize, "comic-plan.exactSize");
  if (requestedExactSize && !sameValue(plannedExactSize, requestedExactSize)) {
    errors.push("comic-plan.exactSize must match the user-requested input.output.exactSize");
  }
  if (!requestedExactSize && plan.exactSize !== undefined && plan.exactSize !== null) {
    errors.push("comic-plan.exactSize is allowed only when the user explicitly requests input.output.exactSize");
  }
  if (plan.width !== undefined || plan.height !== undefined) {
    warnings.push("comic-plan.width/height are legacy fields and do not create an exact-size requirement; use input.output.exactSize only for a user-requested pixel size");
  }
  if (!new Set(["native", "post-layout"]).has(plan.textStrategy)) {
    errors.push("comic-plan.textStrategy must be native or post-layout");
  }
  if (!allowedStrategies.has(plan.generationStrategy)) {
    errors.push("comic-plan.generationStrategy is unsupported");
  }
  errors.push(...validatePostLayoutPlan({ input, plan }));

  const plannedPanelTotal = (plan.pages || []).reduce((sum, page) => sum + (Number.isInteger(page.panelCount) ? page.panelCount : 0), 0);
  if (input?.layout?.countMode === "user-fixed" && plannedPanelTotal !== input.layout.totalPanelCount) {
    errors.push("sum of comic-plan page panel counts must equal input.layout.totalPanelCount for user-fixed layout");
  }

  const ids = new Set();
  const prompts = new Set();
  const outputs = new Set();
  for (const [index, page] of (plan.pages || []).entries()) {
    const prefix = `comic-plan.pages[${index}]`;
    requireString(page.id, `${prefix}.id`);
    requireString(page.purpose, `${prefix}.purpose`);
    requireString(page.change, `${prefix}.change`);
    requireString(page.scene, `${prefix}.scene`);
    if (ids.has(page.id)) errors.push(`Duplicate page id: ${page.id}`);
    ids.add(page.id);
    if (!Array.isArray(page.panels) || page.panels.length < 1) {
      errors.push(`${prefix}.panels must be a non-empty array`);
    } else if (page.panelCount !== page.panels.length) {
      errors.push(`${prefix}.panelCount must equal ${prefix}.panels.length`);
    }
    for (const [panelIndex, panel] of (page.panels || []).entries()) {
      requireString(panel.id, `${prefix}.panels[${panelIndex}].id`);
      requireString(panel.change, `${prefix}.panels[${panelIndex}].change`);
      requireString(panel.action, `${prefix}.panels[${panelIndex}].action`);
      requireString(panel.emotion, `${prefix}.panels[${panelIndex}].emotion`);
      if (!Array.isArray(panel.dialogue)) errors.push(`${prefix}.panels[${panelIndex}].dialogue must be an array`);
      if (plan.compositionFreedom === "director-locked") {
        requireString(panel.direction, `${prefix}.panels[${panelIndex}].direction`);
      }
    }
    if (page.requiredText !== undefined && page.allowedText !== undefined) {
      errors.push(`${prefix} must not define both requiredText and legacy allowedText`);
    }
    if (!pageRequiredText(page)) errors.push(`${prefix}.requiredText must be an array`);
    if (prompts.has(page.promptFile)) errors.push(`Duplicate prompt file: ${page.promptFile}`);
    prompts.add(page.promptFile);
    const promptExists = fileExists(page.promptFile, `${prefix}.promptFile`);
    if (promptExists) {
      const promptText = fs.readFileSync(path.join(runDir, page.promptFile), "utf8");
      const usesCurrentSizeContract = plan.width === undefined && plan.height === undefined;
      if (usesCurrentSizeContract && !promptText.includes("3:4")) {
        errors.push(`${prefix}.promptFile must request the 3:4 target aspect ratio`);
      }
      if (usesCurrentSizeContract && requestedExactSize) {
        const exactSizeText = `${requestedExactSize.width}x${requestedExactSize.height}`;
        const alternateExactSizeText = `${requestedExactSize.width}×${requestedExactSize.height}`;
        if (!promptText.includes(exactSizeText) && !promptText.includes(alternateExactSizeText)) {
          errors.push(`${prefix}.promptFile must carry the user-requested exact size ${exactSizeText}`);
        }
      }
      if (usesCurrentSizeContract && !requestedExactSize && /\b\d{2,5}\s*[x×]\s*\d{2,5}\b/.test(promptText)) {
        errors.push(`${prefix}.promptFile must not invent an exact pixel size when input.output.exactSize is absent`);
      }
      if (input?.visual?.styleMode === "preset") {
        const selectedPreset = stylePresetById.get(input.visual.preset);
        if (selectedPreset) {
        for (const requiredStyleText of collectStringLeaves(selectedPreset.lock)) {
          if (!promptText.includes(requiredStyleText)) {
            errors.push(`${prefix}.promptFile must carry preset field text: ${requiredStyleText}`);
          }
        }
        }
      }
    }
    if (outputs.has(page.outputFile)) errors.push(`Duplicate output file: ${page.outputFile}`);
    outputs.add(page.outputFile);
  }
}

if (plan?.textStrategy === "post-layout") {
  const expectedLetteringPlan = buildLetteringPlan(plan);
  if (!letteringPlan || !sameValue(letteringPlan, expectedLetteringPlan)) {
    errors.push("lettering-plan.json must exactly equal the deterministic post-layout compilation of comic-plan.json");
  }
  if (result?.letteringPlan !== undefined && result.letteringPlan !== "lettering-plan.json") {
    errors.push("result.letteringPlan must be lettering-plan.json");
  }
} else {
  if (letteringPlan) errors.push("lettering-plan.json is allowed only for post-layout");
  if (letteringReport) errors.push("lettering-report.json is allowed only for post-layout");
}

if (visualLock) {
  requireString(visualLock.lockId, "visual-lock.lockId");
  if (visualLock.sourceCharacterBible !== "character-bible.json") errors.push("visual-lock.sourceCharacterBible must be character-bible.json");
  if (!visualLock.style || typeof visualLock.style !== "object") errors.push("visual-lock.style must be an object");
  if (input?.visual?.styleMode === "preset") {
    const selectedPreset = stylePresetById.get(input.visual.preset);
    if (visualLock.style?.presetId !== input.visual.preset) {
      errors.push("visual-lock.style.presetId must match input.visual.preset");
    }
    if (selectedPreset) {
      for (const [field, value] of Object.entries(selectedPreset.lock || {})) {
        if (!sameValue(visualLock.style?.[field], value)) {
          errors.push(`visual-lock.style.${field} must match preset ${selectedPreset.id}`);
        }
      }
    }
  }
  if (!Array.isArray(visualLock.characters)) errors.push("visual-lock.characters must be an array");
  if (visualLock.output?.aspectRatio !== "3:4") errors.push('visual-lock.output.aspectRatio must be "3:4"');
  const lockedExactSize = validateExactSize(visualLock.output?.exactSize, "visual-lock.output.exactSize");
  if (requestedExactSize && !sameValue(lockedExactSize, requestedExactSize)) {
    errors.push("visual-lock.output.exactSize must match the user-requested input.output.exactSize");
  }
  if (!requestedExactSize && visualLock.output?.exactSize !== undefined && visualLock.output?.exactSize !== null) {
    errors.push("visual-lock.output.exactSize is allowed only when the user explicitly requests input.output.exactSize");
  }
  if (visualLock.output?.width !== undefined || visualLock.output?.height !== undefined) {
    warnings.push("visual-lock.output.width/height are legacy fields and do not create an exact-size requirement");
  }
  if (plan && visualLock.output?.textStrategy !== plan.textStrategy) {
    errors.push("visual-lock.output.textStrategy must match comic-plan.textStrategy");
  }
  const lockIds = new Set((visualLock.characters || []).map((character) => character.id));
  if (characterBible && (lockIds.size !== characterIds.size || [...characterIds].some((id) => !lockIds.has(id)))) {
    errors.push("visual-lock character ids must match character-bible character ids");
  }
  for (const [index, locked] of (visualLock.characters || []).entries()) {
    const source = characterBible?.characters?.find((character) => character.id === locked.id);
    if (source && JSON.stringify(locked.immutable) !== JSON.stringify(source.immutable)) {
      errors.push(`visual-lock.characters[${index}].immutable must match character-bible`);
    }
  }
}

if (input && visualLock && characterBible) {
  errors.push(...validateReferenceAssets({ input, visualLock, characterBible }));
}

const outputValidation = validateRunOutputs({
  result,
  plan,
  letteringReport,
  requestedExactSize,
  errors,
  warnings,
  allowedResultStatuses,
  fileExists,
  fileSha256,
  readJson,
  readPng,
  sameValue,
  validateExactSize,
  isProviderNativeThreeFour,
});

validateRunReview({
  result,
  plan,
  input,
  visualLock,
  characterBible,
  usage,
  debug,
  errors,
  warnings,
  readJson,
  requireVersion3,
  requireString,
  pageRequiredText,
  sameValue,
  outputValidation,
});

console.log(JSON.stringify({ valid: errors.length === 0, errors, warnings }, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
