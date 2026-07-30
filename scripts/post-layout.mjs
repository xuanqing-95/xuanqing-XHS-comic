import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { pngMetadata, readJson } from "./run-artifacts.mjs";

export const POST_LAYOUT_BASIS = 1000;
export const POST_LAYOUT_ENGINE = "sharp-svg-v1";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

const KINDS = new Set(["title", "speech", "thought", "caption"]);
const TAILS = new Set(["none", "left", "right"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sourceFileForPage(page) {
  return path.posix.join("source-images", path.posix.basename(page.outputFile));
}

export function postLayoutSourceFile(page) {
  if (!page || !nonEmptyString(page.outputFile)) throw new TypeError("page.outputFile must be a non-empty string");
  return sourceFileForPage(page);
}

function placementErrors(page, pageIndex) {
  const errors = [];
  const base = `comicPlan.pages[${pageIndex}].textPlacements`;
  if (!Array.isArray(page.textPlacements)) return [`${base} must be an array for post-layout`];
  if (page.textPlacements.length !== page.requiredText.length) {
    errors.push(`${base} must contain exactly one placement for every requiredText item`);
  }
  const panelIds = new Set(page.panels.map((panel) => panel.id));
  const ids = new Set();
  const indexes = new Set();
  const boxes = [];
  for (const [index, placement] of page.textPlacements.entries()) {
    const field = `${base}[${index}]`;
    if (!isObject(placement)) {
      errors.push(`${field} must be an object`);
      continue;
    }
    if (!nonEmptyString(placement.id)) errors.push(`${field}.id must be a non-empty string`);
    if (ids.has(placement.id)) errors.push(`${field}.id must be unique within the page`);
    ids.add(placement.id);
    if (!Number.isInteger(placement.requiredTextIndex) || placement.requiredTextIndex < 0 || placement.requiredTextIndex >= page.requiredText.length) {
      errors.push(`${field}.requiredTextIndex must identify one page.requiredText item`);
    } else {
      if (indexes.has(placement.requiredTextIndex)) errors.push(`${field}.requiredTextIndex must be unique within the page`);
      indexes.add(placement.requiredTextIndex);
      if (placement.text !== page.requiredText[placement.requiredTextIndex]) {
        errors.push(`${field}.text must exactly equal page.requiredText[${placement.requiredTextIndex}]`);
      }
    }
    if (!panelIds.has(placement.panelId)) errors.push(`${field}.panelId must identify one panel on the same page`);
    if (!KINDS.has(placement.kind)) errors.push(`${field}.kind must be title, speech, thought, or caption`);
    if (!TAILS.has(placement.tail)) errors.push(`${field}.tail must be none, left, or right`);
    const box = placement.box;
    if (!isObject(box)) {
      errors.push(`${field}.box must be an object in normalized 0..${POST_LAYOUT_BASIS} coordinates`);
      continue;
    }
    for (const key of ["x", "y", "width", "height"]) {
      if (!Number.isInteger(box[key])) errors.push(`${field}.box.${key} must be an integer`);
    }
    if (![box.x, box.y, box.width, box.height].every(Number.isInteger)) continue;
    if (box.x < 0 || box.y < 0 || box.width < 100 || box.height < 60 || box.x + box.width > POST_LAYOUT_BASIS || box.y + box.height > POST_LAYOUT_BASIS) {
      errors.push(`${field}.box must stay inside the page and be at least 100x60 normalized units`);
    }
    boxes.push({ index, ...box });
  }
  if (indexes.size !== page.requiredText.length) {
    errors.push(`${base} must cover every requiredText index exactly once`);
  }
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left];
      const b = boxes[right];
      const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      if (overlapWidth * overlapHeight > 0) {
        errors.push(`${base}[${a.index}].box and ${base}[${b.index}].box must not overlap`);
      }
    }
  }
  return errors;
}

