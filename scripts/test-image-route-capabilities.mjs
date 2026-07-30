#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  IMAGE_ROUTE_CAPABILITY_ERROR_CODES,
  ImageRouteCapabilityError,
  deriveRequiredImageOperations,
  preflightImageRoute,
  preflightImageRouteCapabilities,
} from "./image-route-capabilities.mjs";

function route(overrides = {}) {
  return {
    model: "provider/image-model",
    adapter: "openai-compatible",
    apiKey: "must-not-appear",
    authorization: "Bearer must-not-appear",
    dimensionControl: {
      status: "supported",
      mechanism: "size",
      guarantee: "aspect-ratio",
      operations: ["generation", "edit"],
      evidence: { level: "documented", source: "provider-doc" },
    },
    aspectRatioSizes: { "3:4": "768x1024" },
    supportedSizes: ["768x1024", "1536x2048"],
    exactOutputSizes: [],
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    aspectRatio: "3:4",
    generationStrategy: "reference-parallel",
    pageCount: 1,
    pages: [{ id: "page-01" }],
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ImageRouteCapabilityError);
    assert.equal(error.code, code);
    assert.match(error.message, new RegExp(`^\\[${code}\\]`));
    return true;
  });
}

const generation = preflightImageRouteCapabilities({
  route: route({
    dimensionControl: {
      status: "supported",
      mechanism: "size",
      guarantee: "aspect-ratio",
      operations: ["generation"],
      evidence: { level: "documented", source: "provider-doc" },
    },
  }),
  plan: plan({ generationStrategy: "reference-parallel" }),
  referenceAssets: [],
  aspectRatio: "3:4",
});
assert.equal(generation.ok, true);
assert.equal(generation.dimensionControl.status, "supported");
assert.equal(generation.dimensionControl.mechanism, "size");
assert.equal(generation.dimensionControl.guarantee, "aspect-ratio");
assert.deepEqual(generation.dimensionControl.operations, ["generation"]);
assert.equal(generation.dimensionControl.evidence.level, "documented");
assert.equal(generation.evidence.level, "documented");
assert.equal(generation.evidence.source, "provider-doc");
assert.deepEqual(generation.requiredOperations, ["generation"]);
assert.equal(generation.request.requestedSize, "768x1024");
assert.equal(generation.requestPreview.requests[0].operation, "generation");
assert.equal(generation.requestPreview.requests[0].endpointPath, "/images/generations");

const previewJson = JSON.stringify(generation.requestPreview);
assert.doesNotMatch(previewJson, /must-not-appear/);
assert.doesNotMatch(previewJson, /apiKey|authorization/i);
assert.equal(generation.requestPreview.credentialsIncluded, false);

expectCode(
  () => preflightImageRouteCapabilities({
    route: route({ aspectRatioSizes: { "3:4": "1024x1024" } }),
    plan: plan(),
    referenceAssets: [],
  }),
  IMAGE_ROUTE_CAPABILITY_ERROR_CODES.ASPECT_RATIO_MAPPING_INVALID,
);

expectCode(
  () => preflightImageRouteCapabilities({
    route: route({ supportedSizes: ["1536x2048"] }),
    plan: plan(),
    referenceAssets: [],
  }),
  IMAGE_ROUTE_CAPABILITY_ERROR_CODES.SIZE_NOT_REQUESTABLE,
);

expectCode(
  () => preflightImageRouteCapabilities({
    route: route(),
    plan: plan(),
    referenceAssets: [],
    exactSize: { width: 768, height: 1024 },
  }),
  IMAGE_ROUTE_CAPABILITY_ERROR_CODES.EXACT_SIZE_NOT_GUARANTEED,
);

const exact = preflightImageRoute({
  route: route({
    dimensionControl: {
      status: "supported",
      mechanism: "size",
      guarantee: "exact",
      operations: ["generation"],
      evidence: { level: "runtime-verified" },
    },
    exactOutputSizes: ["768x1024"],
  }),
  input: { output: { aspectRatio: "3:4", exactSize: { width: 768, height: 1024 } } },
  plan: plan(),
  referenceAssets: [],
});
assert.equal(exact.request.exactSize, "768x1024");
assert.equal(exact.request.guarantee, "exact");
assert.equal(exact.evidence.level, "runtime-verified");

expectCode(
  () => preflightImageRouteCapabilities({
    route: route({ exactOutputSizes: ["1152x1536"] }),
    plan: plan(),
    referenceAssets: [],
  }),
  IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG,
);

