#!/usr/bin/env node

import assert from "node:assert/strict";
import { buildEvalReport } from "./evaluation-utils.mjs";

const scores = (keys) => Object.fromEntries(keys.map((key) => [key, 4]));
const subjective = {
  hardGates: {
    sourceFaithfulness: { status: "pass", evidence: ["faithful"] },
    comicPageForm: { status: "pass", evidence: ["comic"] },
    requiredText: { status: "pass", evidence: ["text"] },
    safety: { status: "pass", evidence: ["safe"] },
  },
  content: {
    ...scores(["angleQuality", "storyStructure", "dialogueNaturalness", "characterReproducibility", "publishingAlignment"]),
    evidence: ["A harmless evaluator explanation must not become a score."],
  },
  pages: [{
    pageId: "p1",
    checks: {
      ...scores(["panelPlanFidelity", "textLegibility", "storyBeatFidelity", "visualIntegrity"]),
      explanation: "also harmless",
    },
    textAudit: { observed: ["ok"], errors: [], observations: [] },
    evidence: ["page ok"],
  }],
  pairwise: [],
  series: {
    ...scores(["narrativeContinuity", "characterConsistency", "styleConsistency", "layoutConsistency", "textConsistency"]),
    evidence: ["series ok"],
  },
  issues: [],
  editorialRisks: [],
  humanReviewRequired: false,
};

const report = buildEvalReport({
  subjective,
  plan: {
    textStrategy: "model-rendered",
    pages: [{ id: "p1", outputFile: "images/01.png", requiredText: ["ok"] }],
  },
  input: { mode: "topic-to-comic" },
  visualLock: {},
  characterBible: {},
  actualDimensions: [{ file: "images/01.png", width: 1152, height: 1536 }],
  evaluator: { provider: "test", model: "test" },
  hashes: [{ file: "images/01.png", sha256: "abc" }],
});

assert.equal(report.scoreMean, 4);
assert.equal(report.status, "pass");
assert.equal(report.humanReviewRequired, false);
assert.deepEqual(Object.keys(report.content), [
  "angleQuality",
  "storyStructure",
  "dialogueNaturalness",
  "characterReproducibility",
  "publishingAlignment",
]);
assert.deepEqual(Object.keys(report.pages[0].checks), [
  "panelPlanFidelity",
  "textLegibility",
  "storyBeatFidelity",
  "visualIntegrity",
]);
assert.deepEqual(Object.keys(report.series), [
  "narrativeContinuity",
  "characterConsistency",
  "styleConsistency",
  "layoutConsistency",
  "textConsistency",
]);

console.log("test-evaluator-extra-fields OK");
