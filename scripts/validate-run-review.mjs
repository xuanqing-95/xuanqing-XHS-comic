import { selectContinuityAnchorAsset } from "./reference-assets.mjs";
import { summarizeUsageStatus, validateUsageCall } from "./usage-contract.mjs";

function collectScores(report, errors) {
  const scores = [];
  for (const [key, value] of Object.entries(report?.content || {})) {
    if (!Number.isInteger(value) || value < 0 || value > 4) {
      errors.push(`eval-report.content.${key} must be an integer from 0 to 4`);
    } else {
      scores.push({ path: `content.${key}`, value });
    }
  }
  for (const [index, page] of (report?.pages || []).entries()) {
    for (const [key, value] of Object.entries(page.checks || {})) {
      if (!Number.isInteger(value) || value < 0 || value > 4) {
        errors.push(`eval-report.pages[${index}].checks.${key} must be an integer from 0 to 4`);
      } else {
        scores.push({ path: `pages[${index}].checks.${key}`, value });
      }
    }
  }
  for (const [index, pair] of (report?.pairwise || []).entries()) {
    for (const [key, value] of Object.entries(pair.checks || {})) {
      if (!Number.isInteger(value) || value < 0 || value > 4) {
        errors.push(`eval-report.pairwise[${index}].checks.${key} must be an integer from 0 to 4`);
      } else {
        scores.push({ path: `pairwise[${index}].checks.${key}`, value });
      }
    }
  }
  for (const [key, value] of Object.entries(report?.series || {})) {
    if (!Number.isInteger(value) || value < 0 || value > 4) {
      errors.push(`eval-report.series.${key} must be an integer from 0 to 4`);
    } else {
      scores.push({ path: `series.${key}`, value });
    }
  }
  return scores;
}

