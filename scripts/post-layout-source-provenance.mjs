import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { postLayoutSourceFile } from "./post-layout.mjs";
import { pngMetadata } from "./run-artifacts.mjs";

function fail(message, code, cause = null) {
  const error = new Error(`[${code}] ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function validText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export async function verifyPostLayoutSourceProvenance({ runDir, page }) {
  if (!validText(runDir)) throw new TypeError("runDir must be a non-empty string");
  if (!page || !validText(page.id) || !validText(page.outputFile)) {
    throw new TypeError("page.id and page.outputFile must be non-empty strings");
  }
  const sourceFile = postLayoutSourceFile(page);
  const sidecarFile = `${sourceFile}.json`;
  let sidecarBytes;
  let sidecar;
  try {
    sidecarBytes = await readFile(path.join(runDir, sidecarFile));
    sidecar = JSON.parse(sidecarBytes.toString("utf8"));
  } catch (error) {
    const code = error?.code === "ENOENT" ? "POST_LAYOUT_SOURCE_SIDECAR_MISSING" : "POST_LAYOUT_SOURCE_SIDECAR_INVALID";
    throw fail(`Cannot verify generation sidecar ${sidecarFile}: ${error.message}`, code, error);
  }
  if (sidecar?.version !== 3 || sidecar.directOutput !== true) {
    throw fail(`${sidecarFile} must be a version-3 direct provider-output sidecar.`, "POST_LAYOUT_SOURCE_SIDECAR_INVALID");
  }
  if (sidecar.pageId !== page.id) {
    throw fail(`${sidecarFile} pageId ${sidecar.pageId} does not match ${page.id}.`, "POST_LAYOUT_SOURCE_PAGE_MISMATCH");
  }
  if (sidecar.outputFile !== sourceFile || sidecar.finalOutputFile !== page.outputFile) {
    throw fail(`${sidecarFile} does not point from ${sourceFile} to ${page.outputFile}.`, "POST_LAYOUT_SOURCE_PATH_MISMATCH");
  }
  if (!Array.isArray(sidecar.references)) {
    throw fail(`${sidecarFile}.references must be an array.`, "POST_LAYOUT_SOURCE_SIDECAR_INVALID");
  }
  const expectedOperation = sidecar.references.length > 0 ? "edit" : "generation";
  if (sidecar.operation !== expectedOperation) {
    throw fail(`${sidecarFile} operation ${sidecar.operation} does not match ${expectedOperation}.`, "POST_LAYOUT_SOURCE_OPERATION_MISMATCH");
  }
  if (typeof sidecar.callId !== "string" || !sidecar.callId.endsWith(`:page:${page.id}:${expectedOperation}`)) {
    throw fail(`${sidecarFile} callId does not identify ${page.id} ${expectedOperation}.`, "POST_LAYOUT_SOURCE_CALL_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/i.test(sidecar.outputSha256 || "")) {
    throw fail(`${sidecarFile}.outputSha256 is not a SHA-256 digest.`, "POST_LAYOUT_SOURCE_SIDECAR_INVALID");
  }
  let sourceMetadata;
  try {
    sourceMetadata = await pngMetadata(path.join(runDir, sourceFile));
  } catch (error) {
    throw fail(`Cannot read provider source ${sourceFile}: ${error.message}`, "POST_LAYOUT_SOURCE_INVALID", error);
  }
  if (sidecar.outputSha256.toLowerCase() !== sourceMetadata.sha256) {
    throw fail(`${sourceFile} SHA-256 no longer matches its generation sidecar.`, "POST_LAYOUT_SOURCE_HASH_MISMATCH");
  }
  if (sidecar.actualDimensions?.width !== sourceMetadata.width || sidecar.actualDimensions?.height !== sourceMetadata.height) {
    throw fail(`${sourceFile} dimensions no longer match its generation sidecar.`, "POST_LAYOUT_SOURCE_DIMENSION_MISMATCH");
  }
  return {
    sidecarFile,
    sidecarSha256: crypto.createHash("sha256").update(sidecarBytes).digest("hex"),
    pageId: sidecar.pageId,
    operation: sidecar.operation,
    callId: sidecar.callId,
    provider: sidecar.provider,
    model: sidecar.model,
    pricingModel: sidecar.pricingModel,
    sourceFile,
    finalOutputFile: page.outputFile,
    sourceSha256: sourceMetadata.sha256,
    sourceDimensions: { width: sourceMetadata.width, height: sourceMetadata.height },
  };
}
