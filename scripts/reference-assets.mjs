const ALLOWED_ROLES = new Set(["identity", "style", "page-grammar"]);
const ALLOWED_ASSET_TYPES = new Set([
  "reference",
  "character-reference",
  "character-sheet",
  "three-view",
  "expression-sheet",
  "approved-page",
  "style-reference",
]);
const ALLOWED_VIEWS = new Set(["front", "side", "back", "three-quarter", "expression"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(nonEmptyString).map((item) => item.trim()))];
}

function asStringArray(value, singular) {
  if (Array.isArray(value)) return uniqueStrings(value);
  if (nonEmptyString(singular)) return [singular.trim()];
  return [];
}

function inferredRoles(assetType) {
  if (["character-reference", "character-sheet", "three-view", "expression-sheet"].includes(assetType)) {
    return ["identity"];
  }
  if (assetType === "style-reference") return ["style", "page-grammar"];
  if (assetType === "approved-page") return ["identity", "style", "page-grammar"];
  return [];
}

/**
 * Normalize a reference path or metadata object without resolving it on disk.
 * Source defaults express the meaning of the input field; explicit object
 * metadata always wins over those defaults.
 */
export function normalizeReferenceAsset(entry, defaults = {}) {
  if (nonEmptyString(entry)) {
    return {
      file: entry.trim(),
      roles: uniqueStrings(defaults.roles),
      assetType: nonEmptyString(defaults.assetType) ? defaults.assetType.trim() : "reference",
      characterIds: uniqueStrings(defaults.characterIds),
      views: uniqueStrings(defaults.views),
    };
  }
  if (!isObject(entry)) return null;
  const file = entry.file ?? entry.path ?? entry.image;
  if (!nonEmptyString(file)) return null;
  const assetType = nonEmptyString(entry.assetType)
    ? entry.assetType.trim()
    : nonEmptyString(defaults.assetType)
      ? defaults.assetType.trim()
      : "reference";
  const explicitRoles = asStringArray(entry.roles, entry.role);
  const roles = explicitRoles.length > 0
    ? explicitRoles
    : uniqueStrings(defaults.roles).length > 0
      ? uniqueStrings(defaults.roles)
      : inferredRoles(assetType);
  const characterIds = asStringArray(entry.characterIds, entry.characterId);
  const views = asStringArray(entry.views, entry.view);
  const normalized = {
    file: file.trim(),
    roles,
    assetType,
    characterIds: characterIds.length > 0 ? characterIds : uniqueStrings(defaults.characterIds),
    views: views.length > 0 ? views : uniqueStrings(defaults.views),
  };
  if (nonEmptyString(entry.assetId)) normalized.assetId = entry.assetId.trim();
  if (isObject(entry.provenance)) normalized.provenance = { ...entry.provenance };
  if (entry.continuityAnchor === true) normalized.continuityAnchor = true;
  return normalized;
}

function sourceEntries({ input, visualLock, characterBible }) {
  const entries = [];
  function addMany(values, source, defaults = {}, inputSupplied = false) {
    for (const [index, entry] of (Array.isArray(values) ? values : []).entries()) {
      entries.push({ entry, source: `${source}[${index}]`, defaults, inputSupplied });
    }
  }

  addMany(input?.visual?.referenceImages, "input.visual.referenceImages", {}, true);
  addMany(input?.series?.characterAnchorFiles, "input.series.characterAnchorFiles", {
    roles: ["identity"],
    assetType: "character-reference",
  }, true);
  addMany(input?.series?.styleAnchorFiles, "input.series.styleAnchorFiles", {
    roles: ["style", "page-grammar"],
    assetType: "style-reference",
  }, true);
  for (const [characterIndex, character] of (characterBible?.characters ?? []).entries()) {
    addMany(character?.referenceImages, `characterBible.characters[${characterIndex}].referenceImages`, {
      roles: ["identity"],
      assetType: "character-reference",
      characterIds: nonEmptyString(character?.id) ? [character.id] : [],
    });
  }
  addMany(characterBible?.seriesAssets?.characterSheetFiles, "characterBible.seriesAssets.characterSheetFiles", {
    roles: ["identity"],
    assetType: "character-sheet",
  });
  addMany(characterBible?.seriesAssets?.styleAnchorFiles, "characterBible.seriesAssets.styleAnchorFiles", {
    roles: ["style", "page-grammar"],
    assetType: "style-reference",
  });
  addMany(visualLock?.referenceImages, "visualLock.referenceImages");
  return entries;
}

function mergeAsset(existing, next, source) {
  for (const role of next.roles) if (!existing.roles.includes(role)) existing.roles.push(role);
  for (const id of next.characterIds) if (!existing.characterIds.includes(id)) existing.characterIds.push(id);
  for (const view of next.views) if (!existing.views.includes(view)) existing.views.push(view);
  if (existing.assetType === "reference" && next.assetType !== "reference") existing.assetType = next.assetType;
  if (!existing.assetId && next.assetId) existing.assetId = next.assetId;
  if (!existing.provenance && next.provenance) existing.provenance = next.provenance;
  if (next.continuityAnchor === true) existing.continuityAnchor = true;
  if (!existing.sources.includes(source)) existing.sources.push(source);
  return existing;
}