export function validateRunReview({
  result,
  plan,
  input,
  visualLock,
  characterBible,
  usage,
  codexBuiltinPlanAccepted,
  debug,
  errors,
  warnings,
  readJson,
  requireVersion3,
  requireString,
  pageRequiredText,
  sameValue,
  outputValidation,
}) {
  const evalRequired = ["reviewed", "needs-review"].includes(result?.status);
  const evalReport = readJson("eval-report.json", evalRequired);
  const diagnosis = readJson("diagnosis.json", evalRequired);

  if (evalReport) {
    requireVersion3(evalReport, "eval-report");
    const outputIntegrityGate = evalReport.hardGates?.outputIntegrity
      ? "outputIntegrity"
      : evalReport.hardGates?.directOutput
        ? "directOutput"
      : evalReport.hardGates?.directDimensions
        ? "directDimensions"
        : "outputIntegrity";
    const gateNames = [
      "artifactCompleteness",
      "sourceFaithfulness",
      outputIntegrityGate,
      "uniqueOutputs",
      "comicPageForm",
      "requiredText",
      "safety",
    ];
    for (const gate of gateNames) {
      if (!new Set(["pass", "fail"]).has(evalReport.hardGates?.[gate]?.status)) {
        errors.push(`eval-report.hardGates.${gate}.status must be pass or fail`);
      }
    }
    if (outputIntegrityGate === "directDimensions") {
      warnings.push("eval-report.hardGates.directDimensions is legacy; new runs use outputIntegrity");
    } else if (outputIntegrityGate === "directOutput") {
      warnings.push("eval-report.hardGates.directOutput is legacy; new runs use outputIntegrity with strategy-aware provenance");
    } else if (!Array.isArray(result?.actualDimensions) || !sameValue(result.actualDimensions, outputValidation.measuredPageDimensions)) {
      errors.push("outputIntegrity eval requires result.actualDimensions to record every final page's actual size");
    }
    for (const check of [
      "angleQuality",
      "storyStructure",
      "dialogueNaturalness",
      "characterReproducibility",
      "publishingAlignment",
    ]) {
      if (!(check in (evalReport.content || {}))) errors.push(`eval-report.content.${check} is required`);
    }
    if (plan && evalReport.pages?.length !== plan.pageCount) {
      errors.push("eval-report.pages must evaluate every planned page");
    }
    const externalSeriesAnchor = input?.mode === "series-continuation"
      ? selectContinuityAnchorAsset({ input, visualLock, characterBible })
      : null;
    const hasExternalSeriesAnchor = Boolean(externalSeriesAnchor);
    const expectedPairwiseCount = plan
      ? (hasExternalSeriesAnchor ? plan.pageCount : Math.max(0, plan.pageCount - 1))
      : 0;
    if (plan && evalReport.pairwise?.length !== expectedPairwiseCount) {
      errors.push(
        hasExternalSeriesAnchor
          ? "series-continuation eval-report.pairwise must compare every new page to the external anchor"
          : "eval-report.pairwise must compare every later page to the anchor",
      );
    }
    for (const [index, pair] of (evalReport.pairwise || []).entries()) {
      const expectedPage = hasExternalSeriesAnchor ? plan?.pages?.[index] : plan?.pages?.[index + 1];
      if (expectedPage && pair.pageId !== expectedPage.id) {
        errors.push(`eval-report.pairwise[${index}].pageId must match ${expectedPage.id}`);
      }
      if (hasExternalSeriesAnchor) {
        if (pair.referencePageId !== "external-series-anchor") {
          errors.push(`eval-report.pairwise[${index}].referencePageId must be external-series-anchor`);
        }
        if (pair.referenceFile !== externalSeriesAnchor.file) {
          errors.push(`eval-report.pairwise[${index}].referenceFile must match the canonical external series anchor`);
        }
      } else if (expectedPage && pair.referencePageId !== plan.pages[0].id) {
        errors.push(`eval-report.pairwise[${index}].referencePageId must match the first planned page`);
      }
    }
    const scores = collectScores(evalReport, errors);
    if (scores.length === 0) errors.push("eval-report must contain visual scores");
    const computedMean = scores.length ? scores.reduce((sum, item) => sum + item.value, 0) / scores.length : 0;
    if (typeof evalReport.scoreMean !== "number" || Math.abs(evalReport.scoreMean - computedMean) > 0.01) {
      errors.push(`eval-report.scoreMean must equal computed mean ${computedMean.toFixed(4)}`);
    }
    if (evalReport.threshold !== 3.25) errors.push("eval-report.threshold must remain 3.25");
    const gatesPass = gateNames.every((gate) => evalReport.hardGates?.[gate]?.status === "pass");
    const scoresPass = scores.every((item) => item.value >= 3) && computedMean >= 3.25;
    const shouldPass = gatesPass && scoresPass;
    if (evalReport.status !== (shouldPass ? "pass" : "fail")) {
      errors.push(`eval-report.status must be ${shouldPass ? "pass" : "fail"} from fixed gates and thresholds`);
    }
    if (evalReport.hardGates?.artifactCompleteness?.status === "pass" && !outputValidation.artifactsValid) {
      errors.push("eval-report cannot pass artifactCompleteness when planned page files are missing or unreadable");
    }
    if (evalReport.hardGates?.[outputIntegrityGate]?.status === "pass" && (!outputValidation.dimensionsValid || !outputValidation.letteringIntegrityValid)) {
      errors.push(`eval-report cannot pass ${outputIntegrityGate} when deterministic output or lettering integrity validation failed`);
    }
    if (evalReport.hardGates?.uniqueOutputs?.status === "pass" && !outputValidation.uniqueOutputsValid) {
      errors.push("eval-report cannot pass uniqueOutputs when deterministic hashes contain duplicates");
    }
    if (plan) {
      for (const [index, pageEval] of (evalReport.pages || []).entries()) {
        const expected = pageRequiredText(plan.pages?.[index]) || [];
        if (JSON.stringify(pageEval.textAudit?.expected) !== JSON.stringify(expected)) {
          errors.push(`eval-report.pages[${index}].textAudit.expected must match comic-plan.pages[${index}].requiredText`);
        }
        if (evalReport.status === "pass" && (pageEval.textAudit?.errors || []).length > 0) {
          errors.push(`passing text eval cannot contain text errors on page ${index + 1}`);
        }
      }
    }
  }

  if (diagnosis) {
    requireVersion3(diagnosis, "diagnosis");
    if (!new Set(["no-material-failure", "action-required"]).has(diagnosis.status)) {
      errors.push("diagnosis.status is unsupported");
    }
    if (!Array.isArray(diagnosis.issues)) errors.push("diagnosis.issues must be an array");
    if (diagnosis.status === "no-material-failure" && diagnosis.issues?.length !== 0) {
      errors.push("no-material-failure diagnosis must have no issues");
    }
    const domains = new Set(["contract", "prompt", "model-execution", "evaluator", "runtime"]);
    for (const [index, issue] of (diagnosis.issues || []).entries()) {
      if (!domains.has(issue.faultDomain)) errors.push(`diagnosis.issues[${index}].faultDomain is unsupported`);
      if (issue.autoAction !== "none") errors.push(`diagnosis.issues[${index}].autoAction must be none`);
      requireString(issue.recommendedChange, `diagnosis.issues[${index}].recommendedChange`);
    }
    if (plan && diagnosis.comparisons?.length !== plan.pageCount) {
      errors.push("diagnosis.comparisons must trace contract, prompt, output, and eval for every page");
    }
    for (const [index, comparison] of (diagnosis.comparisons || []).entries()) {
      const plannedPage = plan?.pages?.[index];
      if (plannedPage && comparison.pageId !== plannedPage.id) {
        errors.push(`diagnosis.comparisons[${index}].pageId must match the planned page`);
      }
      if (plannedPage && comparison.promptFile !== plannedPage.promptFile) {
        errors.push(`diagnosis.comparisons[${index}].promptFile must match the planned prompt`);
      }
      if (plannedPage && comparison.outputFile !== plannedPage.outputFile) {
        errors.push(`diagnosis.comparisons[${index}].outputFile must match the planned output`);
      }
      if (!new Set(["pass", "fail", "integrity-pass", "not-run"]).has(comparison.promptAudit)) {
        errors.push(`diagnosis.comparisons[${index}].promptAudit must be pass, fail, integrity-pass, or not-run`);
      }
      if (!new Set(["pass", "fail", "not-run"]).has(comparison.outputEval)) {
        errors.push(`diagnosis.comparisons[${index}].outputEval must be pass, fail, or not-run`);
      }
      if (
        diagnosis.status === "no-material-failure" &&
        (comparison.promptAudit !== "pass" || comparison.outputEval !== "pass")
      ) {
        errors.push(`no-material-failure requires passing prompt and output checks for page ${index + 1}`);
      }
    }
  }

  if (result?.status === "reviewed") {
    if (evalReport?.status !== "pass") errors.push("reviewed result requires eval-report.status pass");
    if (diagnosis?.status !== "no-material-failure") errors.push("reviewed result requires diagnosis.status no-material-failure");
  }
  if (result?.status === "needs-review" && evalReport?.status === "pass" && diagnosis?.status === "no-material-failure") {
    errors.push("needs-review result requires a failed eval or actionable diagnosis");
  }

  if (usage) {
    const modernStatuses = new Set(["complete", "partial", "unavailable", "not_applicable"]);
    const legacyStatus = usage.status === "available";
    if (!modernStatuses.has(usage.status) && !legacyStatus) {
      errors.push("usage.status must be complete, partial, unavailable, or not_applicable");
    }
    if (legacyStatus) warnings.push("usage.status available is legacy; new runs distinguish complete from partial metering");
    if (usage.calls !== undefined && !Array.isArray(usage.calls)) errors.push("usage.calls must be an array when present");
    const modernCalls = Array.isArray(usage.calls) && usage.calls.some((call) => call?.callId !== undefined);
    if (modernCalls) {
      for (const [index, call] of usage.calls.entries()) errors.push(...validateUsageCall(call, index));
      const expectedStatus = summarizeUsageStatus(usage.calls);
      if (!legacyStatus && usage.status !== expectedStatus) {
        errors.push(`usage.status must equal deterministic call summary ${expectedStatus}`);
      }
      const duplicateCallIds = usage.calls
        .map((call) => call.callId)
        .filter((callId, index, all) => all.indexOf(callId) !== index);
      if (duplicateCallIds.length > 0) errors.push(`usage.calls contains duplicate callId values: ${[...new Set(duplicateCallIds)].join(", ")}`);
      if (result?.status !== "failed" && usage.calls.some((call) => call.status === "started" || call.status === "failed")) {
        errors.push("a non-failed result cannot contain an ambiguous or failed model call");
      }
      const succeeded = usage.calls.filter((call) => call.status === "succeeded");
      const hasRole = (role) => succeeded.some((call) => call.role === role);
      if (
        plan
        && ["planned", "generated-unlettered", "generated", "reviewed", "needs-review"].includes(result?.status)
        && !hasRole("planner")
        && codexBuiltinPlanAccepted !== true
      ) {
        errors.push("planned or later results require one succeeded planner usage receipt");
      }
      if (plan && ["generated-unlettered", "generated", "reviewed", "needs-review"].includes(result?.status)) {
        const imagePageIds = new Set(succeeded.filter((call) => call.role === "image").map((call) => call.pageId));
        for (const page of plan.pages || []) {
          if (!imagePageIds.has(page.id)) errors.push(`generated or later result lacks a succeeded image usage receipt for ${page.id}`);
        }
      }
      if (["reviewed", "needs-review"].includes(result?.status) && !hasRole("evaluator")) {
        errors.push("reviewed or needs-review results require one succeeded evaluator usage receipt");
      }
    } else if (Array.isArray(usage.calls) && usage.calls.length > 0) {
      warnings.push("usage.calls uses the legacy call shape without stable callId/role/meteringStatus receipts");
    }
  }

  if (debug && plan && debug.generationStrategy !== plan.generationStrategy) {
    errors.push("debug.generationStrategy must match comic-plan.generationStrategy");
  }
  if (debug && input && debug.contentMode !== input.mode) {
    errors.push("debug.contentMode must match input.mode");
  }
  if (debug && plan?.generationStrategy === "anchor-first-fanout" && debug.anchorPageId !== plan.pages?.[0]?.id) {
    errors.push("anchor-first-fanout requires the first planned page as debug.anchorPageId");
  }
}