export function validatePostLayoutPlan({ input, plan }) {
  const errors = [];
  const strategy = input?.output?.textStrategy ?? plan?.textStrategy;
  if (strategy === "post-layout") {
    if (plan?.compositionFreedom !== "director-locked") {
      errors.push("post-layout requires comicPlan.compositionFreedom director-locked so reserved text regions are executable rather than guessed after generation");
    }
    for (const [index, page] of (plan?.pages || []).entries()) errors.push(...placementErrors(page, index));
  } else {
    for (const [index, page] of (plan?.pages || []).entries()) {
      if (page.textPlacements !== undefined) {
        errors.push(`comicPlan.pages[${index}].textPlacements is allowed only for post-layout`);
      }
    }
  }
  return errors;
}

export function buildLetteringPlan(plan) {
  if (plan?.textStrategy !== "post-layout") return null;
  return {
    version: 3,
    status: "planned",
    engineContract: POST_LAYOUT_ENGINE,
    coordinateSpace: { unit: "normalized-integer", basis: POST_LAYOUT_BASIS },
    overflowPolicy: "fail",
    pages: plan.pages.map((page) => ({
      pageId: page.id,
      sourceFile: sourceFileForPage(page),
      outputFile: page.outputFile,
      requiredText: page.requiredText,
      placements: page.textPlacements,
    })),
  };
}

function stableCode(error, code) {
  error.code = code;
  error.message = `[${code}] ${error.message}`;
  return error;
}

function requireRoute(condition, message, code = "POST_LAYOUT_ROUTE_INVALID") {
  if (!condition) throw stableCode(new Error(message), code);
}

export async function loadPostLayoutRoute(routePath) {
  requireRoute(nonEmptyString(routePath), "A compositor route JSON is required.");
  const absolute = path.resolve(routePath);
  const route = await readJson(absolute);
  requireRoute(route.capability === "post-layout", "route.capability must be post-layout");
  requireRoute(route.engine === POST_LAYOUT_ENGINE, `route.engine must be ${POST_LAYOUT_ENGINE}`);
  requireRoute(nonEmptyString(route.fontFamily), "route.fontFamily must be a non-empty string");
  requireRoute(nonEmptyString(route.fontFile), "route.fontFile must be a non-empty path");
  requireRoute(/^[a-f0-9]{64}$/i.test(route.fontSha256 || ""), "route.fontSha256 must be a SHA-256 hex digest");
  requireRoute(Number.isInteger(route.minFontPx) && route.minFontPx >= 8, "route.minFontPx must be an integer of at least 8");
  requireRoute(Number.isInteger(route.maxFontPx) && route.maxFontPx >= route.minFontPx, "route.maxFontPx must be an integer no smaller than minFontPx");
  const routeDirectory = path.dirname(absolute);
  return {
    ...route,
    fontFile: path.isAbsolute(route.fontFile) ? route.fontFile : path.resolve(routeDirectory, route.fontFile),
    routeFile: absolute,
    routeDirectory,
  };
}

function parseCharset(source) {
  const ranges = [];
  for (const token of String(source).trim().split(/\s+/)) {
    if (!token) continue;
    const [startText, endText = startText] = token.split("-");
    const start = Number.parseInt(startText, 16);
    const end = Number.parseInt(endText, 16);
    if (Number.isInteger(start) && Number.isInteger(end)) ranges.push([start, end]);
  }
  return ranges;
}

