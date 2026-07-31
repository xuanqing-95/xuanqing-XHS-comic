#!/usr/bin/env node

import crypto from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./run-artifacts.mjs";
import { buildUsageArtifact, stableHash, upsertUsageCall } from "./usage-contract.mjs";

const INVOCATION_PLAN_FILE = "codex-builtin-invocations.json";
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function codedError(code, message, details = null) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  if (details !== null) error.details = details;
  return error;
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw codedError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function safeRelativePath(value, field) {
  const raw = nonEmptyString(value, field).replaceAll("\\", "/");
  const normalized = path.posix.normalize(raw);
  if (
    path.posix.isAbsolute(raw)
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || raw !== normalized
  ) {
    throw codedError("RUN_PATH_ESCAPE", `${field} must be a normalized path inside run-dir`);
  }
  return normalized;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function existingStat(filePath, field) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw codedError("FILE_ACCESS_FAILED", `Cannot inspect ${field}: ${error.message}`);
  }
  if (info.isSymbolicLink()) throw codedError("SYMLINK_FORBIDDEN", `${field} must not be a symbolic link`);
  return info;
}

async function ensureSafeDirectory(rootRealPath, relativeDirectory, field) {
  const normalized = relativeDirectory === "." ? "." : safeRelativePath(relativeDirectory, field);
  if (normalized === ".") return rootRealPath;
  let current = rootRealPath;
  for (const segment of normalized.split("/")) {
    const next = path.join(current, segment);
    const info = await existingStat(next, field);
    if (info === null) {
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw codedError("DIRECTORY_CREATE_FAILED", `Cannot create ${field}: ${error.message}`);
        }
      }
    } else if (!info.isDirectory()) {
      throw codedError("RUN_PATH_INVALID", `${field} contains a non-directory component`);
    }
    const refreshed = await existingStat(next, field);
    if (!refreshed?.isDirectory()) throw codedError("RUN_PATH_INVALID", `${field} is not a directory`);
    const resolved = await realpath(next);
    if (!isInside(rootRealPath, resolved)) throw codedError("RUN_PATH_ESCAPE", `${field} resolves outside run-dir`);
    current = resolved;
  }
  return current;
}

async function safeRunDestination(rootRealPath, relativePath, field, { createParent = false } = {}) {
  const normalized = safeRelativePath(relativePath, field);
  const directory = path.posix.dirname(normalized);
  let parent;
  if (createParent) {
    parent = await ensureSafeDirectory(rootRealPath, directory, `${field} parent`);
  } else {
    const lexicalParent = path.resolve(rootRealPath, directory);
    const info = await existingStat(lexicalParent, `${field} parent`);
    if (!info?.isDirectory()) throw codedError("RUN_PATH_INVALID", `${field} parent directory does not exist`);
    parent = await realpath(lexicalParent);
    if (!isInside(rootRealPath, parent)) throw codedError("RUN_PATH_ESCAPE", `${field} parent resolves outside run-dir`);
  }
  const destination = path.join(parent, path.posix.basename(normalized));
  if (!isInside(rootRealPath, destination)) throw codedError("RUN_PATH_ESCAPE", `${field} escapes run-dir`);
  return { relativePath: normalized, absolutePath: destination };
}

