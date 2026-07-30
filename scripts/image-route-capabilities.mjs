const DIMENSION_STATUSES = new Set(["supported", "unknown", "unsupported"]);
const DIMENSION_MECHANISMS = new Set(["size"]);
const DIMENSION_GUARANTEES = new Set(["aspect-ratio", "exact"]);
const IMAGE_OPERATIONS = new Set(["generation", "edit"]);
const EVIDENCE_LEVELS = new Set(["documented", "runtime-verified", "configured"]);

export const IMAGE_ROUTE_CAPABILITY_ERROR_CODES = Object.freeze({
  INVALID_CONFIG: "IMAGE_ROUTE_CAPABILITY_INVALID_CONFIG",
  INVALID_REQUEST: "IMAGE_ROUTE_CAPABILITY_INVALID_REQUEST",
  DIMENSION_UNKNOWN: "IMAGE_ROUTE_DIMENSION_CONTROL_UNKNOWN",
  DIMENSION_UNSUPPORTED: "IMAGE_ROUTE_DIMENSION_CONTROL_UNSUPPORTED",
  ASPECT_RATIO_MAPPING_MISSING: "IMAGE_ROUTE_ASPECT_RATIO_MAPPING_MISSING",
  ASPECT_RATIO_MAPPING_INVALID: "IMAGE_ROUTE_ASPECT_RATIO_MAPPING_INVALID",
  SIZE_NOT_REQUESTABLE: "IMAGE_ROUTE_SIZE_NOT_REQUESTABLE",
  EXACT_SIZE_NOT_GUARANTEED: "IMAGE_ROUTE_EXACT_SIZE_NOT_GUARANTEED",
  OPERATION_UNSUPPORTED: "IMAGE_ROUTE_OPERATION_UNSUPPORTED",
});

export class ImageRouteCapabilityError extends Error {
  constructor(code, message, details = {}) {
    super(`[${code}] ${message}`);
    this.name = "ImageRouteCapabilityError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new ImageRouteCapabilityError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAspectRatio(value, field = "aspectRatio") {
  if (typeof value !== "string") {
    fail(IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_REQUEST, `${field} must use W:H`, { field });
  }
  const match = value.trim().match(/^(\d+):(\d+)$/);
  if (!match) {
    fail(IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_REQUEST, `${field} must use W:H`, { field });
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    fail(IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_REQUEST, `${field} must contain positive integers`, { field });
  }
  return { value: `${width}:${height}`, width, height };
}

function normalizeSize(value, field, errorCode = IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG) {
  let width;
  let height;
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+)x(\d+)$/i);
    if (match) {
      width = Number(match[1]);
      height = Number(match[2]);
    }
  } else if (isObject(value)) {
    width = value.width;
    height = value.height;
  }
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    fail(errorCode, `${field} must use positive integer WIDTHxHEIGHT`, { field });
  }
  return { value: `${width}x${height}`, width, height };
}

function normalizeSizeList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG, `${field} must be an array`, { field });
  }
  return [...new Set(value.map((entry, index) => normalizeSize(entry, `${field}[${index}]`).value))];
}

function normalizeDimensionControl(value) {
  if (value === undefined) {
    return Object.freeze({ status: "unknown", mechanism: null, guarantee: null });
  }
  if (!isObject(value)) {
    fail(IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG, "route.dimensionControl must be an object", {
      field: "route.dimensionControl",
    });
  }
  const status = value.status;
  if (!DIMENSION_STATUSES.has(status)) {
    fail(
      IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG,
      "route.dimensionControl.status must be supported, unknown, or unsupported",
      { field: "route.dimensionControl.status" },
    );
  }
  if (status !== "supported") {
    return Object.freeze({ status, mechanism: null, guarantee: null });
  }
  if (!DIMENSION_MECHANISMS.has(value.mechanism)) {
    fail(IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG, "supported dimension control must use mechanism size", {
      field: "route.dimensionControl.mechanism",
    });
  }
  if (!DIMENSION_GUARANTEES.has(value.guarantee)) {
    fail(
      IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG,
      "supported dimension control guarantee must be aspect-ratio or exact",
      { field: "route.dimensionControl.guarantee" },
    );
  }
  return Object.freeze({
    status,
    mechanism: value.mechanism,
    guarantee: value.guarantee,
  });
}

