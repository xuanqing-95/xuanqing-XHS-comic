import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

import {
  buildLetteringPlan,
  composePostLayoutPage,
  loadPostLayoutRoute,
  preflightPostLayout,
} from "./post-layout.mjs";
import { verifyPostLayoutSourceProvenance } from "./post-layout-source-provenance.mjs";
import { readJson, updateResult, writeJsonAtomic } from "./run-artifacts.mjs";
import { stableHash } from "./usage-contract.mjs";

export function createComposeStage(context) {
  const { args, runDir, addDebugEvent, recordUsage, callIdFor, runValidator, now, sameJson } = context;

  return async function runCompose(input) {
    await addDebugEvent("compose", "running");
    if (input.output?.textStrategy !== "post-layout") {
      await addDebugEvent("compose", "completed", { skipped: true, reason: "textStrategy is native" });
      return;
    }
    if (!args.compositorRouteJson) {
      throw new Error("[POST_LAYOUT_ROUTE_REQUIRED] post-layout compose requires --compositor-route-json.");
    }
    const resultBefore = await readJson(path.join(runDir, "result.json"));
    const resumableFailure = args.resume && resultBefore.status === "failed" && resultBefore.stage === "compose";
    if (resultBefore.status !== "generated-unlettered" && !resumableFailure) {
      throw new Error(`Composition requires result.status generated-unlettered, got ${resultBefore.status}`);
    }
    const plan = await readJson(path.join(runDir, "comic-plan.json"));
    const letteringPlan = await readJson(path.join(runDir, "lettering-plan.json"));
    const expectedLetteringPlan = buildLetteringPlan(plan);
    if (!sameJson(letteringPlan, expectedLetteringPlan)) {
      throw new Error("[POST_LAYOUT_PLAN_STALE] lettering-plan.json must be the deterministic compilation of comic-plan.json.");
    }
    const route = await loadPostLayoutRoute(args.compositorRouteJson);
    const preflight = await preflightPostLayout({ input, plan, route });
    // Verify every provider source and its generation sidecar before writing
    // any staged or final page. A single provenance failure fails the complete
    // compose stage closed while preserving all paid source images.
    const sourceProvenance = await Promise.all(plan.pages.map((page) => (
      verifyPostLayoutSourceProvenance({ runDir, page })
    )));
    const stagingDir = path.join(runDir, "compose-staging");
    await mkdir(stagingDir, { recursive: true });
    const staged = [];
    for (const [index, page] of plan.pages.entries()) {
      const stagingFile = path.posix.join("compose-staging", `${String(index + 1).padStart(2, "0")}.png`);
      const record = await composePostLayoutPage({
        runDir,
        page: { ...page, outputFile: stagingFile },
        route,
        preflight,
        sourceProvenance: sourceProvenance[index],
      });
      staged.push({ page, stagingFile, record });
    }
    for (const { page, stagingFile } of staged) {
      await rename(path.join(runDir, stagingFile), path.join(runDir, page.outputFile));
    }
    const pages = staged.map(({ page, record }) => ({ ...record, outputFile: page.outputFile }));
    const letteringReport = {
      version: 3,
      status: "pass",
      engine: preflight.engine,
      engineModule: preflight.engineModule,
      routeFile: route.routeFile,
      font: preflight.font,
      overflowPolicy: "fail",
      pages,
    };
    await writeJsonAtomic(path.join(runDir, "lettering-report.json"), letteringReport);
    await recordUsage({
      callId: callIdFor(`compose:${stableHash(letteringPlan)}`),
      role: "compositor",
      stage: "compose",
      operation: "compose",
      status: "succeeded",
      meteringStatus: "not_applicable",
      inputHash: stableHash(letteringPlan),
      outputHash: stableHash(letteringReport),
      attempts: 1,
      startedAt: null,
      completedAt: now(),
      usage: null,
    });
    for (const page of pages) {
      await writeJsonAtomic(path.join(runDir, `${page.outputFile}.json`), {
        version: 3,
        pageId: page.pageId,
        outputFile: page.outputFile,
        sourceFile: page.sourceFile,
        composited: true,
        compositor: preflight.engine,
        fontSha256: preflight.font.sha256,
        sourceSha256: page.sourceSha256,
        outputSha256: page.outputSha256,
        sourceDimensions: page.sourceDimensions,
        outputDimensions: page.outputDimensions,
        letteringReport: "lettering-report.json",
        composedAt: now(),
      });
    }
    const sourceActualDimensions = pages.map((page) => ({ file: page.sourceFile, ...page.sourceDimensions }));
    const actualDimensions = pages.map((page) => ({ file: page.outputFile, ...page.outputDimensions }));
    const result = {
      status: "generated",
      error: null,
      pageCount: plan.pageCount,
      aspectRatio: plan.aspectRatio,
      sourcePages: pages.map((page) => page.sourceFile),
      sourceActualDimensions,
      pages: pages.map((page) => page.outputFile),
      actualDimensions,
      letteringPlan: "lettering-plan.json",
      letteringReport: "lettering-report.json",
      contentPackage: { story: "story.json", characters: "character-bible.json", copywriting: "copywriting.json" },
    };
    if (input.output?.exactSize) result.exactSize = input.output.exactSize;
    await updateResult(runDir, result);
    const report = runValidator();
    await addDebugEvent("compose", "completed", {
      pages: pages.length,
      engine: preflight.engine,
      fontSha256: preflight.font.sha256,
      validatorWarnings: report.warnings || [],
    });
  };
}