function pngMetadataFromBytes(bytes, field) {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.length < 24
    || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw codedError("INVALID_PROVIDER_PNG", `${field} is not a readable PNG`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) throw codedError("INVALID_PROVIDER_PNG", `${field} has invalid dimensions`);
  return {
    width,
    height,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function isProviderNativeThreeFour(width, height) {
  const scale = Math.round(((width / 3) + (height / 4)) / 2);
  return width < height && Math.abs(width - (scale * 3)) <= 1 && Math.abs(height - (scale * 4)) <= 1;
}

async function readRegularPng(filePath, field) {
  const info = await existingStat(filePath, field);
  if (!info?.isFile()) throw codedError("PROVIDER_OUTPUT_NOT_FILE", `${field} must be a regular file`);
  const bytes = await readFile(filePath);
  return { bytes, metadata: pngMetadataFromBytes(bytes, field) };
}

async function readInvocationPlan(rootRealPath) {
  const planPath = path.join(rootRealPath, INVOCATION_PLAN_FILE);
  const info = await existingStat(planPath, INVOCATION_PLAN_FILE);
  if (!info?.isFile()) throw codedError("INVOCATION_PLAN_MISSING", `${INVOCATION_PLAN_FILE} is missing`);
  let plan;
  try {
    plan = JSON.parse(await readFile(planPath, "utf8"));
  } catch (error) {
    throw codedError("INVOCATION_PLAN_INVALID", `Cannot parse ${INVOCATION_PLAN_FILE}: ${error.message}`);
  }
  if (plan?.adapter !== "codex-builtin" || !Array.isArray(plan.invocations)) {
    throw codedError("INVOCATION_PLAN_INVALID", `${INVOCATION_PLAN_FILE} is not a Codex built-in invocation plan`);
  }
  if (plan.providerCalls !== 0) {
    throw codedError("INVOCATION_PLAN_INVALID", "ingestion requires the zero-provider-call preparation plan");
  }
  return { plan, planPath };
}

function invocationForPage(plan, pageId) {
  const matches = plan.invocations.filter((item) => item?.pageId === pageId);
  if (matches.length !== 1) {
    throw codedError(
      matches.length === 0 ? "PAGE_NOT_PREPARED" : "DUPLICATE_PAGE_INVOCATION",
      `Expected exactly one prepared invocation for page ${pageId}`,
    );
  }
  return matches[0];
}

async function assertAcceptedDependency(rootRealPath, plan, dependencyPageId) {
  const dependency = invocationForPage(plan, dependencyPageId);
  if (dependency.status !== "accepted") {
    throw codedError("DEPENDENCY_NOT_ACCEPTED", `Dependency ${dependencyPageId} has not been accepted`);
  }
  if (
    dependency.providerDirect !== true
    || typeof dependency.sha256 !== "string"
    || !dependency.dimensions
  ) {
    throw codedError("DEPENDENCY_RECORD_INVALID", `Dependency ${dependencyPageId} has an incomplete acceptance record`);
  }
  const target = await safeRunDestination(
    rootRealPath,
    dependency.expectedProviderOutput,
    `dependency ${dependencyPageId} output`,
  );
  const current = await readRegularPng(target.absolutePath, `dependency ${dependencyPageId} output`);
  if (
    current.metadata.sha256 !== dependency.sha256
    || current.metadata.width !== dependency.dimensions.width
    || current.metadata.height !== dependency.dimensions.height
    || !isProviderNativeThreeFour(current.metadata.width, current.metadata.height)
  ) {
    throw codedError("DEPENDENCY_OUTPUT_TAMPERED", `Dependency ${dependencyPageId} no longer matches its accepted bytes`);
  }
}

async function writeExactBytes(rootRealPath, relativePath, bytes, field) {
  const target = await safeRunDestination(rootRealPath, relativePath, field, { createParent: true });
  const existing = await existingStat(target.absolutePath, field);
  if (existing !== null) {
    if (!existing.isFile()) throw codedError("OUTPUT_PATH_CONFLICT", `${field} already exists and is not a regular file`);
    const current = await readFile(target.absolutePath);
    const currentHash = crypto.createHash("sha256").update(current).digest("hex");
    const incomingHash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (currentHash !== incomingHash || !current.equals(bytes)) {
      throw codedError("OUTPUT_PATH_CONFLICT", `${field} already contains different bytes`);
    }
    return { ...target, copied: false };
  }
  try {
    await writeFile(target.absolutePath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw codedError("OUTPUT_WRITE_FAILED", `Cannot preserve ${field}: ${error.message}`);
  }
  return { ...target, copied: true };
}

function planStatus(invocations) {
  if (invocations.some((item) => item.status === "noncompliant")) return "noncompliant";
  if (invocations.every((item) => item.status === "accepted")) return "accepted";
  if (invocations.some((item) => item.status === "accepted")) return "receiving";
  return "prepared";
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw codedError("RUN_ARTIFACT_INVALID", `Cannot parse ${path.basename(filePath)}: ${error.message}`);
  }
}

async function recordAcceptedImageUsage(rootRealPath, invocation, pageId, metadata) {
  const usagePath = path.join(rootRealPath, "usage.json");
  const current = (await readJsonIfExists(usagePath)) || { version: 3, status: "not_applicable", calls: [] };
  const call = {
    callId: `codex-builtin:image:${pageId}`,
    role: "image",
    stage: "generate",
    operation: "codex-builtin-image",
    pageId,
    outputFile: invocation.expectedProviderOutput,
    status: "succeeded",
    meteringStatus: "unavailable",
    inputHash: stableHash({
      pageId,
      prompt: invocation.prompt,
      attachments: invocation.attachments || [],
      expectedProviderOutput: invocation.expectedProviderOutput,
    }),
    outputHash: metadata.sha256,
    requestId: null,
    completedAt: new Date().toISOString(),
    usage: null,
    provider: "codex-builtin",
    model: "built-in-image-model",
    pricingModel: "codex-builtin:unmetered",
    attempts: 1,
  };
  const calls = upsertUsageCall(current.calls || [], call);
  await writeJsonAtomic(usagePath, { version: 3, ...buildUsageArtifact(calls) });
}

export async function ingestCodexBuiltinResult({ runDir, pageId, providerOutput } = {}) {
  const requestedRunDir = path.resolve(nonEmptyString(runDir, "run-dir"));
  const rootInfo = await existingStat(requestedRunDir, "run-dir");
  if (!rootInfo?.isDirectory()) throw codedError("RUN_DIR_INVALID", "run-dir must be an existing directory");
  const rootRealPath = await realpath(requestedRunDir);
  const safePageId = nonEmptyString(pageId, "page-id");
  const providerPath = nonEmptyString(providerOutput, "provider-output");
  if (!path.isAbsolute(providerPath)) {
    throw codedError("PROVIDER_OUTPUT_NOT_ABSOLUTE", "provider-output must be an absolute path");
  }

  const { plan, planPath } = await readInvocationPlan(rootRealPath);
  const invocation = invocationForPage(plan, safePageId);
  if (invocation.status === "noncompliant") {
    throw codedError("NONCOMPLIANT_RETRY_FORBIDDEN", `Page ${safePageId} is locked noncompliant; automatic retry is forbidden`);
  }
  const dependencies = Array.isArray(invocation.dependsOn) ? invocation.dependsOn : [];
  for (const dependencyPageId of dependencies) {
    await assertAcceptedDependency(rootRealPath, plan, nonEmptyString(dependencyPageId, `${safePageId}.dependsOn[]`));
  }

  const provider = await readRegularPng(providerPath, "provider-output");
  if (invocation.status === "accepted") {
    const target = await safeRunDestination(rootRealPath, invocation.expectedProviderOutput, `${safePageId} expectedProviderOutput`);
    const accepted = await readRegularPng(target.absolutePath, `${safePageId} accepted output`);
    if (
      accepted.metadata.sha256 !== invocation.sha256
      || accepted.metadata.width !== invocation.dimensions?.width
      || accepted.metadata.height !== invocation.dimensions?.height
    ) {
      throw codedError("ACCEPTED_OUTPUT_TAMPERED", `Accepted output for ${safePageId} no longer matches its invocation record`);
    }
    if (provider.metadata.sha256 !== invocation.sha256 || !provider.bytes.equals(accepted.bytes)) {
      throw codedError("ALREADY_ACCEPTED_CONFLICT", `Page ${safePageId} was already accepted with different bytes`);
    }
    await recordAcceptedImageUsage(rootRealPath, invocation, safePageId, provider.metadata);
    return {
      status: "accepted",
      pageId: safePageId,
      providerDirect: true,
      dimensions: { width: provider.metadata.width, height: provider.metadata.height },
      sha256: provider.metadata.sha256,
      outputFile: invocation.expectedProviderOutput,
      replayed: true,
      providerCalls: 0,
    };
  }
  if (invocation.status !== undefined && invocation.status !== null && invocation.status !== "prepared") {
    throw codedError("INVOCATION_STATUS_INVALID", `Page ${safePageId} has unsupported status ${invocation.status}`);
  }

  const index = plan.invocations.indexOf(invocation);
  const dimensions = { width: provider.metadata.width, height: provider.metadata.height };
  if (!isProviderNativeThreeFour(dimensions.width, dimensions.height)) {
    const evidenceRelative = `codex-builtin-evidence/noncompliant/${String(index + 1).padStart(2, "0")}-${provider.metadata.sha256}.png`;
    const evidence = await writeExactBytes(rootRealPath, evidenceRelative, provider.bytes, `${safePageId} noncompliant evidence`);
    plan.invocations[index] = {
      ...invocation,
      status: "noncompliant",
      providerDirect: true,
      dimensions,
      sha256: provider.metadata.sha256,
      evidenceFile: evidence.relativePath,
      automaticRetry: false,
      failureCode: "PROVIDER_OUTPUT_ASPECT_MISMATCH",
    };
    plan.status = planStatus(plan.invocations);
    await writeJsonAtomic(planPath, plan);
    throw codedError(
      "PROVIDER_OUTPUT_ASPECT_MISMATCH",
      `Provider-direct output for ${safePageId} measured ${dimensions.width}x${dimensions.height}, not portrait 3:4; original evidence was preserved and automatic retry is forbidden`,
      { pageId: safePageId, evidenceFile: evidence.relativePath, dimensions, sha256: provider.metadata.sha256 },
    );
  }

  const output = await writeExactBytes(
    rootRealPath,
    invocation.expectedProviderOutput,
    provider.bytes,
    `${safePageId} expectedProviderOutput`,
  );
  plan.invocations[index] = {
    ...invocation,
    status: "accepted",
    providerDirect: true,
    dimensions,
    sha256: provider.metadata.sha256,
    outputFile: output.relativePath,
    automaticRetry: false,
  };
  plan.status = planStatus(plan.invocations);
  await writeJsonAtomic(planPath, plan);
  await recordAcceptedImageUsage(rootRealPath, plan.invocations[index], safePageId, provider.metadata);
  return {
    status: "accepted",
    pageId: safePageId,
    providerDirect: true,
    dimensions,
    sha256: provider.metadata.sha256,
    outputFile: output.relativePath,
    replayed: !output.copied,
    providerCalls: 0,
  };
}

function parseCli(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!new Set(["--run-dir", "--page-id", "--provider-output"]).has(token)) {
      throw codedError("INVALID_ARGUMENT", `Unknown argument: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw codedError("INVALID_ARGUMENT", `${token} requires a value`);
    if (values.has(token)) throw codedError("INVALID_ARGUMENT", `${token} may only be provided once`);
    values.set(token, value);
    index += 1;
  }
  for (const required of ["--run-dir", "--page-id", "--provider-output"]) {
    if (!values.has(required)) throw codedError("INVALID_ARGUMENT", `${required} is required`);
  }
  return {
    runDir: values.get("--run-dir"),
    pageId: values.get("--page-id"),
    providerOutput: values.get("--provider-output"),
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const result = await ingestCodexBuiltinResult(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const payload = {
      ok: false,
      code: error?.code || "CODEX_BUILTIN_INGEST_FAILED",
      message: error?.message || String(error),
      ...(error?.details ? { details: error.details } : {}),
      providerCalls: 0,
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(error?.code === "INVALID_ARGUMENT" ? 2 : 1);
  }
}