function normalizeEvidence(value) {
  const evidence = value === undefined ? { level: "configured" } : value;
  if (!isObject(evidence) || !EVIDENCE_LEVELS.has(evidence.level)) {
    fail(
      IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG,
      "route.evidence.level must be documented, runtime-verified, or configured",
      { field: "route.evidence.level" },
    );
  }
  if (evidence.source !== undefined && (typeof evidence.source !== "string" || evidence.source.trim() === "")) {
    fail(
      IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG,
      "route.dimensionControl.evidence.source must be a non-empty string when provided",
      { field: "route.dimensionControl.evidence.source" },
    );
  }
  return Object.freeze({
    level: evidence.level,
    ...(typeof evidence.source === "string" ? { source: evidence.source.trim() } : {}),
  });
}

function normalizeOperations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG, "route.operations must be an array", {
      field: "route.operations",
    });
  }
  const operations = [];
  for (const [index, operation] of value.entries()) {
    if (!IMAGE_OPERATIONS.has(operation)) {
      fail(
        IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG,
        `route.operations[${index}] must be generation or edit`,
        { field: `route.operations[${index}]` },
      );
    }
    if (!operations.includes(operation)) operations.push(operation);
  }
  return operations;
}

function normalizeMappings(value) {
  if (value === undefined) return {};
  if (!isObject(value)) {
    fail(IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG, "route.aspectRatioSizes must be an object", {
      field: "route.aspectRatioSizes",
    });
  }
  const mappings = {};
  for (const [rawRatio, rawSize] of Object.entries(value)) {
    const ratio = parseAspectRatio(rawRatio, `route.aspectRatioSizes key ${JSON.stringify(rawRatio)}`);
    const size = normalizeSize(rawSize, `route.aspectRatioSizes[${JSON.stringify(rawRatio)}]`);
    if ((size.width * ratio.height) !== (size.height * ratio.width)) {
      fail(
        IMAGE_ROUTE_CAPABILITY_ERROR_CODES.ASPECT_RATIO_MAPPING_INVALID,
        `route.aspectRatioSizes[${JSON.stringify(rawRatio)}] maps to ${size.value}, which is not ${ratio.value}`,
        { aspectRatio: ratio.value, mappedSize: size.value },
      );
    }
    mappings[ratio.value] = size.value;
  }
  return mappings;
}

function resolvePageCount(plan) {
  if (Array.isArray(plan?.pages) && plan.pages.length > 0) return plan.pages.length;
  if (Number.isSafeInteger(plan?.pageCount) && plan.pageCount > 0) return plan.pageCount;
  return 1;
}

function normalizeReferenceAssets(referenceAssets) {
  if (referenceAssets === undefined) return [];
  if (!Array.isArray(referenceAssets)) {
    fail(IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_REQUEST, "referenceAssets must be an array", {
      field: "referenceAssets",
    });
  }
  return referenceAssets;
}

/**
 * Derive the real provider operation for each planned page. Supplying any
 * external reference makes Page 1 an edit. An anchor created by Page 1 only
 * changes later anchor-first pages into edits.
 */
