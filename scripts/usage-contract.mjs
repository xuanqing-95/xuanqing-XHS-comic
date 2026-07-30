import { createHash } from "node:crypto";

const MODEL_ROLES = new Set(["planner", "image", "evaluator"]);
const CALL_STATUSES = new Set(["started", "succeeded", "failed", "reused"]);
const METERING_STATUSES = new Set(["pending", "available", "unavailable", "reused", "not_applicable"]);

export function stableHash(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(serialized).digest("hex");
}

export function sha256Bytes(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("sha256Bytes requires a Buffer or Uint8Array");
  }
  return createHash("sha256").update(value).digest("hex");
}

export function usageHasMetering(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  const values = [
    usage.input_tokens,
    usage.prompt_tokens,
    usage.inputTokens,
    usage.output_tokens,
    usage.completion_tokens,
    usage.outputTokens,
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.cache_read_input_tokens,
    usage.cacheReadTokens,
  ];
  return values.some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
}

export function summarizeUsageStatus(calls = []) {
  const modelCalls = calls.filter((call) => MODEL_ROLES.has(call.role) && call.status === "succeeded");
  if (modelCalls.length === 0) return "not_applicable";
  const available = modelCalls.filter((call) => call.meteringStatus === "available" && usageHasMetering(call.usage)).length;
  if (available === modelCalls.length) return "complete";
  if (available > 0) return "partial";
  return "unavailable";
}

export function upsertUsageCall(calls = [], call) {
  if (!call || typeof call !== "object" || Array.isArray(call)) throw new TypeError("usage call must be an object");
  if (typeof call.callId !== "string" || call.callId.trim() === "") throw new TypeError("usage call requires callId");
  const next = [...calls];
  const index = next.findIndex((item) => item.callId === call.callId);
  if (index < 0) next.push(call);
  else next[index] = { ...next[index], ...call };
  return next;
}

export function validateUsageCall(call, index = 0) {
  const errors = [];
  const field = `usage.calls[${index}]`;
  for (const key of ["callId", "role", "stage", "operation", "status", "meteringStatus"]) {
    if (typeof call?.[key] !== "string" || call[key].trim() === "") errors.push(`${field}.${key} must be a non-empty string`);
  }
  if (call?.status && !CALL_STATUSES.has(call.status)) errors.push(`${field}.status is unsupported`);
  if (call?.meteringStatus && !METERING_STATUSES.has(call.meteringStatus)) errors.push(`${field}.meteringStatus is unsupported`);
  if (call?.status === "succeeded" && MODEL_ROLES.has(call.role)) {
    if (!["available", "unavailable"].includes(call.meteringStatus)) {
      errors.push(`${field}.meteringStatus must be available or unavailable for a succeeded model call`);
    }
    if (call.meteringStatus === "available" && !usageHasMetering(call.usage)) {
      errors.push(`${field}.usage must contain positive metering when meteringStatus is available`);
    }
    for (const key of ["provider", "model", "pricingModel", "inputHash", "outputHash", "completedAt"]) {
      if (typeof call[key] !== "string" || call[key].trim() === "") errors.push(`${field}.${key} must be a non-empty string for a succeeded model call`);
    }
  }
  if (call?.status === "started" && call.meteringStatus !== "pending") {
    errors.push(`${field}.meteringStatus must be pending while status is started`);
  }
  if (call?.status === "reused" && call.meteringStatus !== "reused") {
    errors.push(`${field}.meteringStatus must be reused while status is reused`);
  }
  if (call?.role === "compositor" && call.meteringStatus !== "not_applicable") {
    errors.push(`${field}.meteringStatus must be not_applicable for the local compositor`);
  }
  return errors;
}

export function buildUsageArtifact(calls = []) {
  const status = summarizeUsageStatus(calls);
  const reason = status === "complete"
    ? undefined
    : status === "partial"
      ? "Some successful provider calls exposed usage and others did not. The run is not safe to settle."
      : status === "unavailable"
        ? "Successful provider calls did not expose positive usage metering. The run is not billable."
        : "No billable provider call has completed in this artifact set.";
  return { status, calls, reason };
}

export const usageContract = {
  callStatuses: [...CALL_STATUSES],
  meteringStatuses: [...METERING_STATUSES],
  modelRoles: [...MODEL_ROLES],
};