const externalReferenceOperations = deriveRequiredImageOperations({
  plan: plan({
    generationStrategy: "anchor-first-fanout",
    pageCount: 2,
    pages: [{ id: "page-01" }, { id: "page-02" }],
  }),
  referenceAssets: [{ file: "/refs/style.png" }],
});
assert.deepEqual(externalReferenceOperations.requiredOperations, ["edit"]);
assert.deepEqual(externalReferenceOperations.pageOperations.map((page) => page.operation), ["edit", "edit"]);
assert.equal(externalReferenceOperations.pageOperations[0].externalReferenceCount, 1);

const generatedAnchorOperations = deriveRequiredImageOperations({
  plan: plan({
    generationStrategy: "anchor-first-fanout",
    pageCount: 3,
    pages: [{ id: "page-01" }, { id: "page-02" }, { id: "page-03" }],
  }),
  referenceAssets: [],
});
assert.deepEqual(generatedAnchorOperations.requiredOperations, ["generation", "edit"]);
assert.deepEqual(
  generatedAnchorOperations.pageOperations.map((page) => page.operation),
  ["generation", "edit", "edit"],
);

const editOnly = preflightImageRouteCapabilities({
  route: route({
    dimensionControl: {
      status: "supported",
      mechanism: "size",
      guarantee: "aspect-ratio",
      operations: ["edit"],
      evidence: { level: "documented" },
    },
  }),
  plan: plan({
    generationStrategy: "anchor-first-fanout",
    pageCount: 2,
    pages: [{ id: "page-01" }, { id: "page-02" }],
  }),
  referenceAssets: [{ file: "/refs/identity.png" }],
});
assert.deepEqual(editOnly.requiredOperations, ["edit"]);
assert.equal(editOnly.requestPreview.requests[0].body.referenceImageCount, 1);
assert.equal(editOnly.requestPreview.requests[1].body.referenceImageCount, 2);

expectCode(
  () => preflightImageRouteCapabilities({
    route: route({
      dimensionControl: {
        status: "supported",
        mechanism: "size",
        guarantee: "aspect-ratio",
        operations: ["generation"],
        evidence: { level: "documented" },
      },
    }),
    plan: plan({
      generationStrategy: "anchor-first-fanout",
      pageCount: 2,
      pages: [{ id: "page-01" }, { id: "page-02" }],
    }),
    referenceAssets: [],
  }),
  IMAGE_ROUTE_CAPABILITY_ERROR_CODES.OPERATION_UNSUPPORTED,
);

expectCode(
  () => preflightImageRouteCapabilities({
    route: route({ dimensionControl: { status: "unknown" } }),
    plan: plan(),
    referenceAssets: [],
  }),
  IMAGE_ROUTE_CAPABILITY_ERROR_CODES.DIMENSION_UNKNOWN,
);

expectCode(
  () => preflightImageRouteCapabilities({
    route: route({ dimensionControl: { status: "unsupported" }, evidence: { level: "configured" } }),
    plan: plan(),
    referenceAssets: [],
  }),
  IMAGE_ROUTE_CAPABILITY_ERROR_CODES.DIMENSION_UNSUPPORTED,
);

expectCode(
  () => preflightImageRouteCapabilities({
    route: route({
      dimensionControl: {
        status: "supported",
        mechanism: "size",
        guarantee: "aspect-ratio",
        operations: ["generation", "edit"],
        evidence: { level: "assumed" },
      },
    }),
    plan: plan(),
    referenceAssets: [],
  }),
  IMAGE_ROUTE_CAPABILITY_ERROR_CODES.INVALID_CONFIG,
);

console.log(JSON.stringify({
  valid: true,
  cases: [
    "aspect-ratio-size-request-and-key-free-preview",
    "mapped-3-to-4-value-must-itself-be-3-to-4",
    "supported-sizes-mean-requestable-values",
    "exact-output-sizes-are-separate-pixel-guarantees",
    "exact-size-can-be-read-from-input",
    "external-reference-makes-first-page-an-edit",
    "generated-anchor-requires-generation-and-edit",
    "unsupported-operation-fails-before-provider-call",
    "unknown-and-unsupported-dimension-statuses-are-distinct",
    "evidence-level-is-enumerated",
    "errors-carry-stable-codes",
  ],
}, null, 2));
