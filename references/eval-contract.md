# Eval and diagnosis contract

Use a fixed rubric to decide whether generated pages satisfy the run contract. Keep evaluation separate from diagnosis and repair.

## Contents

- Evaluation principles and score scale
- Hard gates
- Content-package checks
- Page, pairwise, and series checks
- `eval-report.json`
- Root-cause decision tree
- `diagnosis.json`

## Evaluation principles

- Evaluate the complete content package requested by the contract, not general aesthetic preference.
- Inspect every page at readable size and compare every later page with the anchor/reference.
- Use deterministic checks for facts a script can prove; use image vision only for visual judgments.
- Preserve failed evidence. Never alter thresholds after seeing results.
- A passing eval does not prove that the contract itself matches user intent; diagnosis checks that boundary separately.

## Score scale

Use integers from 0 to 4:

- `4`: matches the contract with no material deviation;
- `3`: minor variation, still unmistakably consistent and publication-usable;
- `2`: noticeable drift that weakens continuity or readability;
- `1`: major mismatch, likely a different character/style/page type;
- `0`: missing, unreadable, corrupt, or not evaluable.

## Hard gates

All hard gates must pass:

- `artifactCompleteness`: planned files and pages exist in order;
- `sourceFaithfulness`: the selected angle/story preserves the user's topic, supplied plot, core message, and stated boundaries;
- `outputIntegrity`: apply strategy-aware deterministic provenance. For `native`, every final page is the provider's direct output. For `post-layout`, every provider base is preserved under `source-images/`, the final page keeps the same canvas, and a pixel audit proves that deterministic lettering changed only the declared text regions. Neither strategy permits crop, resize, padding, or stitching. The normal route accepts portrait 3:4 with at most one pixel of integer rounding on either edge; exact pixel matching is required only when the user supplied `input.output.exactSize`;
- `uniqueOutputs`: page hashes are unique;
- `comicPageForm`: every deliverable is a complete comic page with the planned panels, not a naked illustration;
- `requiredText`: every required title/dialogue/narration string is accurate and correctly assigned for `native`; for `post-layout`, deterministic code proves exact content and panel assignment while the visual evaluator checks legibility, bubble ownership, obstruction, and harmful stray text;
- `safety`: no material editorial or safety violation.

One hard-gate failure makes the overall eval fail.

`requiredText` is not a whole-image character whitelist. Record missing, corrupted, duplicated, or misassigned required copy as `textAudit.errors`. Benign panel numbers, clock digits, and incidental environmental marks may be recorded as observations, but do not fail the gate unless they materially conflict with user intent, source fidelity, safety, branding, or readability. Invented dialogue, narration, or factual claims are material errors.

## Content-package checks

Score:

- `angleQuality`: three distinct, relevant, visually expressible angles, or a justified skip for a supplied story;
- `storyStructure`: clear hook, progression, turn, resolution, and earned ending without formulaic filler;
- `dialogueNaturalness`: concise, speakable, character-appropriate text;
- `characterReproducibility`: simple, distinctive, non-contradictory identity locks;
- `publishingAlignment`: titles, summary, quotes, tags, series names, and CTA match the actual comic and platform.

Every content-package score must be at least `3`.

## Page-level visual checks

Score every page:

- `panelPlanFidelity`: panel count, order, shots, actions, expressions, and page purpose;
- `textLegibility`: readable lettering and bubble ownership;
- `storyBeatFidelity`: the intended page change is visible;
- `visualIntegrity`: no broken anatomy, duplicated limbs, corrupted borders, or distracting artifacts.

Every page-level score must be at least `3`.

## Pairwise consistency checks

Compare each later page with the anchor/reference:

- For an ordinary multi-page run whose first generated page is the anchor, compare Pages 2..N with Page 1.
- For `series-continuation` with an external approved reference, compare every newly generated page with that external anchor, including the first page of the new episode. Record `referencePageId: external-series-anchor` and the exact `referenceFile`.

- `characterIdentity`: face geometry, age, eyes, hair, body proportion, recognizability;
- `wardrobeAndProps`: clothing silhouette/colors and recurring props;
- `artStyle`: line weight, watercolor/rendering texture, palette, lighting, paper/background treatment;
- `pageGrammar`: borders, bubble shapes, typography character, spacing, and visual density.

Every pairwise score must be at least `3`.

## Series-level checks

Score:

- `narrativeContinuity`;
- `characterConsistency`;
- `styleConsistency`;
- `layoutConsistency`;
- `textConsistency`.

Every series-level score must be at least `3`. The mean of all scored visual checks must be at least `3.25`.

## `eval-report.json`

```json
{
  "version": 3,
  "evaluator": {
    "type": "multimodal-agent",
    "rubric": "references/eval-contract.md",
    "anchorPage": "images/01.png"
  },
  "hardGates": {
    "artifactCompleteness": {"status": "pass", "evidence": []},
    "sourceFaithfulness": {"status": "pass", "evidence": []},
    "outputIntegrity": {"status": "pass", "evidence": ["Strategy-aware provenance and measured dimensions were verified by deterministic code."]},
    "uniqueOutputs": {"status": "pass", "evidence": []},
    "comicPageForm": {"status": "pass", "evidence": []},
    "requiredText": {"status": "pass", "evidence": []},
    "safety": {"status": "pass", "evidence": []}
  },
  "content": {},
  "pages": [],
  "pairwise": [],
  "series": {},
  "scoreMean": 0,
  "threshold": 3.25,
  "status": "pass",
  "issues": []
}
```

Use `status: fail` if any hard gate fails, any required visual score is below 3, or the mean is below the threshold.

The multimodal evaluator must not infer file hashes, provider provenance, compositor provenance, or pixel-region integrity from appearance. Local deterministic code owns `artifactCompleteness`, `outputIntegrity`, and `uniqueOutputs`. For post-layout text, local code also owns exact string equality and panel assignment; vision remains responsible for whether the result is readable, visually attributed to the right speaker/panel, unobstructed, and free of material stray text.

## Root-cause decision tree

For each eval issue, use evidence in this order:

1. If the user intent/source and run contract disagree, assign `contract`.
2. Otherwise, if the compiled prompt omits or contradicts the correct contract, assign `prompt`.
3. Otherwise, if provider output is missing/corrupt/misordered, an explicitly requested exact size is not honored, or file operations fail, assign `runtime`.
4. Otherwise, if the prompt is faithful but the image violates it, assign `model-execution`.
5. Assign `evaluator` only when the output actually satisfies the contract and the metric, rubric, or judgment is demonstrably wrong.

Do not assign `contract` merely because many outputs fail. Do not assign `evaluator` merely because a score is inconvenient.

## `diagnosis.json`

```json
{
  "version": 3,
  "status": "action-required",
  "issues": [
    {
      "issueId": "eval-001",
      "evalPath": "pairwise[0].characterIdentity",
      "faultDomain": "model-execution",
      "evidence": {
        "contract": "visual-lock.json#characters",
        "prompt": "prompts/02.md",
        "output": "images/02.png",
        "evalFinding": "Face shape changed materially from anchor."
      },
      "responsibleArtifact": "images/02.png",
      "recommendedChange": "Regenerate Page 2 with the same prompt and stronger reference fidelity after authorization.",
      "autoAction": "none"
    }
  ]
}
```

Use `status: no-material-failure` and an empty issue array when eval passes and no contract/prompt/evaluator defect is found. Eval and diagnosis never authorize a paid redraw.
