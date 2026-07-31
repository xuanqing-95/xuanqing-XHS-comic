import {
  collectReferenceAssets,
  referenceAssetFile,
  validateReferenceAssets,
} from "./reference-assets.mjs";
import { validatePostLayoutPlan } from "./post-layout.mjs";

const TOP_LEVEL_KEYS = [
  "topicAngles",
  "story",
  "characterBible",
  "comicPlan",
  "visualLock",
  "copywriting",
];

const STYLE_FIELDS = [
  "medium",
  "line",
  "palette",
  "lighting",
  "background",
  "pageGrammar",
  "characterDesign",
  "typography",
  "avoid",
];

const PLAN_STRATEGIES = new Set([
  "reference-parallel",
  "anchor-first-fanout",
  "local-identity-lock",
  "style-lock-parallel",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addRequiredString(errors, value, field) {
  if (!nonEmptyString(value)) errors.push(`${field} must be a non-empty string`);
}

function addVersion3(errors, value, field) {
  if (!isObject(value) || value.version !== 3) errors.push(`${field}.version must be 3`);
}

function validateTopicAngles(errors, topicAngles, input) {
  addVersion3(errors, topicAngles, "topicAngles");
  if (!isObject(topicAngles)) return;

  const suppliedStory = nonEmptyString(input?.source?.story) || nonEmptyString(input?.source?.draft);
  const shouldGenerate = input?.mode === "topic-to-comic" || (input?.mode === "series-continuation" && !suppliedStory);

  if (shouldGenerate) {
    if (topicAngles.status !== "generated") errors.push("topicAngles.status must be generated for topic-led planning");
    if (!Array.isArray(topicAngles.angles) || topicAngles.angles.length !== 3) {
      errors.push("topicAngles.angles must contain exactly 3 angles for topic-led planning");
    }
    const ids = new Set();
    for (const [index, angle] of (topicAngles.angles ?? []).entries()) {
      const base = `topicAngles.angles[${index}]`;
      if (!isObject(angle)) {
        errors.push(`${base} must be an object`);
        continue;
      }
      for (const field of ["id", "title", "audienceTension", "conflict", "emotion", "turn", "comicFit"]) {
        addRequiredString(errors, angle[field], `${base}.${field}`);
      }
      if (nonEmptyString(angle.id)) {
        if (ids.has(angle.id)) errors.push(`${base}.id must be unique`);
        ids.add(angle.id);
      }
    }
    if (!ids.has(topicAngles.selectedAngleId)) {
      errors.push("topicAngles.selectedAngleId must identify one of the 3 generated angles");
    }
    addRequiredString(errors, topicAngles.selectionReason, "topicAngles.selectionReason");
  } else {
    if (topicAngles.status !== "skipped") errors.push("topicAngles.status must be skipped when a story is supplied");
    if (!Array.isArray(topicAngles.angles) || topicAngles.angles.length !== 0) {
      errors.push("topicAngles.angles must be empty when angle planning is skipped");
    }
    if (topicAngles.selectedAngleId !== null) errors.push("topicAngles.selectedAngleId must be null when skipped");
    addRequiredString(errors, topicAngles.skipReason, "topicAngles.skipReason");
  }
}

function validateStory(errors, story, input) {
  addVersion3(errors, story, "story");
  if (!isObject(story)) return;

  const suppliedStory = input?.mode === "story-to-comic" ||
    (input?.mode === "series-continuation" && (nonEmptyString(input?.source?.story) || nonEmptyString(input?.source?.draft)));
  const expectedSourceMode = suppliedStory ? "user-supplied" : "generated";
  if (story.sourceMode !== expectedSourceMode) {
    errors.push(`story.sourceMode must be ${expectedSourceMode} for input.mode ${input?.mode}`);
  }
  for (const field of ["title", "logline", "coreMessage", "summary", "sourceFaithfulness"]) {
    addRequiredString(errors, story[field], `story.${field}`);
  }
  if (!isObject(story.structure)) {
    errors.push("story.structure must be an object");
  } else {
    for (const field of ["hook", "escalation", "turn", "resolution", "endingHook"]) {
      addRequiredString(errors, story.structure[field], `story.structure.${field}`);
    }
  }
  if (!nonEmptyStringArray(story.emotionalCurve)) errors.push("story.emotionalCurve must be a non-empty string array");
  if (!Array.isArray(story.claims)) errors.push("story.claims must be an array");
}

function validateCharacterBible(errors, bible, input) {
  addVersion3(errors, bible, "characterBible");
  if (!isObject(bible)) return;
  if (bible.seriesMode !== (input?.mode === "series-continuation" || input?.series?.enabled === true)) {
    errors.push("characterBible.seriesMode must match the series input");
  }
  if (!Array.isArray(bible.characters) || bible.characters.length === 0) {
    errors.push("characterBible.characters must contain at least one character");
    return;
  }
  const ids = new Set();
  for (const [index, character] of bible.characters.entries()) {
    const base = `characterBible.characters[${index}]`;
    if (!isObject(character)) {
      errors.push(`${base} must be an object`);
      continue;
    }
    addRequiredString(errors, character.id, `${base}.id`);
    addRequiredString(errors, character.role, `${base}.role`);
    if (ids.has(character.id)) errors.push(`${base}.id must be unique`);
    ids.add(character.id);
    if (!isObject(character.immutable) || Object.keys(character.immutable).length === 0) {
      errors.push(`${base}.immutable must be a non-empty object`);
    } else {
      for (const [field, value] of Object.entries(character.immutable)) {
        if (!nonEmptyString(value) && !nonEmptyStringArray(value)) {
          errors.push(`${base}.immutable.${field} must be a non-empty string or string array`);
        }
      }
    }
    if (!nonEmptyStringArray(character.expressionRange)) {
      errors.push(`${base}.expressionRange must be a non-empty string array`);
    }
    if (!Array.isArray(character.forbiddenChanges)) errors.push(`${base}.forbiddenChanges must be an array`);
  }
}

function validatePlan(errors, plan, input) {
  addVersion3(errors, plan, "comicPlan");
  if (!isObject(plan)) return;
  for (const field of ["title", "coreMessage", "compositionReason", "countReason"]) {
    addRequiredString(errors, plan[field], `comicPlan.${field}`);
  }
  if (!new Set(["model-arranged", "director-locked"]).has(plan.compositionFreedom)) {
    errors.push("comicPlan.compositionFreedom must be model-arranged or director-locked");
  }
  if (!PLAN_STRATEGIES.has(plan.generationStrategy)) {
    errors.push("comicPlan.generationStrategy is invalid");
  }
  if (plan.aspectRatio !== input?.output?.aspectRatio || plan.aspectRatio !== "3:4") {
    errors.push("comicPlan.aspectRatio and input.output.aspectRatio must both be 3:4");
  }
  if (plan.textStrategy !== input?.output?.textStrategy) errors.push("comicPlan.textStrategy must match input.output.textStrategy");
  if (plan.quality !== input?.output?.quality) errors.push("comicPlan.quality must match input.output.quality");
  if (!Array.isArray(plan.pages) || plan.pages.length === 0) {
    errors.push("comicPlan.pages must contain at least one page");
    return;
  }
  if (plan.pageCount !== plan.pages.length) errors.push("comicPlan.pageCount must equal comicPlan.pages.length");
  if (Number.isInteger(input?.output?.pageCountCeiling) && plan.pages.length > input.output.pageCountCeiling) {
    errors.push("comicPlan.pageCount exceeds input.output.pageCountCeiling");
  }

  const pageIds = new Set();
  const panelIds = new Set();
  const promptFiles = new Set();
  const outputFiles = new Set();
  let totalPanels = 0;
  for (const [pageIndex, page] of plan.pages.entries()) {
    const base = `comicPlan.pages[${pageIndex}]`;
    if (!isObject(page)) {
      errors.push(`${base} must be an object`);
      continue;
    }
    for (const field of ["id", "purpose", "change", "scene", "promptFile", "outputFile"]) {
      addRequiredString(errors, page[field], `${base}.${field}`);
    }
    if (pageIds.has(page.id)) errors.push(`${base}.id must be unique`);
    pageIds.add(page.id);
    if (promptFiles.has(page.promptFile)) errors.push(`${base}.promptFile must be unique`);
    promptFiles.add(page.promptFile);
    if (outputFiles.has(page.outputFile)) errors.push(`${base}.outputFile must be unique`);
    outputFiles.add(page.outputFile);
    const expectedPromptFile = `prompts/${String(pageIndex + 1).padStart(2, "0")}.md`;
    const expectedOutputFile = `images/${String(pageIndex + 1).padStart(2, "0")}.png`;
    if (page.promptFile !== expectedPromptFile) errors.push(`${base}.promptFile must be ${expectedPromptFile}`);
    if (page.outputFile !== expectedOutputFile) errors.push(`${base}.outputFile must be ${expectedOutputFile}`);
    if (!Array.isArray(page.panels) || page.panels.length === 0) {
      errors.push(`${base}.panels must contain at least one panel`);
      continue;
    }
    if (page.panelCount !== page.panels.length) errors.push(`${base}.panelCount must equal ${base}.panels.length`);
    totalPanels += page.panels.length;
    for (const [panelIndex, panel] of page.panels.entries()) {
      const panelBase = `${base}.panels[${panelIndex}]`;
      if (!isObject(panel)) {
        errors.push(`${panelBase} must be an object`);
        continue;
      }
      for (const field of ["id", "change", "action", "emotion"]) {
        addRequiredString(errors, panel[field], `${panelBase}.${field}`);
      }
      if (panelIds.has(panel.id)) errors.push(`${panelBase}.id must be unique across the plan`);
      panelIds.add(panel.id);
      if (!Array.isArray(panel.dialogue) || !panel.dialogue.every(nonEmptyString)) {
        errors.push(`${panelBase}.dialogue must be an array of non-empty strings`);
      }
      if (panel.narration !== undefined && panel.narration !== null &&
          !nonEmptyString(panel.narration) &&
          !(Array.isArray(panel.narration) && panel.narration.every(nonEmptyString))) {
        errors.push(`${panelBase}.narration must be a non-empty string or an array of non-empty strings`);
      }
      if (plan.compositionFreedom === "director-locked") {
        addRequiredString(errors, panel.direction, `${panelBase}.direction`);
      } else if (panel.direction !== null && panel.direction !== undefined && panel.direction !== "") {
        errors.push(`${panelBase}.direction must be null for model-arranged composition`);
      }
    }
    if (!Array.isArray(page.requiredText) || !page.requiredText.every(nonEmptyString)) {
      errors.push(`${base}.requiredText must be an array of non-empty strings; an intentionally silent page may use []`);
    } else {
      const required = new Set(page.requiredText);
      for (const [panelIndex, panel] of page.panels.entries()) {
        for (const text of panelText(panel)) {
          if (!required.has(text)) {
            errors.push(`${base}.requiredText must include ${base}.panels[${panelIndex}] text ${JSON.stringify(text)}`);
          }
        }
      }
    }
  }
  if (input?.layout?.countMode === "user-fixed" && totalPanels !== input?.layout?.totalPanelCount) {
    errors.push("planned panel total must equal input.layout.totalPanelCount");
  }

  const exactSize = input?.output?.exactSize;
  if (exactSize !== undefined) {
    if (!isObject(exactSize) || !Number.isInteger(exactSize.width) || exactSize.width <= 0 || !Number.isInteger(exactSize.height) || exactSize.height <= 0) {
      errors.push("input.output.exactSize must contain positive integer width and height");
    } else if (!sameValue(plan.exactSize, exactSize)) {
      errors.push("comicPlan.exactSize must exactly match input.output.exactSize");
    }
  } else if (plan.exactSize !== undefined) {
    errors.push("comicPlan.exactSize is forbidden unless input.output.exactSize exists");
  }
  for (const field of ["width", "height"]) {
    if (plan[field] !== undefined) errors.push(`comicPlan.${field} is forbidden; use input.output.exactSize only when user supplied`);
  }
  errors.push(...validatePostLayoutPlan({ input, plan }));
}

function validateVisualLock(errors, visualLock, characterBible, input, styleCatalog) {
  addVersion3(errors, visualLock, "visualLock");
  if (!isObject(visualLock)) return;
  addRequiredString(errors, visualLock.lockId, "visualLock.lockId");
  if (visualLock.sourceCharacterBible !== "character-bible.json") {
    errors.push("visualLock.sourceCharacterBible must be character-bible.json");
  }
  if (!isObject(visualLock.style)) {
    errors.push("visualLock.style must be an object");
  } else {
    addRequiredString(errors, visualLock.style.presetId, "visualLock.style.presetId");
    for (const field of STYLE_FIELDS) {
      const value = visualLock.style[field];
      if (field === "palette" || field === "avoid") {
        if (!nonEmptyStringArray(value)) errors.push(`visualLock.style.${field} must be a non-empty string array`);
      } else {
        addRequiredString(errors, value, `visualLock.style.${field}`);
      }
    }
  }

  const mode = input?.visual?.styleMode;
  if (mode === "preset") {
    const preset = (styleCatalog?.presets ?? []).find((entry) => entry.id === input?.visual?.preset);
    if (!preset) {
      errors.push(`input.visual.preset ${JSON.stringify(input?.visual?.preset)} does not exist in style catalog`);
    } else {
      if (visualLock?.style?.presetId !== preset.id) errors.push("visualLock.style.presetId must match input.visual.preset");
      for (const field of STYLE_FIELDS) {
        if (!sameValue(visualLock?.style?.[field], preset.lock?.[field])) {
          errors.push(`visualLock.style.${field} must exactly match preset ${preset.id}`);
        }
      }
    }
  } else if (mode === "custom") {
    if (!nonEmptyString(input?.visual?.customStyle)) errors.push("input.visual.customStyle is required for custom style mode");
    if (visualLock?.style?.presetId !== "custom") errors.push("visualLock.style.presetId must be custom in custom style mode");
  } else if (mode === "reference") {
    if (visualLock?.style?.presetId !== "reference") errors.push("visualLock.style.presetId must be reference in reference style mode");
    const refs = collectReferenceAssets({ input, visualLock, characterBible });
    if (refs.length === 0) errors.push("reference style mode requires at least one reference image");
    for (const ref of refs) {
      if (ref.roles.length === 0) errors.push(`reference ${ref.file} must declare at least one controlling role`);
    }
  } else {
    errors.push("input.visual.styleMode must be preset, custom, or reference");
  }

  errors.push(...validateReferenceAssets({ input, visualLock, characterBible }));
  for (const ref of collectReferenceAssets({ input, visualLock, characterBible })) {
    if (ref.roles.length === 0) {
      errors.push(`reference ${ref.file} must declare which identity, style, or page-grammar properties it controls`);
    }
  }

  if (!Array.isArray(visualLock.characters)) {
    errors.push("visualLock.characters must be an array");
  } else if (Array.isArray(characterBible?.characters)) {
    if (visualLock.characters.length !== characterBible.characters.length) {
      errors.push("visualLock.characters must contain every character from characterBible.characters");
    }
    const bibleById = new Map(characterBible.characters.map((character) => [character.id, character]));
    for (const [index, locked] of visualLock.characters.entries()) {
      const source = bibleById.get(locked?.id);
      if (!source) {
        errors.push(`visualLock.characters[${index}].id does not exist in characterBible.characters`);
      } else if (!sameValue(locked.immutable, source.immutable)) {
        errors.push(`visualLock.characters[${index}].immutable must exactly match characterBible character ${locked.id}`);
      }
    }
  }

  if (!isObject(visualLock.output)) {
    errors.push("visualLock.output must be an object");
  } else {
    if (visualLock.output.aspectRatio !== "3:4" || visualLock.output.aspectRatio !== input?.output?.aspectRatio) {
      errors.push("visualLock.output.aspectRatio and input.output.aspectRatio must both be 3:4");
    }
    if (visualLock.output.textStrategy !== input?.output?.textStrategy) {
      errors.push("visualLock.output.textStrategy must match input.output.textStrategy");
    }
    if (input?.output?.exactSize !== undefined) {
      if (!sameValue(visualLock.output.exactSize, input.output.exactSize)) {
        errors.push("visualLock.output.exactSize must exactly match input.output.exactSize");
      }
    } else if (visualLock.output.exactSize !== undefined) {
      errors.push("visualLock.output.exactSize is forbidden unless input.output.exactSize exists");
    }
  }

  const lockRefs = new Set((visualLock.referenceImages ?? []).map(referenceAssetFile).filter(Boolean));
  for (const ref of collectReferenceAssets({ input, visualLock, characterBible })) {
    if (!lockRefs.has(ref.file)) errors.push(`visualLock.referenceImages must include input reference ${ref.file}`);
  }
}

function validateCopywriting(errors, copywriting, input) {
  addVersion3(errors, copywriting, "copywriting");
  if (!isObject(copywriting)) return;
  if (copywriting.platform !== input?.platform) errors.push("copywriting.platform must match input.platform");
  const requirements = [
    ["titleCandidates", 5],
    ["pullQuotes", 3],
    ["tags", 10],
    ["seriesNames", 3],
  ];
  for (const [field, count] of requirements) {
    if (!Array.isArray(copywriting[field]) || copywriting[field].length !== count || !copywriting[field].every(nonEmptyString)) {
      errors.push(`copywriting.${field} must contain exactly ${count} non-empty strings`);
    }
  }
  addRequiredString(errors, copywriting.summary, "copywriting.summary");
  addRequiredString(errors, copywriting.cta, "copywriting.cta");
}

/**
 * Validate the six-artifact package returned by the planning model.
 * @returns {string[]} deterministic validation errors; an empty array means valid.
 */
export function validatePlannerPackage(pkg, input, styleCatalog) {
  const errors = [];
  if (!isObject(pkg)) return ["planner package must be an object"];
  if (!isObject(input)) return ["input must be an object"];
  if (!isObject(styleCatalog) || !Array.isArray(styleCatalog.presets)) {
    return ["styleCatalog.presets must be an array"];
  }

  const actualKeys = Object.keys(pkg);
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in pkg)) errors.push(`planner package is missing ${key}`);
  }
  for (const key of actualKeys) {
    if (!TOP_LEVEL_KEYS.includes(key)) errors.push(`planner package must not contain ${key}`);
  }
  if (!["topic-to-comic", "story-to-comic", "series-continuation"].includes(input.mode)) {
    errors.push("input.mode must be topic-to-comic, story-to-comic, or series-continuation");
  }

  validateTopicAngles(errors, pkg.topicAngles, input);
  validateStory(errors, pkg.story, input);
  validateCharacterBible(errors, pkg.characterBible, input);
  validatePlan(errors, pkg.comicPlan, input);
  validateVisualLock(errors, pkg.visualLock, pkg.characterBible, input, styleCatalog);
  validateCopywriting(errors, pkg.copywriting, input);

  if (isObject(pkg.story) && isObject(pkg.comicPlan)) {
    if (pkg.comicPlan.title !== pkg.story.title) errors.push("comicPlan.title must match story.title");
    if (pkg.comicPlan.coreMessage !== pkg.story.coreMessage) errors.push("comicPlan.coreMessage must match story.coreMessage");
  }
  return errors;
}

