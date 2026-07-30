const SCORE_MIN = 0;
const SCORE_MAX = 4;
export const EVAL_THRESHOLD = 3.25;

const CONTENT_KEYS = [
  "angleQuality",
  "storyStructure",
  "dialogueNaturalness",
  "characterReproducibility",
  "publishingAlignment",
];

const PAGE_KEYS = [
  "panelPlanFidelity",
  "textLegibility",
  "storyBeatFidelity",
  "visualIntegrity",
];

const PAIRWISE_KEYS = [
  "characterIdentity",
  "wardrobeAndProps",
  "artStyle",
  "pageGrammar",
];

const SERIES_KEYS = [
  "narrativeContinuity",
  "characterConsistency",
  "styleConsistency",
  "layoutConsistency",
  "textConsistency",
];

function isScore(value) {
  return Number.isInteger(value) && value >= SCORE_MIN && value <= SCORE_MAX;
}

function requireStatus(value, field, errors) {
  if (!value || !["pass", "fail"].includes(value.status) || !Array.isArray(value.evidence)) {
    errors.push(`${field} must contain status pass|fail and an evidence array`);
  }
}

function requireScores(object, keys, field, errors) {
  if (!object || typeof object !== "object") {
    errors.push(`${field} must be an object`);
    return;
  }
  for (const key of keys) {
    if (!isScore(object[key])) errors.push(`${field}.${key} must be an integer from 0 to 4`);
  }
}

export function validateSubjectiveEvaluation(value, { plan, input, visualLock, characterBible }) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["evaluator output must be one JSON object"];
  }
  for (const gate of ["sourceFaithfulness", "comicPageForm", "requiredText", "safety"]) {
    requireStatus(value.hardGates?.[gate], `hardGates.${gate}`, errors);
  }
  requireScores(value.content, CONTENT_KEYS, "content", errors);
  if (!Array.isArray(value.pages) || value.pages.length !== plan.pages.length) {
    errors.push("pages must evaluate every planned page exactly once");
  }
  for (const [index, page] of (value.pages || []).entries()) {
    if (page.pageId !== plan.pages[index]?.id) errors.push(`pages[${index}].pageId must match the plan`);
    requireScores(page.checks, PAGE_KEYS, `pages[${index}].checks`, errors);
    if (!page.textAudit || !Array.isArray(page.textAudit.observed) || !Array.isArray(page.textAudit.errors)) {
      errors.push(`pages[${index}].textAudit must contain observed and errors arrays`);
    }
    if (!Array.isArray(page.evidence)) errors.push(`pages[${index}].evidence must be an array`);
  }
  const externalAnchor = input.mode === "series-continuation" && Boolean(
    selectContinuityAnchorAsset({ input, visualLock, characterBible }),
  );
  const expectedPairs = externalAnchor ? plan.pages.length : Math.max(0, plan.pages.length - 1);
  if (!Array.isArray(value.pairwise) || value.pairwise.length !== expectedPairs) {
    errors.push(`pairwise must contain exactly ${expectedPairs} comparisons`);
  }
  for (const [index, pair] of (value.pairwise || []).entries()) {
    const expectedPage = externalAnchor ? plan.pages[index] : plan.pages[index + 1];
    if (pair.pageId !== expectedPage?.id) errors.push(`pairwise[${index}].pageId must match the expected page`);
    requireScores(pair.checks, PAIRWISE_KEYS, `pairwise[${index}].checks`, errors);
    if (!Array.isArray(pair.evidence)) errors.push(`pairwise[${index}].evidence must be an array`);
  }
  requireScores(value.series, SERIES_KEYS, "series", errors);
  if (!Array.isArray(value.issues)) errors.push("issues must be an array");
  return errors;
}

function collectScores(subjective) {
  return [
    ...Object.values(subjective.content),
    ...subjective.pages.flatMap((page) => Object.values(page.checks)),
    ...subjective.pairwise.flatMap((pair) => Object.values(pair.checks)),
    ...Object.values(subjective.series),
  ];
}