/**
 * Collect every externally supplied reference in deterministic first-seen
 * order. Duplicate paths merge metadata without moving their attachment slot.
 */
export function collectReferenceAssets({ input, visualLock, characterBible }) {
  const byFile = new Map();
  const assets = [];
  for (const { entry, source, defaults, inputSupplied } of sourceEntries({ input, visualLock, characterBible })) {
    const normalized = normalizeReferenceAsset(entry, defaults);
    if (!normalized) continue;
    const existing = byFile.get(normalized.file);
    if (existing) {
      mergeAsset(existing, normalized, source);
      continue;
    }
    // Planner artifacts may repeat and enrich user references, but they do not
    // gain authority to introduce a new external file path. This also prevents
    // an internal current-run Page 1 anchor from being attached before it exists.
    if (!inputSupplied) continue;
    const asset = { ...normalized, inputSupplied: true, sources: [source] };
    byFile.set(asset.file, asset);
    assets.push(asset);
  }
  return assets;
}

export function referenceAssetFile(entry) {
  return normalizeReferenceAsset(entry)?.file ?? null;
}

/** Return the canonical external comparison anchor without inventing an asset. */
export function selectContinuityAnchorAsset({ input, visualLock, characterBible }) {
  const assets = collectReferenceAssets({ input, visualLock, characterBible });
  const requestedFile = referenceAssetFile(input?.series?.continuityAnchorFile);
  if (requestedFile) return assets.find((asset) => asset.file === requestedFile) ?? null;
  const explicit = assets.find((asset) => asset.continuityAnchor === true);
  if (explicit) return explicit;
  return assets.find((asset) => asset.assetType === "approved-page")
    ?? assets.find((asset) => asset.sources.some((source) => source.startsWith("input.series.characterAnchorFiles")))
    ?? assets.find((asset) => asset.sources.some((source) => source.startsWith("input.visual.referenceImages")))
    ?? assets.find((asset) => asset.roles.includes("identity"))
    ?? null;
}

/**
 * Validate only declared reference semantics. It deliberately does not require
 * users to create reference images, character sheets, or three-view assets.
 */
export function validateReferenceAssets({ input, visualLock, characterBible }) {
  const errors = [];
  const characterIds = new Set((characterBible?.characters ?? []).map((character) => character?.id).filter(nonEmptyString));
  for (const { entry, source, defaults } of sourceEntries({ input, visualLock, characterBible })) {
    const asset = normalizeReferenceAsset(entry, defaults);
    if (!asset) {
      errors.push(`${source} must be a path string or an object with file/path/image`);
      continue;
    }
    if (!ALLOWED_ASSET_TYPES.has(asset.assetType)) {
      errors.push(`${source}.assetType is unsupported: ${asset.assetType}`);
    }
    for (const role of asset.roles) {
      if (!ALLOWED_ROLES.has(role)) errors.push(`${source}.roles contains unsupported role: ${role}`);
    }
    for (const id of asset.characterIds) {
      if (!characterIds.has(id)) errors.push(`${source}.characterIds contains unknown character id: ${id}`);
    }
    for (const view of asset.views) {
      if (!ALLOWED_VIEWS.has(view)) errors.push(`${source}.views contains unsupported view: ${view}`);
    }
    if (asset.assetType === "three-view") {
      for (const requiredView of ["front", "side", "back"]) {
        if (!asset.views.includes(requiredView)) errors.push(`${source} declares assetType three-view but is missing view: ${requiredView}`);
      }
    }
  }

  const assets = collectReferenceAssets({ input, visualLock, characterBible });
  for (const asset of assets) {
    if (asset.roles.length === 0) {
      errors.push(`reference ${asset.file} must declare at least one controlling role`);
    }
  }
  const requestedAnchor = referenceAssetFile(input?.series?.continuityAnchorFile);
  if (input?.series?.continuityAnchorFile !== undefined && !requestedAnchor) {
    errors.push("input.series.continuityAnchorFile must be a path string or an object with file/path/image");
  } else if (requestedAnchor && !assets.some((asset) => asset.file === requestedAnchor)) {
    errors.push("input.series.continuityAnchorFile must reference one of the supplied reference assets");
  }
  return errors;
}

export const REFERENCE_ASSET_ROLES = Object.freeze([...ALLOWED_ROLES]);
export const REFERENCE_ASSET_TYPES = Object.freeze([...ALLOWED_ASSET_TYPES]);
export const REFERENCE_ASSET_VIEWS = Object.freeze([...ALLOWED_VIEWS]);
