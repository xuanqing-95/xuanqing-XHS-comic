import { readFile } from "node:fs/promises";
import path from "node:path";

import { preflightImageRoute } from "./image-route-capabilities.mjs";
import { loadPostLayoutRoute, postLayoutSourceFile, preflightPostLayout } from "./post-layout.mjs";
import { generatePage, loadRoute } from "./provider-clients.mjs";
import { collectReferenceAssets, validateReferenceAssets } from "./reference-assets.mjs";
import { ensureRunFilesExist, hashRunFiles, resolveRunReferenceFile } from "./run-file-utils.mjs";
import { pngMetadata, readJson, readJsonIfExists, updateDebug, updateResult, writeJsonAtomic } from "./run-artifacts.mjs";
import { stableHash } from "./usage-contract.mjs";

function isProviderNativeThreeFour(width, height) {
  const scale = Math.round(((width / 3) + (height / 4)) / 2);
  return width < height && Math.abs(width - (scale * 3)) <= 1 && Math.abs(height - (scale * 4)) <= 1;
}

async function mapBounded(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function createGenerateStage(context) {
  const {
    args, runDir, inputBaseDir, addDebugEvent, requireAuthorized, modelCallIntent,
    callIdFor, recordUsage, completedModelCall, failedModelCall, runValidator, now,
  } = context;
  const resolveFile = (file) => resolveRunReferenceFile(inputBaseDir, file);

  async function generateOne({ route, input, page, referenceAssets, resume }) {
    const generatedFile = input.output?.textStrategy === "post-layout" ? postLayoutSourceFile(page) : page.outputFile;
    const outputPath = path.join(runDir, generatedFile);
    const prompt = await readFile(path.join(runDir, page.promptFile), "utf8");
    const referenceFiles = referenceAssets.map((asset) => resolveFile(asset.file));
    const operation = referenceFiles.length > 0 ? "edit" : "generation";
    const callId = callIdFor(`page:${page.id}:${operation}`);
    const inputHash = stableHash({
      prompt,
      references: await hashRunFiles(referenceFiles),
      aspectRatio: input.output.aspectRatio,
      exactSize: input.output.exactSize ?? null,
      quality: input.output.quality,
    });
    if (resume) {
      const existing = await readJsonIfExists(`${outputPath}.json`);
      const usageArtifact = await readJsonIfExists(path.join(runDir, "usage.json"));
      const priorCall = (usageArtifact?.calls || []).find((call) => call.callId === callId);
      try {
        const metadata = await pngMetadata(outputPath);
        if (existing?.directOutput === true) {
          if (!priorCall || priorCall.status === "started") {
            const recoveredIntent = modelCallIntent({
              callId, role: "image", stage: "generate", operation, inputHash,
              pageId: page.id, outputFile: generatedFile,
            });
            await recordUsage({
              ...recoveredIntent,
              status: "succeeded",
              meteringStatus: "unavailable",
              provider: existing.provider,
              model: existing.model,
              pricingModel: existing.pricingModel,
              attempts: 0,
              outputHash: metadata.sha256,
              completedAt: now(),
              usage: null,
              recovery: "existing provider output and sidecar were reused; original provider usage was unavailable",
            });
          }
          return {
            page, generatedFile, metadata, reused: true,
            provider: existing.provider, model: existing.model, pricingModel: existing.pricingModel,
            requestedSize: existing.requestedSize, requestedQuality: existing.requestedQuality,
            usage: null, attempts: 0,
          };
        }
      } catch {
        // A missing or invalid page is regenerated only because resume was explicitly requested.
      }
      if (priorCall?.status === "started") {
        throw new Error(`[AMBIGUOUS_MODEL_CALL] ${callId} was started previously but has no complete reusable output. Automatic paid retry is forbidden.`);
      }
    }

    const intent = modelCallIntent({
      callId, role: "image", stage: "generate", operation, inputHash,
      pageId: page.id, outputFile: generatedFile,
    });
    await recordUsage(intent);
    let generated;
    try {
      generated = await generatePage({
        route,
        prompt,
        referenceFiles,
        aspectRatio: input.output.aspectRatio,
        exactSize: input.output.exactSize,
        quality: input.output.quality,
        outputPath,
        timeoutMs: args.timeoutMs,
      });
    } catch (error) {
      await recordUsage(failedModelCall(intent, error));
      throw error;
    }
    const metadata = await pngMetadata(outputPath);
    const sidecar = {
      version: 3,
      pageId: page.id,
      outputFile: generatedFile,
      finalOutputFile: page.outputFile,
      directOutput: true,
      provider: generated.provider,
      model: generated.model,
      pricingModel: generated.pricingModel,
      callId,
      operation,
      requestId: generated.requestId ?? null,
      inputHash,
      outputSha256: metadata.sha256,
      requestedSize: generated.requestedSize,
      requestedQuality: generated.requestedQuality,
      actualDimensions: generated.actualDimensions,
      references: referenceAssets.map((asset) => ({ ...asset, resolvedFile: resolveFile(asset.file) })),
      generatedAt: now(),
    };
    await writeJsonAtomic(`${outputPath}.json`, sidecar);
    await recordUsage(completedModelCall(intent, generated, metadata.sha256));
    const exactSize = input.output?.exactSize;
    if (exactSize && (metadata.width !== exactSize.width || metadata.height !== exactSize.height)) {
      throw new Error(`[PROVIDER_OUTPUT_DIMENSION_MISMATCH] Direct output ${generatedFile} measured ${metadata.width}x${metadata.height}, not the user-requested exact size ${exactSize.width}x${exactSize.height}. The file and sidecar were preserved; no later page was requested.`);
    }
    if (!exactSize && !isProviderNativeThreeFour(metadata.width, metadata.height)) {
      throw new Error(`[PROVIDER_OUTPUT_DIMENSION_MISMATCH] Direct output ${generatedFile} measured ${metadata.width}x${metadata.height}, not provider-native portrait 3:4. The file and sidecar were preserved; no later page was requested.`);
    }
    return { page, generatedFile, metadata, reused: false, ...generated };
  }

  return async function runGenerate(input) {
    await addDebugEvent("generate", "running");
    requireAuthorized(args.imageRouteJson, "--image-route-json", "Generation");
    runValidator();
    const resultBefore = await readJson(path.join(runDir, "result.json"));
    if (resultBefore.status !== "planned" && !(args.resume && new Set(["generated", "generated-unlettered"]).has(resultBefore.status))) {
      throw new Error(`Generation requires result.status planned, got ${resultBefore.status}`);
    }
    const route = await loadRoute(args.imageRouteJson, "image");
    const plan = await readJson(path.join(runDir, "comic-plan.json"));
    const visualLock = await readJson(path.join(runDir, "visual-lock.json"));
    const characterBible = await readJson(path.join(runDir, "character-bible.json"));
    const referenceErrors = validateReferenceAssets({ input, visualLock, characterBible });
    if (referenceErrors.length > 0) throw new Error(`Reference asset contract failed:\n${referenceErrors.join("\n")}`);
    const baseReferenceAssets = collectReferenceAssets({ input, visualLock, characterBible });
    if (input.output?.textStrategy === "post-layout") {
      if (!args.compositorRouteJson) {
        throw new Error("[POST_LAYOUT_ROUTE_REQUIRED] post-layout requires --compositor-route-json before any image call was made.");
      }
      const compositorRoute = await loadPostLayoutRoute(args.compositorRouteJson);
      const compositorPreflight = await preflightPostLayout({ input, plan, route: compositorRoute });
      await updateDebug(runDir, {
        postLayoutPreflight: {
          ok: compositorPreflight.ok,
          engine: compositorPreflight.engine,
          engineModule: compositorPreflight.engineModule,
          font: compositorPreflight.font,
          pages: compositorPreflight.pages,
        },
      });
    }
    const imageRoutePreflight = preflightImageRoute({ route, plan, referenceAssets: baseReferenceAssets, input });
    const productQuality = input.output?.quality ?? null;
    const providerQuality = productQuality === null ? null : route.qualityMap?.[productQuality] ?? productQuality;
    if (providerQuality !== null && !new Set(["low", "medium", "high", "auto"]).has(providerQuality)) {
      throw new Error(`[IMAGE_ROUTE_QUALITY_MAPPING_INVALID] Product quality ${productQuality} resolves to unsupported OpenAI-compatible quality ${providerQuality}; no image call was made.`);
    }
    await updateDebug(runDir, { imageRoutePreflight: { ...imageRoutePreflight, productQuality, providerQuality } });
    const baseReferenceFiles = baseReferenceAssets.map((asset) => resolveFile(asset.file));
    await ensureRunFilesExist(baseReferenceFiles);
    const needsReferences = baseReferenceAssets.length > 0 || (plan.generationStrategy === "anchor-first-fanout" && plan.pages.length > 1);
    if (needsReferences && route.supportsReferences !== true) {
      throw new Error("The selected generation strategy needs reference images, but the image route does not support them; no image call was made.");
    }
    if (plan.generationStrategy === "reference-parallel" && baseReferenceAssets.length === 0) {
      throw new Error("reference-parallel requires at least one approved reference image; no image call was made.");
    }

    let generated;
    if (plan.generationStrategy === "anchor-first-fanout") {
      const first = await generateOne({ route, input, page: plan.pages[0], referenceAssets: baseReferenceAssets, resume: args.resume });
      const anchorFile = input.output?.textStrategy === "post-layout" ? postLayoutSourceFile(plan.pages[0]) : plan.pages[0].outputFile;
      const generatedAnchorAsset = {
        file: path.join(runDir, anchorFile),
        roles: ["identity", "style", "page-grammar"],
        assetType: "generated-page-anchor",
        characterIds: [], views: [], inputSupplied: false, sources: ["current-run-page-01"],
      };
      const rest = await mapBounded(plan.pages.slice(1), args.maxConcurrency, (page) => generateOne({
        route, input, page, referenceAssets: [...baseReferenceAssets, generatedAnchorAsset], resume: args.resume,
      }));
      generated = [first, ...rest];
    } else {
      generated = await mapBounded(plan.pages, args.maxConcurrency, (page) => generateOne({
        route, input, page, referenceAssets: baseReferenceAssets, resume: args.resume,
      }));
    }

    const actualDimensions = generated.map(({ page, generatedFile, metadata }) => ({
      file: generatedFile || (input.output?.textStrategy === "post-layout" ? postLayoutSourceFile(page) : page.outputFile),
      width: metadata.width,
      height: metadata.height,
    }));
    const postLayout = input.output?.textStrategy === "post-layout";
    const result = {
      status: postLayout ? "generated-unlettered" : "generated",
      error: null,
      pageCount: plan.pageCount,
      aspectRatio: plan.aspectRatio,
      ...(postLayout ? {
        sourcePages: plan.pages.map(postLayoutSourceFile), sourceActualDimensions: actualDimensions,
        letteringPlan: "lettering-plan.json",
      } : { pages: plan.pages.map((page) => page.outputFile), actualDimensions }),
      contentPackage: { story: "story.json", characters: "character-bible.json", copywriting: "copywriting.json" },
    };
    if (input.output?.exactSize) result.exactSize = input.output.exactSize;
    await updateResult(runDir, result);
    const report = runValidator();
    await addDebugEvent("generate", "completed", {
      generatedPages: generated.filter((item) => !item.reused).length,
      reusedPages: generated.filter((item) => item.reused).length,
      validatorWarnings: report.warnings || [],
      nextStage: postLayout ? "compose" : "evaluate",
    });
  };
}