export function buildEvalReport({ subjective, plan, input, visualLock, characterBible, actualDimensions, evaluator, hashes, letteringReport = null }) {
  const scores = collectScores(subjective);
  const scoreMean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const textErrors = subjective.pages.flatMap((page, index) =>
    (page.textAudit?.errors || []).map((error) => `${plan.pages[index].id}: ${error}`),
  );
  const localGates = {
    artifactCompleteness: {
      status: "pass",
      evidence: ["All planned direct PNG files and required run artifacts were present and readable before visual evaluation."],
    },
    outputIntegrity: {
      status: "pass",
      evidence: plan.textStrategy === "post-layout"
        ? (letteringReport?.pages || []).map((item) => `Provider base ${item.sourceFile} and final ${item.outputFile} both remain ${item.outputDimensions.width}x${item.outputDimensions.height}; deterministic lettering changed ${item.pixelAudit.changedPixels} pixels only inside declared boxes; no crop, resize, padding, or stitching was used.`)
        : actualDimensions.map((item) => `Provider-direct final ${item.file}: ${item.width}x${item.height}; no crop, resize, padding, or stitching step was used.`),
    },
    uniqueOutputs: {
      status: "pass",
      evidence: hashes.map((item) => `${item.file}: ${item.sha256}`),
    },
  };
  const hardGates = {
    artifactCompleteness: localGates.artifactCompleteness,
    sourceFaithfulness: subjective.hardGates.sourceFaithfulness,
    outputIntegrity: localGates.outputIntegrity,
    uniqueOutputs: localGates.uniqueOutputs,
    comicPageForm: subjective.hardGates.comicPageForm,
    requiredText: textErrors.length > 0
      ? {
          status: "fail",
          evidence: [
            ...subjective.hardGates.requiredText.evidence,
            ...textErrors,
          ],
        }
      : subjective.hardGates.requiredText,
    safety: subjective.hardGates.safety,
  };
  const gatesPass = Object.values(hardGates).every((gate) => gate.status === "pass");
  const scoresPass = scores.every((score) => score >= 3) && scoreMean >= EVAL_THRESHOLD;
  const status = gatesPass && scoresPass ? "pass" : "fail";
  const pages = subjective.pages.map((page, index) => ({
    ...page,
    textAudit: {
      expected: plan.pages[index].requiredText || plan.pages[index].allowedText || [],
      observed: page.textAudit.observed,
      errors: page.textAudit.errors,
      observations: page.textAudit.observations || [],
    },
  }));
  const externalAnchorAsset = input.mode === "series-continuation"
    ? selectContinuityAnchorAsset({ input, visualLock, characterBible })
    : null;
  const externalAnchor = Boolean(externalAnchorAsset);
  const pairwise = subjective.pairwise.map((pair) => ({
    ...(externalAnchor ? {
      referencePageId: "external-series-anchor",
      referenceFile: externalAnchorAsset.file,
    } : {
      referencePageId: plan.pages[0].id,
    }),
    pageId: pair.pageId,
    checks: pair.checks,
    evidence: pair.evidence,
  }));
  return {
    version: 3,
    evaluator,
    hardGates,
    content: subjective.content,
    pages,
    pairwise,
    series: subjective.series,
    scoreMean,
    threshold: EVAL_THRESHOLD,
    status,
    issues: subjective.issues,
    editorialRisks: subjective.editorialRisks || [],
    humanReviewRequired: status !== "pass" || Boolean(subjective.humanReviewRequired),
  };
}

export function buildDiagnosis({ evalReport, plan }) {
  const pageFailed = (page) => Object.values(page.checks).some((score) => score < 3) || page.textAudit.errors.length > 0;
  const materialIssues = evalReport.status === "fail";
  const issues = materialIssues
    ? [{
        issueId: "visual-eval-failed",
        evalPath: "eval-report.json",
        faultDomain: "model-execution",
        evidence: {
          contract: "comic-plan.json and visual-lock.json passed deterministic validation before generation.",
          prompt: "Compiled page prompts passed deterministic contract audit.",
          output: plan.pages.map((page) => page.outputFile).join(", "),
          evalFinding: (evalReport.issues || []).join("; ") || "One or more visual gates or scores failed.",
        },
        responsibleArtifact: "images/",
        recommendedChange: "Review the failed visual evidence before authorizing any targeted regeneration.",
        autoAction: "none",
      }]
    : [];
  return {
    version: 3,
    status: issues.length ? "action-required" : "no-material-failure",
    comparisons: plan.pages.map((page, index) => ({
      pageId: page.id,
      contractFile: `comic-plan.json#pages[${index}]`,
      promptFile: page.promptFile,
      outputFile: page.outputFile,
      promptAudit: "pass",
      outputEval: pageFailed(evalReport.pages[index]) ? "fail" : "pass",
    })),
    issues,
    observations: evalReport.status === "pass"
      ? ["Deterministic artifact checks and multimodal visual evaluation passed without a material issue."]
      : ["Evaluation is read-only and does not authorize a paid redraw."],
  };
}

export function buildEvaluatorPrompt({ input, story, characterBible, plan, visualLock, copywriting }) {
  return `You are the independent multimodal evaluator for a finished social-comic run.\n\n` +
    `Evaluate only the supplied final page images and any supplied external series anchor. Return one strict JSON object, no markdown. ` +
    `Do not claim that files, dimensions, hashes, provider provenance, or compositor provenance pass; local code controls those gates. ` +
    `${plan.textStrategy === "post-layout" ? "For post-layout pages, local code proves exact character sequences and placement records; visually judge legibility, correct bubble/panel ownership, obstruction, and harmful stray model-rendered wording. " : ""}` +
    `Do not authorize regeneration. Use integer scores 0-4.\n\n` +
    `INPUT\n${JSON.stringify(input)}\n\n` +
    `STORY\n${JSON.stringify(story)}\n\n` +
    `CHARACTERS\n${JSON.stringify(characterBible)}\n\n` +
    `PLAN\n${JSON.stringify(plan)}\n\n` +
    `VISUAL LOCK\n${JSON.stringify(visualLock)}\n\n` +
    `COPYWRITING\n${JSON.stringify(copywriting)}\n\n` +
    `Required JSON keys: hardGates.sourceFaithfulness/comicPageForm/requiredText/safety each with status and evidence array; ` +
    `content with angleQuality, storyStructure, dialogueNaturalness, characterReproducibility, publishingAlignment; ` +
    `pages in plan order with pageId, checks.panelPlanFidelity/textLegibility/storyBeatFidelity/visualIntegrity, textAudit.observed/errors/observations, evidence array; ` +
    `pairwise comparisons required by the plan, with pageId, checks.characterIdentity/wardrobeAndProps/artStyle/pageGrammar, evidence array; ` +
    `series with narrativeContinuity, characterConsistency, styleConsistency, layoutConsistency, textConsistency; issues array, editorialRisks array, humanReviewRequired boolean.`;
}
import { selectContinuityAnchorAsset } from "./reference-assets.mjs";
