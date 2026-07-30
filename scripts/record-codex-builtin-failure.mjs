#!/usr/bin/env node

import crypto from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./run-artifacts.mjs";

const INVOCATION_FILE = "codex-builtin-invocations.json";
const FAILURE_EVENT_PREFIX = "codex-builtin-runtime-failure";
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function codedError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
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
  if (path.posix.isAbsolute(raw) || normalized === "." || normalized === ".." || normalized.startsWith("../") || raw !== normalized) {
    throw codedError("RUN_PATH_ESCAPE", `${field} must stay inside run-dir`);
  }
  return normalized;
}

async function readJson(root, relativePath) {
  const safe = safeRelativePath(relativePath, relativePath);
  let value;
  try {
    value = JSON.parse(await readFile(path.join(root, safe), "utf8"));
  } catch (error) {
    throw codedError("RUN_ARTIFACT_INVALID", `Cannot read ${relativePath}: ${error.message}`);
  }
  if (value?.version !== 3) throw codedError("RUN_ARTIFACT_INVALID", `${relativePath}.version must be 3`);
  return value;
}

async function readTextInside(root, relativePath, field) {
  const safe = safeRelativePath(relativePath, field);
  let source;
  try {
    source = await readFile(path.join(root, safe), "utf8");
  } catch (error) {
    throw codedError("PROMPT_AUDIT_FAILED", `Cannot read ${field}: ${error.message}`);
  }
  if (source.trim() === "") throw codedError("PROMPT_AUDIT_FAILED", `${field} is empty`);
  return { file: safe, sha256: crypto.createHash("sha256").update(source).digest("hex") };
}

function invocationForPage(plan, pageId) {
  const matches = plan.invocations.filter((item) => item?.pageId === pageId);
  if (matches.length !== 1) {
    throw codedError(matches.length ? "DUPLICATE_PAGE_INVOCATION" : "PAGE_NOT_PREPARED", `Expected one invocation for ${pageId}`);
  }
  return matches[0];
}

async function acceptedPageEvidence(root, invocation) {
  if (invocation.status !== "accepted") return null;
  if (invocation.providerDirect !== true || typeof invocation.sha256 !== "string") {
    throw codedError("ACCEPTED_PREFIX_INVALID", `Accepted page ${invocation.pageId} has incomplete provenance`);
  }
  const dimensions = invocation.dimensions;
  if (!Number.isInteger(dimensions?.width) || !Number.isInteger(dimensions?.height)) {
    throw codedError("ACCEPTED_PREFIX_INVALID", `Accepted page ${invocation.pageId} has invalid dimensions`);
  }
  const file = safeRelativePath(invocation.expectedProviderOutput, `${invocation.pageId}.expectedProviderOutput`);
  const bytes = await readFile(path.join(root, file)).catch((error) => {
    throw codedError("ACCEPTED_PREFIX_INVALID", `Cannot read accepted page ${invocation.pageId}: ${error.message}`);
  });
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw codedError("ACCEPTED_PREFIX_INVALID", `Accepted page ${invocation.pageId} is not a PNG`);
  }
  const measured = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== invocation.sha256 || measured.width !== dimensions.width || measured.height !== dimensions.height) {
    throw codedError("ACCEPTED_PREFIX_INVALID", `Accepted page ${invocation.pageId} bytes no longer match its record`);
  }
  return { file, ...measured };
}

function sameFailure(left, right) {
  return left?.code === right.code
    && left?.message === right.message
    && (left?.wallTimeSeconds ?? null) === (right.wallTimeSeconds ?? null)
    && left?.providerOutputReturned === false;
}

function upsertById(items, idField, value) {
  const next = Array.isArray(items) ? [...items] : [];
  const index = next.findIndex((item) => item?.[idField] === value[idField]);
  if (index < 0) next.push(value);
  else next[index] = value;
  return next;
}

