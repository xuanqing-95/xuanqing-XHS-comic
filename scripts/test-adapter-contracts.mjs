#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  IMAGE_ROUTE_CAPABILITY_ERROR_CODES,
  ImageRouteCapabilityError,
  preflightImageRouteCapabilities,
} from "./image-route-capabilities.mjs";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(skillDir, relativePath), "utf8"));
const manifest = await readJson("skill-manifest.json");
const platform = manifest.adapters?.["platform-api"];
const codex = manifest.adapters?.["codex-builtin"];

assert.equal(manifest.source.policy, "github-release-pinned");
assert.equal(manifest.source.repository, "https://github.com/xuanqing-95/social-comic-generator");
assert.equal(manifest.source.canonicalPath, ".");
assert.equal(manifest.source.releaseTag, "v0.3.1");
assert.equal(manifest.version, "0.3.1");
assert.equal(manifest.license, "AGPL-3.0-only");
assert.equal(manifest.runtime.node, ">=20");
assert.equal(manifest.runtime.dependencyManifest, "package-lock.json");
assert.equal(manifest.artifactVersion, 3);
assert.equal(platform.artifactContractVersion, manifest.artifactVersion);
assert.equal(codex.artifactContractVersion, manifest.artifactVersion);
assert.equal(platform.promptCompiler, codex.promptCompiler);
assert.equal(codex.invocation, "agent-tool:imagegen");
assert.equal(codex.deliveryScope, "local-interactive");
assert.equal(codex.preparationEntrypoint, "scripts/prepare-codex-builtin.mjs");
assert.equal(codex.preparationArtifact, "codex-builtin-invocations.json");
assert.equal((await stat(path.join(skillDir, codex.preparationEntrypoint))).isFile(), true);
assert.equal(codex.resultIngestionEntrypoint, "scripts/ingest-codex-builtin-result.mjs");
assert.equal(codex.failureRecordingEntrypoint, "scripts/record-codex-builtin-failure.mjs");
assert.equal((await stat(path.join(skillDir, codex.resultIngestionEntrypoint))).isFile(), true);
assert.equal((await stat(path.join(skillDir, codex.failureRecordingEntrypoint))).isFile(), true);

const platformRoute = await readJson(platform.capabilityCatalog);
const codexRoute = await readJson(codex.capabilityCatalog);
const plan = {
  aspectRatio: "3:4",
  generationStrategy: "style-lock-parallel",
  pageCount: 1,
  pages: [{ id: "page-01" }],
};

const platformPreflight = preflightImageRouteCapabilities({
  route: platformRoute,
  plan,
  referenceAssets: [],
});
assert.equal(platformPreflight.ok, true);
assert.equal(platformPreflight.request.requestedSize, "1152x1536");

assert.throws(
  () => preflightImageRouteCapabilities({ route: codexRoute, plan, referenceAssets: [] }),
  (error) => {
    assert.ok(error instanceof ImageRouteCapabilityError);
    assert.equal(error.code, IMAGE_ROUTE_CAPABILITY_ERROR_CODES.DIMENSION_UNSUPPORTED);
    return true;
  },
);
assert.equal(codexRoute.supportsReferences, true);
assert.equal(codex.dimensionPolicy, "aspect-reference-and-verify-without-crop-resize-pad-stretch-or-stitch");
assert.equal(codexRoute.dimensionControl.status, "unsupported");
assert.equal(codexRoute.dimensionControl.mechanism, "none");
assert.equal(codexRoute.interactiveAspectStrategy.status, "runtime-verified");
assert.equal(codexRoute.interactiveAspectStrategy.scope, "interactive-aspect-only");
assert.equal(codexRoute.interactiveAspectStrategy.reference.aspectRatio, "3:4");
assert.equal(codexRoute.interactiveAspectStrategy.reference.width, 1080);
assert.equal(codexRoute.interactiveAspectStrategy.reference.height, 1440);
assert.equal(codexRoute.interactiveAspectStrategy.evidence.providerDirect, true);
assert.deepEqual(codexRoute.interactiveAspectStrategy.evidence.postProcessing, []);
assert.ok(codexRoute.interactiveAspectStrategy.limitations.some((item) => item.includes("not exact pixel")));
const codexAspectEvidence = await readJson(codexRoute.interactiveAspectStrategy.evidence.source);
assert.equal(codexAspectEvidence.observations.length, 4);
assert.equal(codexAspectEvidence.observations[1].nativeAspect, "3:4");
assert.equal(codexAspectEvidence.observations[3].nativeAspect, "2:3");
assert.match(codexAspectEvidence.conclusion, /attached to every interactive built-in page/);
assert.equal(codexRoute.multiPageEveryPageBlankVerification.status, "runtime-blocked");
const codexTimeoutEvidence = await readJson(codexRoute.multiPageEveryPageBlankVerification.evidence.source);
assert.equal(codexTimeoutEvidence.outcome.pageOne.providerOutputReturned, false);
assert.equal(codexTimeoutEvidence.outcome.pageTwo.invoked, false);

console.log(JSON.stringify({
  valid: true,
  providerCalls: 0,
  canonicalSkill: manifest.id,
  adapters: ["platform-api", "codex-builtin"],
  sharedArtifactVersion: manifest.artifactVersion,
  sharedPromptCompiler: platform.promptCompiler,
  platformDimensionPreflight: "supported",
  codexDimensionPreflight: "unsupported-interactive-request-and-verify-only",
  codexInteractiveAspectStrategy: "runtime-verified-reference-workaround",
}, null, 2));