export function deriveRequiredImageOperations({ plan, referenceAssets } = {}) {
  const references = normalizeReferenceAssets(referenceAssets);
  const pageCount = resolvePageCount(plan);
  const pageOperations = [];
  for (let index = 0; index < pageCount; index += 1) {
    const usesExternalReferences = references.length > 0;
    const usesGeneratedAnchor = (
      plan?.generationStrategy === "anchor-first-fanout" &&
      index > 0
    );
    const operation = usesExternalReferences || usesGeneratedAnchor ? "edit" : "generation";
    const page = Array.isArray(plan?.pages) ? plan.pages[index] : null;
    pageOperations.push(Object.freeze({
      pageId: typeof page?.id === "string" && page.id.trim() !== "" ? page.id : `page-${String(index + 1).padStart(2, "0")}`,
      operation,
      externalReferenceCount: references.length,
      generatedAnchorCount: usesGeneratedAnchor ? 1 : 0,
    }));
  }
  const requiredOperations = [...new Set(pageOperations.map((page) => page.operation))];
  return Object.freeze({
    requiredOperations: Object.freeze(requiredOperations),
    pageOperations: Object.freeze(pageOperations),
  });
}

function safeRequestPreview({ route, requestedSize, aspectRatio, exactSize, pageOperations }) {
  const model = typeof route.model === "string" ? route.model : null;
  const adapter = typeof route.adapter === "string" ? route.adapter : null;
  return Object.freeze({
    credentialsIncluded: false,
    requests: Object.freeze(pageOperations.map((page) => Object.freeze({
      pageId: page.pageId,
      operation: page.operation,
      method: "POST",
      endpointPath: page.operation === "edit" ? "/images/edits" : "/images/generations",
      body: Object.freeze({
        model,
        size: requestedSize,
        aspectRatio,
        exactSize: exactSize ?? null,
        referenceImageCount: page.externalReferenceCount + page.generatedAnchorCount,
      }),
      adapter,
    }))),
  });
}

/**
 * Pure preflight for one social-comic image route. It performs no provider or
 * file-system calls and returns a credential-free preview of every page call.
 */
