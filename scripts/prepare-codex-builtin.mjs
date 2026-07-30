#!/usr/bin/env node

import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { collectReferenceAssets } from "./reference-assets.mjs";
import { writeJsonAtomic } from "./run-artifacts.mjs";

export const CODEX_BUILTIN_PREPARATION_VERSION = 1;
export const ASPECT_CANVAS = Object.freeze({
  width: 1080,
  height: 1440,
  aspectRatio: "3:4",
  rgb: Object.freeze([245, 240, 230]),
  file: "codex-builtin-assets/aspect-only-blank-3x4.png",
});

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const NO_EXTERNAL_REFERENCE = /^- No external reference image is attached;.*(?:\r?\n)?/gm;
const EXACT_SIZE_ERROR = "CODEX_BUILTIN_EXACT_SIZE_UNSUPPORTED";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

export function createAspectOnlyBlankPng() {
  const { width, height, rgb } = ASPECT_CANVAS;
  const row = Buffer.alloc(1 + (width * 3));
  row[0] = 0;
  for (let offset = 1; offset < row.length; offset += 3) {
    row[offset] = rgb[0];
    row[offset + 1] = rgb[1];
    row[offset + 2] = rgb[2];
  }
  const pixels = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(pixels, y * row.length);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function resolveInside(runDir, relativePath, field) {
  const normalized = nonEmptyString(relativePath, field).replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${field} must stay inside the run directory`);
  }
  const resolved = path.resolve(runDir, normalized);
  if (path.relative(runDir, resolved).replaceAll("\\", "/") !== normalized) {
    throw new Error(`${field} escapes the run directory`);
  }
  return resolved;
}

async function readJson(runDir, relativePath) {
  const filePath = resolveInside(runDir, relativePath, relativePath);
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${relativePath}: ${error.message}`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${relativePath}: ${error.message}`, { cause: error });
  }
}

function externalAttachment(asset) {
  return {
    file: asset.file,
    roles: [...asset.roles],
    assetType: asset.assetType,
    ...(asset.characterIds.length > 0 ? { characterIds: [...asset.characterIds] } : {}),
    ...(asset.views.length > 0 ? { views: [...asset.views] } : {}),
    source: "user-reference",
  };
}

function blankAttachment() {
  return {
    file: ASPECT_CANVAS.file,
    roles: ["canvas-aspect"],
    assetType: "aspect-only-blank-canvas",
    source: "adapter-generated",
    controlsOnly: ["portrait 3:4 canvas aspect"],
    mustNotControl: ["color", "palette", "style", "texture", "characters", "content", "panel geometry", "typography"],
  };
}

function generatedAnchorAttachment(anchorFile) {
  return {
    file: anchorFile,
    roles: ["identity", "style", "page-grammar"],
    assetType: "generated-page-anchor",
    source: "generated-page-01",
  };
}

function addAspectReferenceInstruction(canonicalPrompt, referenceNumber) {
  const stripped = canonicalPrompt.replace(NO_EXTERNAL_REFERENCE, "");
  const marker = "\nEXCLUSIONS\n";
  if (!stripped.includes(marker)) throw new Error("Canonical prompt is missing the EXCLUSIONS section");
  const block = [
    `- Reference image ${referenceNumber} — file: ${JSON.stringify(ASPECT_CANVAS.file)}; roles: canvas-aspect; assetType: aspect-only-blank-canvas.`,
    "- This blank reference controls only the portrait 3:4 canvas aspect.",
    "- Do not derive color, palette, style, texture, characters, story content, panel geometry, or typography from the blank reference; all of those remain controlled by the canonical locks above.",
  ].join("\n");
  return stripped.replace(marker, `\n${block}\n\nEXCLUSIONS\n`);
}

function providerOutputFile(plan, page, pageIndex) {
  if (plan.textStrategy === "post-layout") {
    return `source-images/${String(pageIndex + 1).padStart(2, "0")}.png`;
  }
  return nonEmptyString(page.outputFile, `comic-plan.pages[${pageIndex}].outputFile`);
}

function executionPhases(invocations) {
  const phases = [];
  for (const invocation of invocations) {
    const phase = invocation.dependsOn.length === 0 ? 1 : 2;
    const existing = phases.find((item) => item.phase === phase);
    if (existing) existing.pageIds.push(invocation.pageId);
    else phases.push({ phase, pageIds: [invocation.pageId] });
  }
  return phases;
}

export async function prepareCodexBuiltinRun(runDirectory) {
  const runDir = path.resolve(nonEmptyString(runDirectory, "run-dir"));
  const [input, plan, visualLock, characterBible] = await Promise.all([
    readJson(runDir, "input.json"),
    readJson(runDir, "comic-plan.json"),
    readJson(runDir, "visual-lock.json"),
    readJson(runDir, "character-bible.json"),
  ]);
  if (input?.output?.exactSize !== undefined && input.output.exactSize !== null) {
    throw new Error(`[${EXACT_SIZE_ERROR}] The interactive blank-reference evidence proves aspect only, not exact pixels.`);
  }
  if (input?.output?.aspectRatio !== "3:4" || plan?.aspectRatio !== "3:4") {
    throw new Error("Codex built-in preparation currently requires input and plan aspectRatio 3:4");
  }
  if (!Array.isArray(plan.pages) || plan.pages.length < 1 || plan.pageCount !== plan.pages.length) {
    throw new Error("comic-plan.pages must match a positive comic-plan.pageCount");
  }

  const externalReferences = collectReferenceAssets({ input, visualLock, characterBible });
  const externalAttachments = externalReferences.map(externalAttachment);
  const usesGeneratedAnchor = plan.generationStrategy === "anchor-first-fanout";
  const anchorFile = providerOutputFile(plan, plan.pages[0], 0);
  const canvasBytes = createAspectOnlyBlankPng();
  const canvasSha256 = crypto.createHash("sha256").update(canvasBytes).digest("hex");
  const invocations = [];

  await mkdir(path.join(runDir, "codex-prompts"), { recursive: true });
  await mkdir(path.dirname(resolveInside(runDir, ASPECT_CANVAS.file, "aspect canvas file")), { recursive: true });
  await writeFile(resolveInside(runDir, ASPECT_CANVAS.file, "aspect canvas file"), canvasBytes);

  for (const [pageIndex, page] of plan.pages.entries()) {
    const canonicalFile = nonEmptyString(page.promptFile, `comic-plan.pages[${pageIndex}].promptFile`);
    const canonicalPrompt = await readFile(resolveInside(runDir, canonicalFile, `comic-plan.pages[${pageIndex}].promptFile`), "utf8");
    const attachments = [...externalAttachments];
    if (usesGeneratedAnchor && pageIndex > 0) attachments.push(generatedAnchorAttachment(anchorFile));
    attachments.push(blankAttachment());

    const generatedAnchorCount = usesGeneratedAnchor && pageIndex > 0 ? 1 : 0;
    const derivedPrompt = addAspectReferenceInstruction(
      canonicalPrompt,
      externalAttachments.length + generatedAnchorCount + 1,
    );
    const derivedFile = `codex-prompts/${String(pageIndex + 1).padStart(2, "0")}.md`;
    await writeFile(resolveInside(runDir, derivedFile, `derived prompt ${pageIndex + 1}`), derivedPrompt, "utf8");

    const expectedProviderOutput = providerOutputFile(plan, page, pageIndex);
    invocations.push({
      id: `codex-builtin-${page.id}`,
      pageId: page.id,
      dependsOn: usesGeneratedAnchor && pageIndex > 0 ? [plan.pages[0].id] : [],
      prompt: { canonicalFile, derivedFile },
      attachments,
      expectedProviderOutput,
      finalOutputFile: page.outputFile,
      validation: {
        providerDirect: true,
        requiredAspectRatio: "3:4",
        exactPixelsGuaranteed: false,
        measureReturnedPngImmediately: true,
        canonicalOnePixelRoundingTolerance: true,
        nativeRequiredTextStillNeedsVisualEvaluation: plan.textStrategy === "native",
      },
      guardrails: {
        automaticRetry: false,
        preserveNoncompliantOutputAsEvidence: true,
        prohibitedPostProcessing: ["crop", "resize", "pad", "stretch", "stitch"],
      },
    });
  }

  const invocationPlan = {
    version: 3,
    preparationVersion: CODEX_BUILTIN_PREPARATION_VERSION,
    adapter: "codex-builtin",
    status: "prepared",
    providerCalls: 0,
    sharedPromptContractUnchanged: true,
    generationStrategy: plan.generationStrategy,
    aspectStrategy: {
      status: "runtime-verified",
      scope: "interactive-aspect-only",
      mechanism: "blank-reference-aspect-anchor",
      exactPixelsGuaranteed: false,
      mustMeasureEveryReturnedPage: true,
    },
    canvasReference: {
      file: ASPECT_CANVAS.file,
      width: ASPECT_CANVAS.width,
      height: ASPECT_CANVAS.height,
      aspectRatio: ASPECT_CANVAS.aspectRatio,
      sha256: canvasSha256,
    },
    executionPhases: executionPhases(invocations),
    invocations,
  };
  await writeJsonAtomic(path.join(runDir, "codex-builtin-invocations.json"), invocationPlan);
  return invocationPlan;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  if (!process.argv[2]) {
    console.error("Usage: node scripts/prepare-codex-builtin.mjs <run-dir>");
    process.exit(2);
  }
  try {
    const result = await prepareCodexBuiltinRun(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }
}