function charsetIncludes(ranges, codePoint) {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function uniqueCodePoints(strings) {
  return [...new Set(strings.flatMap((value) => [...value].map((character) => character.codePointAt(0))))];
}

async function verifyFont(route, texts) {
  const fontFile = path.resolve(route.fontFile);
  try {
    await access(fontFile);
  } catch (error) {
    throw stableCode(new Error(`Configured font file does not exist: ${fontFile}`, { cause: error }), "POST_LAYOUT_FONT_MISSING");
  }
  const familyQuery = spawnSync("fc-query", ["-f", "%{family}", fontFile], { encoding: "utf8" });
  if (familyQuery.status !== 0 || !familyQuery.stdout.trim()) {
    throw stableCode(new Error(`fc-query could not inspect the configured font: ${fontFile}.`), "POST_LAYOUT_FONT_RESOLUTION_UNAVAILABLE");
  }
  const matchedFamily = familyQuery.stdout.trim();
  if (!matchedFamily.split(",").map((item) => item.trim()).includes(route.fontFamily)) {
    throw stableCode(new Error(`Configured font file declares ${matchedFamily}, not ${route.fontFamily}.`), "POST_LAYOUT_FONT_MISMATCH");
  }
  const query = spawnSync("fc-query", ["-f", "%{charset}", fontFile], { encoding: "utf8" });
  if (query.status !== 0 || !query.stdout.trim()) {
    throw stableCode(new Error(`fc-query could not inspect glyph coverage for ${fontFile}.`), "POST_LAYOUT_FONT_COVERAGE_UNAVAILABLE");
  }
  const charset = parseCharset(query.stdout);
  const missing = uniqueCodePoints(texts).filter((codePoint) => !charsetIncludes(charset, codePoint));
  if (missing.length > 0) {
    const labels = missing.map((codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`).join(", ");
    throw stableCode(new Error(`Configured font is missing required glyphs: ${labels}`), "POST_LAYOUT_FONT_GLYPH_MISSING");
  }
  const bytes = await readFile(fontFile);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== route.fontSha256.toLowerCase()) {
    throw stableCode(new Error(`Configured font hash is ${sha256}, not ${route.fontSha256}.`), "POST_LAYOUT_FONT_HASH_MISMATCH");
  }
  return {
    family: route.fontFamily,
    file: fontFile,
    sha256,
  };
}

async function loadSharp(route) {
  const candidates = [];
  if (nonEmptyString(route.sharpModulePath)) {
    candidates.push(path.isAbsolute(route.sharpModulePath)
      ? route.sharpModulePath
      : path.resolve(route.routeDirectory, route.sharpModulePath));
  }
  if (nonEmptyString(process.env.SOCIAL_COMIC_SHARP_MODULE)) candidates.push(process.env.SOCIAL_COMIC_SHARP_MODULE);
  candidates.push("sharp");
  const errors = [];
  for (const candidate of candidates) {
    try {
      const imported = candidate === "sharp" ? await import(candidate) : await import(pathToFileURL(candidate).href);
      const sharp = imported.default || imported;
      if (typeof sharp === "function") return { sharp, module: candidate };
    } catch (error) {
      errors.push(`${candidate}: ${error.code || error.message}`);
    }
  }
  throw stableCode(new Error(`Sharp is unavailable. Tried ${errors.join("; ")}`), "POST_LAYOUT_ENGINE_UNAVAILABLE");
}

async function configureFontEnvironment(route) {
  const root = path.join(os.tmpdir(), "social-comic-fontconfig", route.fontSha256.slice(0, 16));
  const cache = path.join(root, "cache");
  const config = path.join(root, "fonts.conf");
  await mkdir(cache, { recursive: true });
  const fontDirectory = path.dirname(route.fontFile)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const cacheDirectory = cache
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const xml = `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir>${fontDirectory}</dir><cachedir>${cacheDirectory}</cachedir></fontconfig>`;
  await writeFile(config, xml, "utf8");
  process.env.FONTCONFIG_FILE = config;
  process.env.FONTCONFIG_PATH = root;
  return { config, cache };
}

export async function preflightPostLayout({ input, plan, route }) {
  const errors = validatePostLayoutPlan({ input, plan });
  if (errors.length > 0) {
    throw stableCode(new Error(errors.join("\n")), "POST_LAYOUT_CONTRACT_INVALID");
  }
  requireRoute(input?.output?.textStrategy === "post-layout", "Compositor may run only when textStrategy is post-layout", "POST_LAYOUT_NOT_REQUESTED");
  const texts = plan.pages.flatMap((page) => page.requiredText);
  const fontEnvironment = await configureFontEnvironment(route);
  const [font, engine] = await Promise.all([verifyFont(route, texts), loadSharp(route)]);
  return {
    ok: true,
    engine: route.engine,
    engineModule: engine.module,
    font,
    fontEnvironment,
    pages: plan.pages.map((page) => ({
      pageId: page.id,
      sourceFile: sourceFileForPage(page),
      outputFile: page.outputFile,
      placementCount: page.textPlacements.length,
    })),
    _sharp: engine.sharp,
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function graphemes(text) {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
  return [...segmenter.segment(text)].map((item) => item.segment);
}

function unitWidth(grapheme) {
  if (/^\s$/u.test(grapheme)) return 0.35;
  if (/^[\u0000-\u00ff]$/u.test(grapheme)) return 0.56;
  return 1;
}

function wrapAtSize(text, innerWidth, innerHeight, fontSize, lineHeightRatio) {
  const maxUnits = innerWidth / fontSize;
  const lines = [];
  let line = "";
  let units = 0;
  for (const grapheme of graphemes(text)) {
    if (grapheme === "\n") {
      lines.push(line);
      line = "";
      units = 0;
      continue;
    }
    const width = unitWidth(grapheme);
    if (line && units + width > maxUnits) {
      lines.push(line.trimEnd());
      line = grapheme.trimStart();
      units = line ? width : 0;
    } else {
      line += grapheme;
      units += width;
    }
  }
  if (line || lines.length === 0) lines.push(line);
  const lineHeight = fontSize * lineHeightRatio;
  const fits = lines.every((item) => graphemes(item).reduce((sum, item2) => sum + unitWidth(item2), 0) * fontSize <= innerWidth + 0.5) && lines.length * lineHeight <= innerHeight + 0.5;
  return { fits, lines, lineHeight };
}

function layoutText(text, box, route) {
  const padding = Math.max(6, Math.round(Math.min(box.width, box.height) * (route.paddingRatio ?? 0.1)));
  const innerWidth = box.width - padding * 2;
  const innerHeight = box.height - padding * 2;
  const maxFont = Math.min(route.maxFontPx, Math.floor(innerHeight * 0.55));
  for (let fontSize = maxFont; fontSize >= route.minFontPx; fontSize -= 1) {
    const wrapped = wrapAtSize(text, innerWidth, innerHeight, fontSize, route.lineHeightRatio ?? 1.25);
    if (wrapped.fits) return { ...wrapped, fontSize, padding, innerWidth, innerHeight };
  }
  throw stableCode(new Error(`Text cannot fit its declared box at minFontPx=${route.minFontPx}: ${JSON.stringify(text)}`), "POST_LAYOUT_TEXT_OVERFLOW");
}

function pixelBox(box, width, height) {
  return {
    x: Math.round((box.x / POST_LAYOUT_BASIS) * width),
    y: Math.round((box.y / POST_LAYOUT_BASIS) * height),
    width: Math.round((box.width / POST_LAYOUT_BASIS) * width),
    height: Math.round((box.height / POST_LAYOUT_BASIS) * height),
  };
}

function shapeSvg(placement, box, route) {
  const fill = escapeXml(route.bubbleFill || "#fffdf8");
  const stroke = escapeXml(route.bubbleStroke || "#171717");
  const strokeWidth = Number.isFinite(route.bubbleStrokeWidth) ? route.bubbleStrokeWidth : 3;
  const inset = Math.max(1, Math.ceil(strokeWidth / 2));
  const radius = Math.max(8, Math.round(Math.min(box.width, box.height) * 0.14));
  const bodyHeight = placement.kind === "speech" || placement.kind === "thought" ? Math.round(box.height * 0.86) : box.height;
  const body = `<rect x="${box.x + inset}" y="${box.y + inset}" width="${Math.max(1, box.width - inset * 2)}" height="${Math.max(1, bodyHeight - inset * 2)}" rx="${radius}" fill="${fill}" fill-opacity="0.96" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  if ((placement.kind !== "speech" && placement.kind !== "thought") || placement.tail === "none") return body;
  const tailCenter = placement.tail === "left" ? box.x + box.width * 0.25 : box.x + box.width * 0.75;
  const tailHalf = Math.max(7, box.width * 0.06);
  const tail = `<path d="M ${tailCenter - tailHalf} ${box.y + bodyHeight - strokeWidth - inset} L ${tailCenter} ${box.y + box.height - strokeWidth - inset} L ${tailCenter + tailHalf} ${box.y + bodyHeight - strokeWidth - inset}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`;
  return `${body}${tail}`;
}

function createBubbleOverlay(page, width, height, route) {
  const records = [];
  const elements = [];
  for (const placement of page.textPlacements) {
    const box = pixelBox(placement.box, width, height);
    const layout = layoutText(placement.text, box, route);
    elements.push(shapeSvg(placement, box, route));
    records.push({
      placementId: placement.id,
      panelId: placement.panelId,
      requiredTextIndex: placement.requiredTextIndex,
      text: placement.text,
      unicodeCodePoints: [...placement.text].map((character) => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`),
      normalizedBox: placement.box,
      pixelBox: box,
      kind: placement.kind,
      tail: placement.tail,
      fontSize: layout.fontSize,
      lineHeight: layout.lineHeight,
      padding: layout.padding,
      lines: layout.lines,
      fittedAtOrAboveMinimum: true,
    });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements.join("")}</svg>`;
  return { svg: Buffer.from(svg), records };
}

function escapePango(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function renderTextLayer(sharp, record, route) {
  const bodyHeight = record.kind === "speech" || record.kind === "thought"
    ? Math.round(record.pixelBox.height * 0.86)
    : record.pixelBox.height;
  const width = Math.max(1, record.pixelBox.width - record.padding * 2);
  const height = Math.max(1, bodyHeight - record.padding * 2);
  const text = `<span foreground="${escapePango(route.textColor || "#111111")}" weight="${route.fontWeight || 500}">${record.lines.map(escapePango).join("\n")}</span>`;
  const buffer = await sharp({
    text: {
      text,
      font: `${route.fontFamily} ${record.fontSize}`,
      fontfile: route.fontFile,
      width,
      height,
      align: "centre",
      justify: false,
      rgba: true,
      spacing: Math.max(0, Math.round(record.lineHeight - record.fontSize)),
    },
  }).png().toBuffer();
  const raw = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = raw.info.width;
  let minY = raw.info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < raw.info.height; y += 1) {
    for (let x = 0; x < raw.info.width; x += 1) {
      if (raw.data[(y * raw.info.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) throw stableCode(new Error(`Text layer rendered no visible glyphs: ${JSON.stringify(record.text)}`), "POST_LAYOUT_EMPTY_TEXT_LAYER");
  return {
    input: buffer,
    left: record.pixelBox.x + record.padding,
    top: record.pixelBox.y + record.padding,
    actualTextBounds: {
      x: record.pixelBox.x + record.padding + minX,
      y: record.pixelBox.y + record.padding + minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    },
  };
}

function inAllowedBox(x, y, boxes) {
  return boxes.some((box) => x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height);
}

async function auditPixelChanges(sharp, sourcePath, candidatePath, boxes, width, height) {
  const [source, candidate] = await Promise.all([
    sharp(sourcePath).ensureAlpha().raw().toBuffer(),
    sharp(candidatePath).ensureAlpha().raw().toBuffer(),
  ]);
  if (source.length !== candidate.length || source.length !== width * height * 4) {
    throw stableCode(new Error("Raw pixel buffers do not match the expected canvas."), "POST_LAYOUT_PIXEL_AUDIT_FAILED");
  }
  let changedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    if (source[offset] === candidate[offset] && source[offset + 1] === candidate[offset + 1] && source[offset + 2] === candidate[offset + 2] && source[offset + 3] === candidate[offset + 3]) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (!inAllowedBox(x, y, boxes)) {
      throw stableCode(new Error(`Compositor changed a pixel outside declared placement boxes at ${x},${y}.`), "POST_LAYOUT_OUTSIDE_REGION_MUTATION");
    }
    changedPixels += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (changedPixels === 0) throw stableCode(new Error("Compositor produced no visible pixel changes."), "POST_LAYOUT_EMPTY_COMPOSITE");
  return {
    changedPixels,
    changedBounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    outsideDeclaredRegionsUnchanged: true,
    alphaOutsideDeclaredRegionsUnchanged: true,
  };
}

export async function composePostLayoutPage({ runDir, page, route, preflight, sourceProvenance }) {
  const sharp = preflight?._sharp || (await loadSharp(route)).sharp;
  const sourceFile = sourceFileForPage(page);
  const sourcePath = path.join(runDir, sourceFile);
  const outputPath = path.join(runDir, page.outputFile);
  const sourceMetadata = await pngMetadata(sourcePath);
  if (
    sourceProvenance?.pageId !== page.id
    || sourceProvenance?.sourceFile !== sourceFile
    || sourceProvenance?.sourceSha256 !== sourceMetadata.sha256
    || sourceProvenance?.sourceDimensions?.width !== sourceMetadata.width
    || sourceProvenance?.sourceDimensions?.height !== sourceMetadata.height
  ) {
    throw stableCode(new Error(`Verified generation provenance is missing or stale for ${sourceFile}.`), "POST_LAYOUT_SOURCE_PROVENANCE_STALE");
  }
  const { svg, records } = createBubbleOverlay(page, sourceMetadata.width, sourceMetadata.height, route);
  const boxes = records.map((record) => record.pixelBox);
  const textLayers = await Promise.all(records.map((record) => renderTextLayer(sharp, record, route)));
  for (const [index, layer] of textLayers.entries()) records[index].actualTextBounds = layer.actualTextBounds;
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp.png`);
  try {
    await sharp(sourcePath).composite([
      { input: svg, top: 0, left: 0 },
      ...textLayers.map(({ actualTextBounds, ...layer }) => layer),
    ]).png().toFile(temporaryPath);
    const finalMetadata = await pngMetadata(temporaryPath);
    if (finalMetadata.width !== sourceMetadata.width || finalMetadata.height !== sourceMetadata.height) {
      throw stableCode(new Error(`Canvas changed from ${sourceMetadata.width}x${sourceMetadata.height} to ${finalMetadata.width}x${finalMetadata.height}.`), "POST_LAYOUT_DIMENSION_MUTATION");
    }
    const pixelAudit = await auditPixelChanges(sharp, sourcePath, temporaryPath, boxes, sourceMetadata.width, sourceMetadata.height);
    const sourceAfterCompose = await pngMetadata(sourcePath);
    if (sourceAfterCompose.sha256 !== sourceMetadata.sha256) {
      throw stableCode(new Error(`Provider source ${sourceFile} changed during composition.`), "POST_LAYOUT_SOURCE_CHANGED_DURING_COMPOSE");
    }
    await rename(temporaryPath, outputPath);
    return {
      pageId: page.id,
      sourceFile,
      outputFile: page.outputFile,
      sourceDimensions: { width: sourceMetadata.width, height: sourceMetadata.height },
      outputDimensions: { width: finalMetadata.width, height: finalMetadata.height },
      sourceSha256: sourceMetadata.sha256,
      outputSha256: finalMetadata.sha256,
      generationProvenance: sourceProvenance,
      placements: records,
      pixelAudit,
    };
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
