import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { pngMetadata, readJson } from "./run-artifacts.mjs";
import { sha256Bytes, stableHash } from "./usage-contract.mjs";

const PRIVATE_ARTIFACTS = [
  ["input", "input.json"],
  ["topic-angles", "topic-angles.json"],
  ["story", "story.json"],
  ["characters", "character-bible.json"],
  ["comic-plan", "comic-plan.json"],
  ["visual-lock", "visual-lock.json"],
  ["copywriting", "copywriting.json"],
  ["result", "result.json"],
  ["usage", "usage.json"],
  ["eval", "eval-report.json"],
  ["diagnosis", "diagnosis.json"],
  ["lettering-plan", "lettering-plan.json"],
  ["lettering-report", "lettering-report.json"],
];

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function normalizeSourceIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sourceIdentity is required for platform delivery");
  }
  const identity = {
    policy: requireString(value.policy, "sourceIdentity.policy"),
    repository: requireString(value.repository, "sourceIdentity.repository"),
    canonicalPath: requireString(value.canonicalPath, "sourceIdentity.canonicalPath"),
    commit: requireString(value.commit, "sourceIdentity.commit"),
    releaseTag: requireString(value.releaseTag, "sourceIdentity.releaseTag"),
    version: requireString(value.version, "sourceIdentity.version"),
    artifactVersion: value.artifactVersion,
    sourceSha256: requireString(value.sourceSha256, "sourceIdentity.sourceSha256"),
    publicConfigSha256: requireString(value.publicConfigSha256, "sourceIdentity.publicConfigSha256"),
  };
  if (identity.policy !== "github-release-pinned") throw new Error("sourceIdentity.policy must be github-release-pinned");
  if (!/^[a-f0-9]{40}$/i.test(identity.commit)) throw new Error("sourceIdentity.commit must be a full Git commit");
  if (!Number.isSafeInteger(identity.artifactVersion) || identity.artifactVersion < 1) throw new Error("sourceIdentity.artifactVersion must be positive");
  if (!/^[a-f0-9]{64}$/i.test(identity.sourceSha256)) throw new Error("sourceIdentity.sourceSha256 must be SHA-256");
  if (!/^[a-f0-9]{64}$/i.test(identity.publicConfigSha256)) throw new Error("sourceIdentity.publicConfigSha256 must be SHA-256");
  return identity;
}

function normalizeHostMetadata(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("hostMetadata must be a JSON object");
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("hostMetadata must be JSON-serializable");
  }
  if (serialized === undefined || serialized.length > 16 * 1024) {
    throw new Error("hostMetadata must serialize to at most 16 KiB");
  }
  return JSON.parse(serialized);
}

function safeRelativePath(value, field) {
  const normalized = requireString(value, field).replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${field} must be a run-relative path without traversal`);
  }
  return normalized;
}

async function fileRecord(runDir, relativePath, role, extra = {}) {
  const safePath = safeRelativePath(relativePath, `${role}.relativePath`);
  const absolutePath = path.resolve(runDir, safePath);
  const relativeFromRun = path.relative(runDir, absolutePath).replaceAll("\\", "/");
  if (relativeFromRun !== safePath) throw new Error(`${role}.relativePath escapes the run directory`);
  const bytes = await readFile(absolutePath);
  const info = await stat(absolutePath);
  return {
    role,
    relativePath: safePath,
    bytes: info.size,
    sha256: sha256Bytes(bytes),
    ...extra,
  };
}

function assertPublishableArtifacts({ result, plan, evalReport, diagnosis, usage }) {
  if (result.status !== "reviewed") throw new Error(`delivery requires result.status reviewed, got ${result.status}`);
  if (evalReport.status !== "pass") throw new Error("delivery requires eval-report.status pass");
  if (diagnosis.status !== "no-material-failure") throw new Error("delivery requires diagnosis.status no-material-failure");
  if (evalReport.hardGates?.outputIntegrity?.status !== "pass") throw new Error("delivery requires outputIntegrity pass");
  if (usage.status !== "complete") throw new Error(`delivery requires complete provider metering, got ${usage.status}`);
  if (!Array.isArray(result.pages) || result.pages.length !== plan.pageCount) {
    throw new Error("delivery pages must exactly cover comic-plan.pageCount");
  }
}

export async function buildDeliveryManifest({
  runDir,
  runId,
  hostItemId,
  hostActionId,
  hostMetadata,
  skillId = "social-comic-generator",
  sourceIdentity,
  createdAt = new Date().toISOString(),
} = {}) {
  const root = path.resolve(requireString(runDir, "runDir"));
  const normalizedRunId = requireString(runId, "runId");
  const normalizedHostItemId = requireString(hostItemId, "hostItemId");
  const normalizedHostActionId = requireString(hostActionId, "hostActionId");
  const normalizedHostMetadata = normalizeHostMetadata(hostMetadata);
  const normalizedSourceIdentity = normalizeSourceIdentity(sourceIdentity);
  const [input, plan, result, usage, evalReport, diagnosis] = await Promise.all([
    readJson(path.join(root, "input.json")),
    readJson(path.join(root, "comic-plan.json")),
    readJson(path.join(root, "result.json")),
    readJson(path.join(root, "usage.json")),
    readJson(path.join(root, "eval-report.json")),
    readJson(path.join(root, "diagnosis.json")),
  ]);
  assertPublishableArtifacts({ result, plan, evalReport, diagnosis, usage });

  const pages = [];
  for (const [index, relativePath] of result.pages.entries()) {
    const record = await fileRecord(root, relativePath, "final-page", {
      index,
      contentType: "image/png",
      publishable: true,
    });
    const metadata = await pngMetadata(path.join(root, record.relativePath));
    pages.push({ ...record, width: metadata.width, height: metadata.height });
  }

  const privateArtifacts = [];
  for (const [role, relativePath] of PRIVATE_ARTIFACTS) {
    try {
      privateArtifacts.push(await fileRecord(root, relativePath, role, { publishable: false }));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const relativePath of result.sourcePages || []) {
    privateArtifacts.push(await fileRecord(root, relativePath, "provider-source", { publishable: false }));
  }

  const pricingModels = [...new Set((usage.calls || [])
    .filter((call) => call.status === "succeeded" && call.meteringStatus === "available")
    .map((call) => call.pricingModel)
    .filter(Boolean))];

  return {
    schemaVersion: 1,
    runId: normalizedRunId,
    host: {
      actionId: normalizedHostActionId,
      itemId: normalizedHostItemId,
      metadata: normalizedHostMetadata,
    },
    skillId,
    skillArtifactVersion: 3,
    sourceIdentity: normalizedSourceIdentity,
    resultStatus: result.status,
    deliveryState: "publishable",
    textStrategy: input.output.textStrategy,
    aspectRatio: result.aspectRatio,
    pageCount: result.pageCount,
    pages,
    privateArtifacts,
    contentPackage: {
      story: "story.json",
      characters: "character-bible.json",
      visualLock: "visual-lock.json",
      copywriting: "copywriting.json",
    },
    quality: {
      eval: evalReport.status,
      diagnosis: diagnosis.status,
      outputIntegrity: evalReport.hardGates.outputIntegrity.status,
    },
    usage: {
      artifact: "usage.json",
      allPaidCallsMetered: true,
      pricingModels,
      receiptHash: stableHash(usage.calls || []),
    },
    createdAt,
  };
}