export function preflightImageRouteCapabilities({
  route,
  plan,
  referenceAssets,
  aspectRatio,
  exactSize,
  input,
} = {}) {
  if (!isObject(route)) {
    fail(IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG, "route must be an object", { field: "route" });
  }
  const requestedAspect = parseAspectRatio(
    aspectRatio ?? input?.output?.aspectRatio ?? plan?.aspectRatio ?? "3:4",
  );
  const requestedExact = exactSize !== undefined
    ? exactSize
    : input?.output?.exactSize ?? plan?.exactSize;
  const normalizedExact = requestedExact === undefined || requestedExact === null
    ? null
    : normalizeSize(requestedExact, "exactSize", IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_REQUEST);
  if (normalizedExact && (normalizedExact.width * requestedAspect.height) !== (normalizedExact.height * requestedAspect.width)) {
    fail(
      IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_REQUEST,
      `exactSize ${normalizedExact.value} is not ${requestedAspect.value}`,
      { aspectRatio: requestedAspect.value, exactSize: normalizedExact.value },
    );
  }

  const dimensionControl = normalizeDimensionControl(route.dimensionControl);
  // Capability metadata belongs to dimensionControl. Top-level aliases remain
  // accepted so a host can migrate an already resolved route without changing
  // the meaning of supportedSizes or exactOutputSizes.
  const evidence = normalizeEvidence(route.dimensionControl?.evidence ?? route.evidence);
  const operations = normalizeOperations(route.dimensionControl?.operations ?? route.operations);
  const mappings = normalizeMappings(route.aspectRatioSizes);
  const supportedSizes = normalizeSizeList(route.supportedSizes, "route.supportedSizes");
  const exactOutputSizes = normalizeSizeList(route.exactOutputSizes, "route.exactOutputSizes");

  for (const guaranteedSize of exactOutputSizes) {
    if (!supportedSizes.includes(guaranteedSize)) {
      fail(
        IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG,
        `route.exactOutputSizes contains ${guaranteedSize}, but it is not requestable via route.supportedSizes`,
        { exactOutputSize: guaranteedSize },
      );
    }
  }
  if (dimensionControl.status === "unknown") {
    fail(
      IMAGE_ROUTE_CAPABILITY_ERROR_CODES.DIMENSION_UNKNOWN,
      `the route has no verified dimension-control decision for ${requestedAspect.value}`,
      { aspectRatio: requestedAspect.value, evidenceLevel: evidence.level },
    );
  }
  if (dimensionControl.status === "unsupported") {
    fail(
      IMAGE_ROUTE_CAPABILITY_ERROR_CODES.DIMENSION_UNSUPPORTED,
      `the route declares dimension control unsupported for ${requestedAspect.value}`,
      { aspectRatio: requestedAspect.value, evidenceLevel: evidence.level },
    );
  }

  let requestedSize;
  if (normalizedExact) {
    requestedSize = normalizedExact.value;
  } else {
    requestedSize = mappings[requestedAspect.value];
    if (!requestedSize) {
      fail(
        IMAGE_ROUTE_CAPABILITY_ERROR_CODES.ASPECT_RATIO_MAPPING_MISSING,
        `route.aspectRatioSizes does not define ${requestedAspect.value}`,
        { aspectRatio: requestedAspect.value },
      );
    }
  }
  if (!supportedSizes.includes(requestedSize)) {
    fail(
      IMAGE_ROUTE_CAPABILITY_ERROR_CODES.SIZE_NOT_REQUESTABLE,
      `${requestedSize} is not listed in route.supportedSizes and cannot be requested`,
      { requestedSize, supportedSizes },
    );
  }
  if (normalizedExact && !exactOutputSizes.includes(requestedSize)) {
    fail(
      IMAGE_ROUTE_CAPABILITY_ERROR_CODES.EXACT_SIZE_NOT_GUARANTEED,
      `${requestedSize} is requestable but is not listed in route.exactOutputSizes`,
      { requestedSize, exactOutputSizes },
    );
  }
  if (
    !normalizedExact &&
    dimensionControl.guarantee === "exact" &&
    !exactOutputSizes.includes(requestedSize)
  ) {
    fail(
      IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG,
      `dimensionControl.guarantee exact requires mapped size ${requestedSize} in route.exactOutputSizes`,
      { requestedSize },
    );
  }

  const operationRequirements = deriveRequiredImageOperations({ plan, referenceAssets });
  const missingOperations = operationRequirements.requiredOperations.filter((operation) => !operations.includes(operation));
  if (missingOperations.length > 0) {
    fail(
      IMAGE_ROUTE_CAPABILITY_ERROR_CODES.OPERATION_UNSUPPORTED,
      `route.operations does not support required operation(s): ${missingOperations.join(", ")}`,
      {
        requiredOperations: operationRequirements.requiredOperations,
        supportedOperations: operations,
        missingOperations,
      },
    );
  }

  const exactSizeValue = normalizedExact?.value ?? null;
  const resolvedDimensionControl = Object.freeze({
    ...dimensionControl,
    operations: Object.freeze(operations),
    evidence,
  });
  return Object.freeze({
    ok: true,
    dimensionControl: resolvedDimensionControl,
    operations: Object.freeze(operations),
    evidence,
    supportedSizes: Object.freeze(supportedSizes),
    exactOutputSizes: Object.freeze(exactOutputSizes),
    requiredOperations: operationRequirements.requiredOperations,
    pageOperations: operationRequirements.pageOperations,
    request: Object.freeze({
      aspectRatio: requestedAspect.value,
      exactSize: exactSizeValue,
      requestedSize,
      guarantee: normalizedExact ? "exact" : dimensionControl.guarantee,
    }),
    requestPreview: safeRequestPreview({
      route,
      requestedSize,
      aspectRatio: requestedAspect.value,
      exactSize: exactSizeValue,
      pageOperations: operationRequirements.pageOperations,
    }),
  });
}

// Concise alias for hosts that name the preflight after the route rather than
// the capability record.
export const preflightImageRoute = preflightImageRouteCapabilities;

export const IMAGE_ROUTE_DIMENSION_STATUSES = Object.freeze([...DIMENSION_STATUSES]);
export const IMAGE_ROUTE_OPERATIONS = Object.freeze([...IMAGE_OPERATIONS]);
export const IMAGE_ROUTE_EVIDENCE_LEVELS = Object.freeze([...EVIDENCE_LEVELS]);
