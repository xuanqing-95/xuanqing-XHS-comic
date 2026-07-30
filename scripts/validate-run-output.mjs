import { postLayoutSourceFile } from "./post-layout.mjs";

export function validateRunOutputs({
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
}) {
  let artifactsValid = false;
  let dimensionsValid = false;
  let uniqueOutputsValid = false;
  let letteringIntegrityValid = plan?.textStrategy !== "post-layout";
  const measuredPageDimensions = [];
  const measuredSourceDimensions = [];

  if (result && plan) {
    if (!allowedResultStatuses.has(result.status)) errors.push("result.status is unsupported");
    if (result.pageCount !== plan.pageCount) errors.push("result.pageCount must match comic-plan.pageCount");
    if (result.aspectRatio !== "3:4") errors.push('result.aspectRatio must be "3:4"');
    const resultExactSize = validateExactSize(result.exactSize, "result.exactSize");
    if (requestedExactSize && !sameValue(resultExactSize, requestedExactSize)) {
      errors.push("result.exactSize must match the user-requested input.output.exactSize");
    }
    if (!requestedExactSize && result.exactSize !== undefined && result.exactSize !== null) {
      errors.push("result.exactSize is allowed only when the user explicitly requests input.output.exactSize");
    }
    if (result.width !== undefined || result.height !== undefined) {
      warnings.push("result.width/height are legacy planned fields; record generated files in result.actualDimensions instead");
    }
    const expectedPackage = {
      story: "story.json",
      characters: "character-bible.json",
      copywriting: "copywriting.json",
    };
    if (JSON.stringify(result.contentPackage) !== JSON.stringify(expectedPackage)) {
      errors.push("result.contentPackage must point to story, character-bible, and copywriting artifacts");
    }
    if (plan.textStrategy === "post-layout") {
      const expectedSources = plan.pages.map(postLayoutSourceFile);
      const sourceStates = new Set(["generated-unlettered", "generated", "reviewed", "needs-review"]);
      if (sourceStates.has(result.status) || (result.status === "failed" && Array.isArray(result.sourcePages))) {
        const expectedResultSources = result.status === "failed"
          ? expectedSources.slice(0, result.sourcePages?.length || 0)
          : expectedSources;
        if (!Array.isArray(result.sourcePages) || result.sourcePages.length > expectedSources.length || !sameValue(result.sourcePages, expectedResultSources)) {
          errors.push("post-layout result.sourcePages must list the immutable provider source pages in order without gaps");
        } else {
          for (const [index, sourceFile] of result.sourcePages.entries()) {
            const field = `result.sourcePages[${index}]`;
            if (!fileExists(sourceFile, field)) continue;
            const png = readPng(sourceFile, field);
            if (!png) continue;
            measuredSourceDimensions.push({ file: sourceFile, width: png.width, height: png.height });
            if (requestedExactSize && (png.width !== requestedExactSize.width || png.height !== requestedExactSize.height)) {
              if (result.status !== "failed") errors.push(`${field} must match user-requested exact size`);
            } else if (!requestedExactSize && !isProviderNativeThreeFour(png.width, png.height)) {
              if (result.status !== "failed") errors.push(`${field} must be provider-native portrait 3:4`);
            }
          }
        }
        if (!sameValue(result.sourceActualDimensions, measuredSourceDimensions)) {
          errors.push("result.sourceActualDimensions must record every measured provider source page");
        }
      }
      if (result.status === "generated-unlettered") {
        if (result.pages !== undefined || result.actualDimensions !== undefined || result.letteringReport !== undefined) {
          errors.push("generated-unlettered must not expose final pages, final dimensions, or a lettering report");
        }
      }
    } else if (result.sourcePages !== undefined || result.sourceActualDimensions !== undefined) {
      errors.push("native result must not define post-layout sourcePages/sourceActualDimensions");
    }
    const inspectPreservedPages = ["generated", "reviewed", "needs-review"].includes(result.status) || (
      result.status === "failed" && Array.isArray(result.pages)
    );
    if (inspectPreservedPages) {
      const plannedOutputs = Array.isArray(plan.pages) ? plan.pages.map((page) => page.outputFile) : [];
      const expectedOutputs = result.status === "failed"
        ? plannedOutputs.slice(0, result.pages?.length || 0)
        : plannedOutputs;
      if (!Array.isArray(result.pages) || result.pages.length === 0) {
        errors.push("a failed result that preserves pages must list at least one measured page");
      } else if (result.status !== "failed" && result.pages.length !== plan.pageCount) {
        errors.push("generated result must list every planned page");
      } else if (result.status === "failed" && result.pages.length > plan.pageCount) {
        errors.push("failed result cannot preserve more pages than the plan contains");
      } else if (JSON.stringify(result.pages) !== JSON.stringify(expectedOutputs)) {
        errors.push(result.status === "failed"
          ? "failed result.pages must be the generated prefix of planned output files"
          : "result.pages must match planned output files in page order");
      } else {
        const hashes = new Set();
        artifactsValid = true;
        dimensionsValid = true;
        uniqueOutputsValid = true;
        for (const [index, pagePath] of result.pages.entries()) {
          const field = `result.pages[${index}]`;
          if (!fileExists(pagePath, field)) {
            artifactsValid = false;
            dimensionsValid = false;
            continue;
          }
          const png = readPng(pagePath, field);
          if (!png) {
            artifactsValid = false;
            dimensionsValid = false;
            continue;
          }
          measuredPageDimensions.push({ file: pagePath, width: png.width, height: png.height });
          if (requestedExactSize && (png.width !== requestedExactSize.width || png.height !== requestedExactSize.height)) {
            if (result.status !== "failed") {
              errors.push(`${field} must match user-requested exact size ${requestedExactSize.width}x${requestedExactSize.height}, got ${png.width}x${png.height}: ${pagePath}`);
            }
            dimensionsValid = false;
          } else if (!requestedExactSize && !isProviderNativeThreeFour(png.width, png.height)) {
            if (result.status !== "failed") {
              errors.push(`${field} must be a provider-native portrait 3:4 output, got ${png.width}x${png.height}: ${pagePath}`);
            }
            dimensionsValid = false;
          }
          if (hashes.has(png.sha256)) {
            if (result.status !== "failed") {
              errors.push(`${field} duplicates another page byte-for-byte: ${pagePath}`);
            }
            uniqueOutputsValid = false;
          }
          hashes.add(png.sha256);
        }
      }
    }
    if (result.actualDimensions !== undefined && !sameValue(result.actualDimensions, measuredPageDimensions)) {
      errors.push("result.actualDimensions must record the measured width and height of every generated page in order");
    }
  }

  if (plan?.textStrategy === "post-layout" && letteringReport) {
    letteringIntegrityValid = true;
    if (letteringReport.status !== "pass") {
      errors.push("lettering-report.status must be pass");
      letteringIntegrityValid = false;
    }
    if (!Array.isArray(letteringReport.pages) || letteringReport.pages.length !== plan.pageCount) {
      errors.push("lettering-report.pages must cover every planned page");
      letteringIntegrityValid = false;
    }
    for (const [index, reportPage] of (letteringReport.pages || []).entries()) {
      const plannedPage = plan.pages[index];
      const expectedSource = postLayoutSourceFile(plannedPage);
      if (reportPage.pageId !== plannedPage.id || reportPage.sourceFile !== expectedSource || reportPage.outputFile !== plannedPage.outputFile) {
        errors.push(`lettering-report.pages[${index}] provenance must match the plan`);
        letteringIntegrityValid = false;
      }
      if (!sameValue(reportPage.sourceDimensions, reportPage.outputDimensions)) {
        errors.push(`lettering-report.pages[${index}] must preserve the source canvas dimensions exactly`);
        letteringIntegrityValid = false;
      }
      const sourcePng = readPng(expectedSource, `lettering-report.pages[${index}].sourceFile`);
      const outputPng = readPng(plannedPage.outputFile, `lettering-report.pages[${index}].outputFile`);
      if (sourcePng && reportPage.sourceSha256 !== sourcePng.sha256) {
        errors.push(`lettering-report.pages[${index}].sourceSha256 must match the immutable source image`);
        letteringIntegrityValid = false;
      }
      if (outputPng && reportPage.outputSha256 !== outputPng.sha256) {
        errors.push(`lettering-report.pages[${index}].outputSha256 must match the final image`);
        letteringIntegrityValid = false;
      }
      const sidecarFile = `${expectedSource}.json`;
      const sidecar = readJson(sidecarFile);
      const expectedOperation = Array.isArray(sidecar?.references) && sidecar.references.length > 0 ? "edit" : "generation";
      const generation = reportPage.generationProvenance;
      const sidecarMatchesSource = sidecar?.version === 3
        && sidecar.directOutput === true
        && sidecar.pageId === plannedPage.id
        && sidecar.outputFile === expectedSource
        && sidecar.finalOutputFile === plannedPage.outputFile
        && Array.isArray(sidecar.references)
        && sidecar.operation === expectedOperation
        && typeof sidecar.callId === "string"
        && sidecar.callId.endsWith(`:page:${plannedPage.id}:${expectedOperation}`)
        && sidecar.outputSha256 === sourcePng?.sha256
        && sameValue(sidecar.actualDimensions, sourcePng ? { width: sourcePng.width, height: sourcePng.height } : null);
      const reportMatchesSidecar = generation?.sidecarFile === sidecarFile
        && generation?.sidecarSha256 === fileSha256(sidecarFile)
        && generation?.pageId === sidecar?.pageId
        && generation?.operation === sidecar?.operation
        && generation?.callId === sidecar?.callId
        && generation?.provider === sidecar?.provider
        && generation?.model === sidecar?.model
        && generation?.pricingModel === sidecar?.pricingModel
        && generation?.sourceFile === expectedSource
        && generation?.finalOutputFile === plannedPage.outputFile
        && generation?.sourceSha256 === sourcePng?.sha256
        && sameValue(generation?.sourceDimensions, sourcePng ? { width: sourcePng.width, height: sourcePng.height } : null);
      if (!sidecarMatchesSource || !reportMatchesSidecar) {
        errors.push(`lettering-report.pages[${index}].generationProvenance must match the immutable provider source and its generation sidecar`);
        letteringIntegrityValid = false;
      }
      const expectedPlacements = plannedPage.textPlacements.map((placement) => ({
        id: placement.id,
        panelId: placement.panelId,
        requiredTextIndex: placement.requiredTextIndex,
        text: placement.text,
      }));
      const reportedPlacements = (reportPage.placements || []).map((placement) => ({
        id: placement.placementId,
        panelId: placement.panelId,
        requiredTextIndex: placement.requiredTextIndex,
        text: placement.text,
      }));
      if (!sameValue(reportedPlacements, expectedPlacements)) {
        errors.push(`lettering-report.pages[${index}].placements must preserve every exact text item and panel assignment`);
        letteringIntegrityValid = false;
      }
      if (reportPage.pixelAudit?.outsideDeclaredRegionsUnchanged !== true || reportPage.pixelAudit?.alphaOutsideDeclaredRegionsUnchanged !== true || !(reportPage.pixelAudit?.changedPixels > 0)) {
        errors.push(`lettering-report.pages[${index}].pixelAudit must prove text-only changes inside declared regions`);
        letteringIntegrityValid = false;
      }
    }
    if (result?.letteringReport !== "lettering-report.json") {
      errors.push("completed post-layout result.letteringReport must be lettering-report.json");
      letteringIntegrityValid = false;
    }
  }

  return {
    artifactsValid,
    dimensionsValid,
    uniqueOutputsValid,
    letteringIntegrityValid,
    measuredPageDimensions,
    measuredSourceDimensions,
  };
}