function failureUsageCall(invocation, failure, promptAudit) {
  return {
    callId: `${FAILURE_EVENT_PREFIX}:${invocation.pageId}`,
    role: "image",
    stage: "generate",
    operation: "generation",
    provider: "codex-builtin",
    model: "host-managed-image-model",
    status: "failed",
    meteringStatus: "unavailable",
    inputHash: crypto.createHash("sha256").update(JSON.stringify({
      invocationId: invocation.id,
      canonicalPromptSha256: promptAudit.canonicalPromptSha256,
      derivedPromptSha256: promptAudit.derivedPromptSha256,
      attachments: invocation.attachments,
    })).digest("hex"),
    providerOutputReturned: false,
    automaticRetry: false,
    failureCode: failure.code,
    failureMessage: failure.message,
    ...(failure.wallTimeSeconds === undefined ? {} : { wallTimeSeconds: failure.wallTimeSeconds }),
  };
}

export async function recordCodexBuiltinFailure({ runDir, pageId, code, message, wallTimeSeconds } = {}) {
  const requestedRunDir = nonEmptyString(runDir, "run-dir");
  if (!path.isAbsolute(requestedRunDir)) throw codedError("RUN_DIR_NOT_ABSOLUTE", "run-dir must be absolute");
  const info = await lstat(requestedRunDir).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw codedError("RUN_DIR_INVALID", "run-dir must be a real directory");
  const root = await realpath(requestedRunDir);
  const safePageId = nonEmptyString(pageId, "page-id");
  const safeCode = nonEmptyString(code, "code");
  if (!/^[A-Z][A-Z0-9_]*$/.test(safeCode)) throw codedError("INVALID_ARGUMENT", "code must be an uppercase machine code");
  const safeMessage = nonEmptyString(message, "message");
  if (wallTimeSeconds !== undefined && (!Number.isFinite(wallTimeSeconds) || wallTimeSeconds < 0)) {
    throw codedError("INVALID_ARGUMENT", "wall-time-seconds must be a non-negative number");
  }

  const [input, comicPlan, result, usage, debug, plan] = await Promise.all([
    readJson(root, "input.json"),
    readJson(root, "comic-plan.json"),
    readJson(root, "result.json"),
    readJson(root, "usage.json"),
    readJson(root, "debug.json"),
    readJson(root, INVOCATION_FILE),
  ]);
  if (plan.adapter !== "codex-builtin" || plan.status === "accepted" || !Array.isArray(plan.invocations) || plan.providerCalls !== 0) {
    throw codedError("INVOCATION_PLAN_INVALID", "failure recording requires a zero-call Codex built-in invocation plan");
  }
  if (plan.sharedPromptContractUnchanged !== true) {
    throw codedError("PROMPT_AUDIT_FAILED", "prepared plan does not attest that the shared prompt contract is unchanged");
  }
  if (input?.output?.aspectRatio !== "3:4" || comicPlan?.aspectRatio !== "3:4") {
    throw codedError("RUN_ARTIFACT_INVALID", "Codex built-in failure recording requires a 3:4 schema-v3 run");
  }

  const invocation = invocationForPage(plan, safePageId);
  const failure = {
    code: safeCode,
    message: safeMessage,
    providerOutputReturned: false,
    ...(wallTimeSeconds === undefined ? {} : { wallTimeSeconds }),
  };
  const replayed = invocation.status === "runtime-failed";
  if (replayed && !sameFailure(invocation.failure, failure)) {
    throw codedError("FAILURE_RECORD_CONFLICT", `Page ${safePageId} already has a different runtime failure`);
  }
  if (!replayed && invocation.status !== undefined && invocation.status !== null && invocation.status !== "prepared") {
    throw codedError("INVOCATION_STATUS_INVALID", `Page ${safePageId} is ${invocation.status}, not prepared`);
  }
  for (const dependencyPageId of Array.isArray(invocation.dependsOn) ? invocation.dependsOn : []) {
    if (invocationForPage(plan, nonEmptyString(dependencyPageId, `${safePageId}.dependsOn[]`)).status !== "accepted") {
      throw codedError("DEPENDENCY_NOT_ACCEPTED", `Dependency ${dependencyPageId} has not been accepted`);
    }
  }

  const canonicalPrompt = await readTextInside(root, invocation.prompt?.canonicalFile, `${safePageId}.canonicalPrompt`);
  const derivedPrompt = await readTextInside(root, invocation.prompt?.derivedFile, `${safePageId}.derivedPrompt`);
  const promptAudit = {
    status: "pass",
    scope: "integrity-only",
    meaning: "Canonical and derived prompt files were readable and their hashes were recorded; this does not assert semantic prompt quality.",
    sharedPromptContractUnchanged: true,
    canonicalPrompt: canonicalPrompt.file,
    canonicalPromptSha256: canonicalPrompt.sha256,
    derivedPrompt: derivedPrompt.file,
    derivedPromptSha256: derivedPrompt.sha256,
  };

  const acceptedPrefix = [];
  for (const candidate of plan.invocations) {
    if (candidate.pageId === safePageId || candidate.status !== "accepted") break;
    acceptedPrefix.push(await acceptedPageEvidence(root, candidate));
  }

  const invocationIndex = plan.invocations.indexOf(invocation);
  plan.invocations[invocationIndex] = {
    ...invocation,
    status: "runtime-failed",
    automaticRetry: false,
    providerOutputReturned: false,
    failure,
  };
  plan.status = "runtime-failed";

  const nextResult = {
    ...result,
    version: 3,
    status: "failed",
    stage: "generate",
    error: `[${safeCode}] ${safeMessage}`,
    pageCount: comicPlan.pageCount,
    acceptedPageCount: acceptedPrefix.length,
  };
  if (comicPlan.textStrategy === "post-layout") {
    delete nextResult.pages;
    delete nextResult.actualDimensions;
    if (acceptedPrefix.length > 0) {
      nextResult.sourcePages = acceptedPrefix.map((page) => page.file);
      nextResult.sourceActualDimensions = acceptedPrefix.map((page) => ({ file: page.file, width: page.width, height: page.height }));
    } else {
      delete nextResult.sourcePages;
      delete nextResult.sourceActualDimensions;
    }
  } else {
    delete nextResult.sourcePages;
    delete nextResult.sourceActualDimensions;
    if (acceptedPrefix.length > 0) {
      nextResult.pages = acceptedPrefix.map((page) => page.file);
      nextResult.actualDimensions = acceptedPrefix.map((page) => ({ file: page.file, width: page.width, height: page.height }));
    } else {
      delete nextResult.pages;
      delete nextResult.actualDimensions;
    }
  }

  const usageCall = failureUsageCall(invocation, failure, promptAudit);
  const nextUsage = {
    ...usage,
    version: 3,
    status: "not_applicable",
    reason: "No billable provider call completed; the failed Codex host call exposed no metering.",
    calls: upsertById(usage.calls, "callId", usageCall),
  };
  const eventId = `${FAILURE_EVENT_PREFIX}:${safePageId}`;
  const event = {
    eventId,
    stage: "generate",
    status: "runtime-failed",
    pageId: safePageId,
    code: safeCode,
    message: safeMessage,
    providerOutputReturned: false,
    automaticRetry: false,
    ...(wallTimeSeconds === undefined ? {} : { wallTimeSeconds }),
  };
  const nextDebug = {
    ...debug,
    version: 3,
    status: "failed",
    stage: "generate",
    providerCalls: 0,
    events: upsertById(debug.events, "eventId", event),
    errors: upsertById(debug.errors, "errorId", { ...event, errorId: eventId }),
    callCounts: {
      ...(debug.callCounts || {}),
      image: replayed ? (debug.callCounts?.image || 1) : ((debug.callCounts?.image || 0) + 1),
    },
    counts: {
      ...(debug.counts || {}),
      providerCalls: 0,
      acceptedPages: acceptedPrefix.length,
      runtimeFailedPages: 1,
      failedImageCalls: 1,
      visualEvaluations: 0,
      automaticRetries: 0,
    },
  };
  const diagnosis = {
    version: 3,
    status: "action-required",
    pageId: safePageId,
    faultDomain: "runtime",
    failure,
    promptAudit,
    comparisons: (comicPlan.pages || []).map((page, index) => ({
      pageId: page.id,
      contractFile: `comic-plan.json#pages[${index}]`,
      promptFile: page.promptFile,
      outputFile: page.outputFile,
      promptAudit: "integrity-pass",
      outputEval: "not-run",
      attemptStatus: page.id === safePageId
        ? "runtime-failed-without-output"
        : index < acceptedPrefix.length
          ? "accepted-before-later-runtime-failure"
          : "not-attempted-after-runtime-failure",
    })),
    visualEvaluation: {
      status: "not-run",
      reason: acceptedPrefix.length > 0
        ? "The failed page returned no image. Earlier accepted pages are preserved, but the complete page set is unavailable, so no formal visual evaluation was run."
        : "No provider image was returned, so there is no visual output to evaluate.",
    },
    issues: [{
      issueId: `${FAILURE_EVENT_PREFIX}:${safePageId}`,
      evalPath: null,
      faultDomain: "runtime",
      evidence: {
        contract: "references/adapters/codex-builtin.md",
        prompt: derivedPrompt.file,
        output: null,
        evalFinding: null,
        runtimeFailure: failure,
      },
      responsibleArtifact: INVOCATION_FILE,
      recommendedChange: "Inspect the Codex host runtime. Do not change the prompt or Eval, and require explicit authorization before any new image call.",
      autoAction: "none",
    }],
    guardrails: {
      promptChanged: false,
      evalChanged: false,
      automaticRetry: false,
      fakeEvalReportCreated: false,
    },
  };

  await Promise.all([
    writeJsonAtomic(path.join(root, "result.json"), nextResult),
    writeJsonAtomic(path.join(root, "usage.json"), nextUsage),
    writeJsonAtomic(path.join(root, "debug.json"), nextDebug),
    writeJsonAtomic(path.join(root, "diagnosis.json"), diagnosis),
  ]);
  await writeJsonAtomic(path.join(root, INVOCATION_FILE), plan);

  return {
    status: "runtime-failed",
    pageId: safePageId,
    code: safeCode,
    replayed,
    providerCalls: 0,
    acceptedPageCount: acceptedPrefix.length,
  };
}