function quote(value) {
  return JSON.stringify(String(value));
}

function listValue(value) {
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

function immutableLines(characterBible, visualLock) {
  const sourceById = new Map((characterBible?.characters ?? []).map((character) => [character.id, character]));
  return (visualLock?.characters ?? []).flatMap((locked) => {
    const source = sourceById.get(locked.id);
    const lines = [`- ${locked.id}${nonEmptyString(source?.role) ? ` (${source.role})` : ""}:`];
    for (const [field, value] of Object.entries(locked.immutable ?? {})) {
      lines.push(`  - ${field}: ${listValue(value)}`);
    }
    if (nonEmptyStringArray(source?.forbiddenChanges)) {
      lines.push(`  - Forbidden changes: ${source.forbiddenChanges.join(", ")}`);
    }
    return lines;
  });
}

function panelText(panel) {
  const values = [];
  for (const item of panel?.dialogue ?? []) if (nonEmptyString(item)) values.push(item);
  const narration = panel?.narration;
  if (nonEmptyString(narration)) values.push(narration);
  if (Array.isArray(narration)) for (const item of narration) if (nonEmptyString(item)) values.push(item);
  return values;
}

function graphemeCount(value) {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
  return [...segmenter.segment(String(value))].length;
}

function referenceLines(input, visualLock, characterBible, generationStrategy, pageIndex, textStrategy) {
  const refs = collectReferenceAssets({ input, visualLock, characterBible });
  const lines = [];
  if (refs.length === 0) {
    if (generationStrategy === "anchor-first-fanout" && pageIndex > 0) {
      const anchorFile = textStrategy === "post-layout" ? "source-images/01.png" : "images/01.png";
      lines.push(`- Reference image 1 — file: ${quote(anchorFile)}; roles: identity, style, page-grammar; assetType: generated-page-anchor.`);
      lines.push("- This generated page anchor controls recurring character identity, face, hair, body proportions, wardrobe, signature colors, line treatment, palette, bubble style, borders, and page grammar.");
    } else {
      lines.push("- No external reference image is attached; obey the complete visual and character locks above.");
    }
  } else {
    for (const [index, ref] of refs.entries()) {
      const metadata = [
        `file: ${quote(ref.file)}`,
        `roles: ${ref.roles.join(", ")}`,
        `assetType: ${ref.assetType}`,
      ];
      if (ref.characterIds.length > 0) metadata.push(`characterIds: ${ref.characterIds.join(", ")}`);
      if (ref.views.length > 0) metadata.push(`views: ${ref.views.join(", ")}`);
      lines.push(`- Reference image ${index + 1} — ${metadata.join("; ")}.`);
    }
  }
  if (generationStrategy === "anchor-first-fanout" && pageIndex > 0) {
    const anchorFile = textStrategy === "post-layout" ? "source-images/01.png" : "images/01.png";
    if (refs.length > 0) {
      lines.push(`- Reference image ${refs.length + 1} — file: ${quote(anchorFile)}; roles: identity, style, page-grammar; assetType: generated-page-anchor.`);
    }
    lines.push("- Preserve the generated page anchor's recurring character identity, face, hair, body proportions, wardrobe, signature colors, line treatment, palette, bubble style, borders, and page grammar.");
    lines.push("- Change only the current page's panels, actions, expressions, camera, and story content; do not copy the anchor's exact geometry or poses.");
  }
  return lines;
}

/**
 * Compile deterministic prompts for all directly generated final comic pages.
 */
export function compilePagePrompts({ input, plan, visualLock, characterBible }) {
  const prompts = [];
  const exactSize = input?.output?.exactSize;
  const textStrategy = input?.output?.textStrategy ?? plan?.textStrategy ?? "native";
  const style = visualLock?.style ?? {};
  const styleLines = [
    `- Lock ID: ${visualLock?.lockId}`,
    `- Preset ID: ${style.presetId ?? "custom/reference"}`,
    `- Medium: ${style.medium}`,
    `- Line treatment: ${style.line}`,
    `- Palette: ${listValue(style.palette)}`,
    `- Lighting: ${style.lighting}`,
    `- Paper/background treatment: ${style.background}`,
    `- Bubble and border language: ${style.pageGrammar}`,
    `- Character design language: ${style.characterDesign}`,
    `- Typography character: ${style.typography}`,
    `- Avoid: ${listValue(style.avoid)}`,
  ];

  for (const [pageIndex, page] of (plan?.pages ?? []).entries()) {
    const lines = [];
    lines.push("TASK");
    lines.push(`Create exactly one complete social-comic PAGE for page ${page.id}.`);
    lines.push("This is a final publishable page, not an illustration or storyboard asset.");
    lines.push("");
    lines.push("OUTPUT");
    lines.push("- Target aspect ratio: portrait 3:4");
    if (exactSize) lines.push(`- Exact execution size: ${exactSize.width} x ${exactSize.height}`);
    lines.push("- One standalone page image");
    lines.push(`- ${page.panelCount} visible comic panels inside the page`);
    lines.push("- Clear borders and reading order");
    if (textStrategy === "post-layout") {
      lines.push("- Reserve readable final bubble/caption areas for deterministic post-layout text; do not render substitute wording");
    } else {
      lines.push("- Dialogue bubbles and captions already rendered in the final image");
    }
    lines.push("- No contact sheet, crop marks, watermark, character sheet, or unlettered single-scene substitute");
    lines.push("");
    lines.push("VISUAL LOCK — DO NOT CHANGE");
    lines.push(...styleLines);
    lines.push("");
    lines.push("RECURRING CHARACTERS — DO NOT CHANGE");
    lines.push(...immutableLines(characterBible, visualLock));
    lines.push("");
    lines.push("CURRENT PAGE");
    lines.push(`- Story purpose: ${page.purpose}`);
    lines.push(`- Page-level change: ${page.change}`);
    lines.push(`- Setting continuity: ${page.scene}`);
    lines.push(`- Composition freedom: ${plan.compositionFreedom}`);
    if (plan.compositionFreedom === "model-arranged") {
      lines.push("- Preserve the ordered semantic beats, characters, emotions, required text, and exclusions.");
      lines.push("- Freely choose panel sizes and emphasis, camera distance and angle, staging and character positions, visual transitions, reaction shots, motion symbols, and background simplification.");
    } else {
      lines.push(`- Follow the director-locked geometry, shots, positions, and transitions exactly because: ${plan.compositionReason}`);
    }
    lines.push("");
    lines.push("ORDERED PANELS");
    for (const [panelIndex, panel] of page.panels.entries()) {
      const pieces = [
        `change: ${panel.change}`,
        `action: ${panel.action}`,
        `emotion: ${panel.emotion}`,
      ];
      const texts = panelText(panel);
      if (textStrategy === "post-layout") {
        const slotIds = (page.textPlacements || []).filter((placement) => placement.panelId === panel.id).map((placement) => placement.id);
        pieces.push(slotIds.length > 0 ? `reserved lettering slots: ${slotIds.join(", ")}` : "reserved lettering slots: none");
      } else {
        pieces.push(texts.length > 0 ? `required text: ${texts.map(quote).join(" / ")}` : "required text: none");
      }
      if (plan.compositionFreedom === "director-locked") pieces.push(`direction: ${panel.direction}`);
      lines.push(`Panel ${panelIndex + 1}: ${pieces.join("; ")}.`);
    }
    lines.push("");
    lines.push("REQUIRED CONTENT TEXT");
    if (textStrategy === "post-layout") {
      lines.push("Do not render any dialogue, narration, title, placeholder wording, or slot ID. Keep every normalized slot rectangle visually quiet and free of faces, bodies, props, panel borders, or important details. A deterministic compositor will draw the final bubble/caption and exact text later:");
      for (const placement of page.textPlacements || []) {
        const box = placement.box;
        const characterCount = graphemeCount(placement.text);
        lines.push(`- ${placement.id}; panel ${placement.panelId}; kind ${placement.kind}; tail ${placement.tail}; normalized box x=${box.x}, y=${box.y}, width=${box.width}, height=${box.height} on a 0..1000 page; reserve for approximately ${characterCount} graphemes; do not print this slot ID.`);
      }
    } else {
      lines.push("Render every string below verbatim in Simplified Chinese, with the correct speaker/panel assignment:");
      for (const text of page.requiredText) lines.push(`- ${quote(text)}`);
    }
    lines.push("");
    lines.push("REFERENCE USE");
    lines.push(...referenceLines(input, visualLock, characterBible, plan.generationStrategy, pageIndex, textStrategy));
    lines.push("");
    lines.push("EXCLUSIONS");
    lines.push("- No character redesign, wardrobe drift, or palette change");
    lines.push("- No missing, merged, duplicated, or extra panel");
    lines.push("- No extra people, limbs, invented dialogue, invented narration, factual claims, logos, or watermarks");
    lines.push("- No single full-page illustration in place of the planned comic panels");
    lines.push("");
    prompts.push({ file: page.promptFile, content: `${lines.join("\n")}\n` });
  }
  return prompts;
}