function parseCli(argv) {
  const allowed = new Set(["--run-dir", "--page-id", "--code", "--message", "--wall-time-seconds"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!allowed.has(token)) throw codedError("INVALID_ARGUMENT", `Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw codedError("INVALID_ARGUMENT", `${token} requires a value`);
    if (values.has(token)) throw codedError("INVALID_ARGUMENT", `${token} may only be provided once`);
    values.set(token, value);
    index += 1;
  }
  for (const required of ["--run-dir", "--page-id", "--code", "--message"]) {
    if (!values.has(required)) throw codedError("INVALID_ARGUMENT", `${required} is required`);
  }
  const wall = values.has("--wall-time-seconds") ? Number(values.get("--wall-time-seconds")) : undefined;
  return {
    runDir: values.get("--run-dir"),
    pageId: values.get("--page-id"),
    code: values.get("--code"),
    message: values.get("--message"),
    wallTimeSeconds: wall,
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    process.stdout.write(`${JSON.stringify(await recordCodexBuiltinFailure(parseCli(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "CODEX_BUILTIN_FAILURE_RECORDING_FAILED",
      message: error?.message || String(error),
      providerCalls: 0,
    }, null, 2)}\n`);
    process.exit(error?.code === "INVALID_ARGUMENT" ? 2 : 1);
  }
}
