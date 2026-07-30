import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CAPABILITIES = new Set(["text", "image", "vision"]);
const DIMENSION_STATUSES = new Set(["supported", "unknown", "unsupported"]);
const DIMENSION_MECHANISMS = new Set(["size", "aspect-ratio", "none"]);
const DIMENSION_GUARANTEES = new Set(["exact", "aspect-ratio", "none"]);
const IMAGE_OPERATIONS = new Set(["generation", "edit"]);
const EVIDENCE_LEVELS = new Set(["configured", "documented", "runtime-verified"]);
const DEFAULT_CHAT_TIMEOUT_MS = 120_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 300_000;
const REDFLOW_RELAY_HEADER = "X-Redflow-Relay-Token";
const REDFLOW_RELAY_PATH = "/api/internal/zenmux";
const MAX_RELAY_JSON_BYTES = 4 * 1024 * 1024;
const RELAY_IMAGE_MAX_WIDTH = 768;
const RELAY_IMAGE_MAX_HEIGHT = 1024;
const RELAY_IMAGE_WEBP_QUALITY = 65;
let relaySharpPromise;

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeApiKeyEnv(value) {
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0) throw new Error("route.apiKeyEnv must not be empty");
  return entries.map((entry, index) => {
    const name = requireString(entry, `route.apiKeyEnv[${index}]`);
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
      throw new Error(`route.apiKeyEnv contains an invalid environment variable name: ${name}`);
    }
    return name;
  });
}

function normalizeOptionalEnvName(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  const name = requireString(value, field);
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
    throw new Error(`${field} contains an invalid environment variable name: ${name}`);
  }
  return name;
}

function sizeString(value, field) {
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+)x(\d+)$/i);
    if (!match) throw new Error(`${field} must use WIDTHxHEIGHT`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
      throw new Error(`${field} must contain positive integer dimensions`);
    }
    return `${width}x${height}`;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { width, height } = value;
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
      throw new Error(`${field}.width and ${field}.height must be positive integers`);
    }
    return `${width}x${height}`;
  }

  throw new Error(`${field} must be WIDTHxHEIGHT or an object with width and height`);
}

function parseAspectRatio(value) {
  const match = requireString(value, "aspectRatio").match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error("aspectRatio must use W:H, for example 3:4");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) throw new Error("aspectRatio values must be positive");
  return { value: `${match[1]}:${match[2]}`, ratio: width / height };
}

function normalizeAspectRatioSizes(value) {
  if (value === undefined) return undefined;
  requireObject(value, "route.aspectRatioSizes");
  const normalized = {};
  for (const [ratio, size] of Object.entries(value)) {
    parseAspectRatio(ratio);
    normalized[ratio] = sizeString(size, `route.aspectRatioSizes[${JSON.stringify(ratio)}]`);
  }
  return normalized;
}

function normalizeSupportedSizes(value, field = "route.supportedSizes") {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array when provided`);
  }
  return [...new Set(value.map((entry, index) => sizeString(entry, `${field}[${index}]`)))];
}

function normalizeDimensionControl(value) {
  if (value === undefined) return undefined;
  requireObject(value, "route.dimensionControl");
  const status = requireString(value.status, "route.dimensionControl.status");
  const mechanism = requireString(value.mechanism, "route.dimensionControl.mechanism");
  const guarantee = requireString(value.guarantee, "route.dimensionControl.guarantee");
  if (!DIMENSION_STATUSES.has(status)) {
    throw new Error(`route.dimensionControl.status must be one of: ${[...DIMENSION_STATUSES].join(", ")}`);
  }
  if (!DIMENSION_MECHANISMS.has(mechanism)) {
    throw new Error(`route.dimensionControl.mechanism must be one of: ${[...DIMENSION_MECHANISMS].join(", ")}`);
  }
  if (!DIMENSION_GUARANTEES.has(guarantee)) {
    throw new Error(`route.dimensionControl.guarantee must be one of: ${[...DIMENSION_GUARANTEES].join(", ")}`);
  }
  if (!Array.isArray(value.operations)) {
    throw new Error("route.dimensionControl.operations must be an array");
  }
  const operations = [...new Set(value.operations.map((entry, index) => {
    const operation = requireString(entry, `route.dimensionControl.operations[${index}]`);
    if (!IMAGE_OPERATIONS.has(operation)) {
      throw new Error(`route.dimensionControl.operations contains unsupported operation: ${operation}`);
    }
    return operation;
  }))];
  const evidence = requireObject(value.evidence, "route.dimensionControl.evidence");
  const evidenceLevel = requireString(evidence.level, "route.dimensionControl.evidence.level");
  if (!EVIDENCE_LEVELS.has(evidenceLevel)) {
    throw new Error(`route.dimensionControl.evidence.level must be one of: ${[...EVIDENCE_LEVELS].join(", ")}`);
  }
  const source = requireString(evidence.source, "route.dimensionControl.evidence.source");
  const normalized = {
    status,
    mechanism,
    guarantee,
    operations,
    evidence: { level: evidenceLevel, source },
  };
  if (value.reason !== undefined) normalized.reason = requireString(value.reason, "route.dimensionControl.reason");
  return normalized;
}

function normalizeQualityMap(value) {
  if (value === undefined) return undefined;
  requireObject(value, "route.qualityMap");
  const normalized = {};
  for (const [productQuality, providerQuality] of Object.entries(value)) {
    const key = requireString(productQuality, "route.qualityMap key");
    normalized[key] = requireString(providerQuality, `route.qualityMap[${JSON.stringify(key)}]`);
  }
  if (Object.keys(normalized).length === 0) throw new Error("route.qualityMap must not be empty");
  return normalized;
}

function normalizeRoute(route, expectedCapability) {
  requireObject(route, "route");
  if (Object.hasOwn(route, "apiKey") || Object.hasOwn(route, "authorization")) {
    throw new Error("route must reference apiKeyEnv; inline credentials are forbidden");
  }

  const capability = requireString(route.capability, "route.capability");
  if (!CAPABILITIES.has(capability)) {
    throw new Error(`route.capability must be one of: ${[...CAPABILITIES].join(", ")}`);
  }
  if (expectedCapability !== undefined && capability !== expectedCapability) {
    throw new Error(`route capability mismatch: expected ${expectedCapability}, received ${capability}`);
  }

  const dimensionControl = capability === "image" ? normalizeDimensionControl(route.dimensionControl) : undefined;
  const capabilityOnlyDescriptor = capability === "image" && dimensionControl?.status === "unsupported";

  let baseURL;
  if (!capabilityOnlyDescriptor || route.baseURL !== undefined) {
    baseURL = requireString(route.baseURL, "route.baseURL").replace(/\/+$/, "");
    let parsedBaseURL;
    try {
      parsedBaseURL = new URL(baseURL);
    } catch {
      throw new Error("route.baseURL must be an absolute HTTP(S) URL");
    }
    if (!new Set(["http:", "https:"]).has(parsedBaseURL.protocol)) {
      throw new Error("route.baseURL must use HTTP or HTTPS");
    }
  }

  const normalized = {
    capability,
    model: requireString(route.model, "route.model"),
    provider: requireString(route.provider, "route.provider"),
    adapter: requireString(route.adapter, "route.adapter"),
    pricingModel: requireString(route.pricingModel, "route.pricingModel"),
  };
  if (baseURL) normalized.baseURL = baseURL;
  if (!capabilityOnlyDescriptor || route.apiKeyEnv !== undefined) {
    normalized.apiKeyEnv = normalizeApiKeyEnv(route.apiKeyEnv);
  }
  const relayTokenEnv = normalizeOptionalEnvName(route.relayTokenEnv, "route.relayTokenEnv");
  if (relayTokenEnv) normalized.relayTokenEnv = relayTokenEnv;

  const aspectRatioSizes = normalizeAspectRatioSizes(route.aspectRatioSizes);
  const supportedSizes = normalizeSupportedSizes(route.supportedSizes, "route.supportedSizes");
  const exactOutputSizes = normalizeSupportedSizes(route.exactOutputSizes, "route.exactOutputSizes");
  const qualityMap = normalizeQualityMap(route.qualityMap);
  if (aspectRatioSizes) normalized.aspectRatioSizes = aspectRatioSizes;
  if (supportedSizes) normalized.supportedSizes = supportedSizes;
  if (exactOutputSizes) normalized.exactOutputSizes = exactOutputSizes;
  if (dimensionControl) normalized.dimensionControl = dimensionControl;
  if (qualityMap) normalized.qualityMap = qualityMap;
  if (route.supportsReferences !== undefined) {
    if (typeof route.supportsReferences !== "boolean") {
      throw new Error("route.supportsReferences must be a boolean when provided");
    }
    normalized.supportsReferences = route.supportsReferences;
  }

  return Object.freeze(normalized);
}

function resolveApiKey(route) {
  if (!Array.isArray(route.apiKeyEnv) || route.apiKeyEnv.length === 0) {
    throw new Error("Image route is a non-executable capability descriptor and has no API credential route");
  }
  for (const envName of route.apiKeyEnv) {
    const value = process.env[envName];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  throw new Error(`Missing API key in environment variable(s): ${route.apiKeyEnv.join(", ")}`);
}

function resolveRelayToken(route) {
  if (!route.relayTokenEnv) return "";
  const token = process.env[route.relayTokenEnv];
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(`Missing relay token in environment variable: ${route.relayTokenEnv}`);
  }
  return token.trim();
}

function relayHeaders(route) {
  const token = resolveRelayToken(route);
  return token ? { [REDFLOW_RELAY_HEADER]: token } : {};
}

function isRedflowRelayRoute(route) {
  if (!route.relayTokenEnv) return false;
  try {
    const url = new URL(route.baseURL);
    return url.pathname.replace(/\/+$/, "") === REDFLOW_RELAY_PATH;
  } catch {
    return false;
  }
}

function encodeRelayJsonBody(payload, label) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > MAX_RELAY_JSON_BYTES) {
    throw new Error(`${label} exceeds the 4 MiB RedFlow relay request limit`);
  }
  return body;
}

async function loadRelaySharp() {
  if (!relaySharpPromise) {
    relaySharpPromise = (async () => {
      const resolveFrom = String(process.env.SOCIAL_COMIC_SHARP_RESOLVE_FROM || "").trim();
      const imported = resolveFrom
        ? createRequire(pathToFileURL(path.resolve(resolveFrom)))("sharp")
        : await import("sharp");
      const sharp = imported.default || imported;
      if (typeof sharp !== "function") throw new Error("Social Comic relay image compressor is unavailable");
      return sharp;
    })();
  }
  return relaySharpPromise;
}

async function compressRelayImage(image) {
  const sharp = await loadRelaySharp();
  let bytes;
  try {
    bytes = await sharp(image.bytes, { failOn: "error" })
      .rotate()
      .resize({
        width: RELAY_IMAGE_MAX_WIDTH,
        height: RELAY_IMAGE_MAX_HEIGHT,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: RELAY_IMAGE_WEBP_QUALITY, effort: 4 })
      .toBuffer();
  } catch (error) {
    throw new Error(`Cannot prepare relay image ${image.path}: ${error?.message || String(error)}`);
  }
  if (!bytes || bytes.length === 0) throw new Error(`Relay image compression returned no bytes for ${image.path}`);
  return { ...image, bytes, mimeType: "image/webp" };
}

function ensureTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("timeoutMs must be a positive integer");
  return value;
}

async function fetchResponse(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw new Error(`${label} failed: ${error?.message || String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response, label) {
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function routeResult(route) {
  return {
    provider: route.provider,
    model: route.model,
    pricingModel: route.pricingModel,
  };
}

function responseRequestId(response) {
  return response.headers.get("x-request-id") ||
    response.headers.get("request-id") ||
    response.headers.get("x-amzn-requestid") ||
    null;
}

function messageContentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter((part) => part && typeof part === "object" && (part.type === "text" || typeof part.text === "string"))
      .map((part) => String(part.text || ""))
      .join("");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

function parseStrictJsonObject(value) {
  const raw = messageContentText(value).trim();
  if (!raw) throw new Error("Chat model returned empty content");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Chat model did not return strict JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Chat model must return one JSON object");
  }
  return parsed;
}

function mimeTypeFor(filePath, bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  throw new Error(`Unsupported reference image type: ${filePath}`);
}

async function readImageFile(filePath, field) {
  const resolved = path.resolve(requireString(filePath, field));
  let bytes;
  try {
    bytes = await fs.readFile(resolved);
  } catch (error) {
    throw new Error(`Cannot read ${field}: ${error.message}`);
  }
  if (bytes.length === 0) throw new Error(`${field} is empty`);
  return { path: resolved, bytes, mimeType: mimeTypeFor(resolved, bytes) };
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Image API output is not a readable PNG");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error("Image API output has invalid PNG dimensions");
  return { width, height };
}

function resolveRequestedSize(route, aspectRatio, exactSize) {
  const parsedAspect = parseAspectRatio(aspectRatio);
  let requestedSize;

  if (exactSize !== undefined && exactSize !== null) {
    requestedSize = sizeString(exactSize, "exactSize");
    if (!route.supportedSizes || !route.supportedSizes.includes(requestedSize)) {
      throw new Error(`User exactSize ${requestedSize} is not listed in route.supportedSizes`);
    }
    if (!route.exactOutputSizes || !route.exactOutputSizes.includes(requestedSize)) {
      throw new Error(`User exactSize ${requestedSize} is not listed in route.exactOutputSizes`);
    }
  } else {
    requestedSize = route.aspectRatioSizes?.[parsedAspect.value];
    if (!requestedSize) {
      throw new Error(`route.aspectRatioSizes does not define ${parsedAspect.value}`);
    }
  }

  if (route.supportedSizes && !route.supportedSizes.includes(requestedSize)) {
    throw new Error(`Requested size ${requestedSize} is not listed in route.supportedSizes`);
  }
  return requestedSize;
}

async function imageBytesFromResult(result, timeoutMs) {
  const image = result?.data?.[0];
  if (typeof image?.b64_json === "string" && image.b64_json.trim() !== "") {
    const bytes = Buffer.from(image.b64_json, "base64");
    if (bytes.length === 0) throw new Error("Image API returned empty b64_json");
    return bytes;
  }
  if (typeof image?.url === "string" && image.url.trim() !== "") {
    const response = await fetchResponse(image.url, {}, timeoutMs, "Image download");
    if (!response.ok) throw new Error(`Image download returned HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("Image API did not return b64_json or url");
}

/** Load and validate one standalone, explicit provider route JSON file. */
export async function loadRoute(routePath, expectedCapability) {
  const resolved = path.resolve(requireString(routePath, "routePath"));
  let route;
  try {
    route = JSON.parse(await fs.readFile(resolved, "utf8"));
  } catch (error) {
    throw new Error(`Cannot load route JSON ${resolved}: ${error.message}`);
  }
  return normalizeRoute(route, expectedCapability);
}

/** Call an OpenAI-compatible chat endpoint and require one strict JSON object. */
export async function runJsonChat({ route, prompt, imageFiles = [], timeoutMs } = {}) {
  const normalizedRoute = normalizeRoute(route);
  if (!new Set(["text", "vision"]).has(normalizedRoute.capability)) {
    throw new Error("runJsonChat requires a text or vision route");
  }
  const userPrompt = requireString(prompt, "prompt");
  if (!Array.isArray(imageFiles)) throw new Error("imageFiles must be an array");
  if (imageFiles.length > 0 && normalizedRoute.capability !== "vision") {
    throw new Error("imageFiles require a vision route");
  }

  const images = [];
  for (const [index, file] of imageFiles.entries()) {
    images.push(await readImageFile(file, `imageFiles[${index}]`));
  }
  const usesRelay = isRedflowRelayRoute(normalizedRoute);
  const requestImages = usesRelay && normalizedRoute.capability === "vision"
    ? await Promise.all(images.map(compressRelayImage))
    : images;

  const apiKey = resolveApiKey(normalizedRoute);
  const userContent = requestImages.length === 0
    ? userPrompt
    : [
        { type: "text", text: userPrompt },
        ...requestImages.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` },
        })),
      ];
  const body = {
    model: normalizedRoute.model,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Return exactly one valid JSON object. Do not use Markdown, code fences, comments, or explanatory text.",
      },
      { role: "user", content: userContent },
    ],
  };

  const response = await fetchResponse(
    `${normalizedRoute.baseURL}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...relayHeaders(normalizedRoute),
      },
      body: usesRelay
        ? encodeRelayJsonBody(body, "Chat request")
        : JSON.stringify(body),
    },
    ensureTimeout(timeoutMs, DEFAULT_CHAT_TIMEOUT_MS),
    "Chat API",
  );
  const requestId = responseRequestId(response);
  const result = await readJsonResponse(response, "Chat API");
  const data = parseStrictJsonObject(result?.choices?.[0]?.message?.content);
  return {
    data,
    ...routeResult(normalizedRoute),
    requestId,
    usage: result?.usage ?? null,
    attempts: 1,
  };
}

/** Generate one complete comic page through an OpenAI-compatible image route. */
export async function generatePage({
  route,
  prompt,
  referenceFiles = [],
  aspectRatio,
  exactSize,
  quality,
  outputPath,
  timeoutMs,
} = {}) {
  const normalizedRoute = normalizeRoute(route, "image");
  if (normalizedRoute.dimensionControl?.status !== "supported") {
    throw new Error("Image route dimension control is not supported; generation was not attempted");
  }
  const imagePrompt = requireString(prompt, "prompt");
  const destination = path.resolve(requireString(outputPath, "outputPath"));
  if (!Array.isArray(referenceFiles)) throw new Error("referenceFiles must be an array");
  if (referenceFiles.length > 0 && normalizedRoute.supportsReferences !== true) {
    throw new Error("Image route does not support reference images");
  }
  const requestedSize = resolveRequestedSize(normalizedRoute, aspectRatio, exactSize);
  const references = [];
  for (const [index, file] of referenceFiles.entries()) {
    references.push(await readImageFile(file, `referenceFiles[${index}]`));
  }
  const productQuality = quality === undefined || quality === null
    ? null
    : requireString(quality, "quality");
  const normalizedQuality = productQuality === null
    ? null
    : normalizedRoute.qualityMap?.[productQuality] ?? productQuality;

  // Resolve credentials only after all deterministic preflight checks have passed.
  const apiKey = resolveApiKey(normalizedRoute);
  const requestTimeoutMs = ensureTimeout(timeoutMs, DEFAULT_IMAGE_TIMEOUT_MS);
  const usesRelay = isRedflowRelayRoute(normalizedRoute);
  const requestReferences = usesRelay
    ? await Promise.all(references.map(compressRelayImage))
    : references;
  let endpoint;
  let request;
  if (references.length === 0) {
    endpoint = `${normalizedRoute.baseURL}/images/generations`;
    const body = { model: normalizedRoute.model, prompt: imagePrompt, size: requestedSize };
    if (normalizedQuality) body.quality = normalizedQuality;
    request = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...relayHeaders(normalizedRoute),
      },
      body: usesRelay
        ? encodeRelayJsonBody(body, "Image generation request")
        : JSON.stringify(body),
    };
  } else if (usesRelay) {
    endpoint = `${normalizedRoute.baseURL}/images/edits`;
    const body = {
      model: normalizedRoute.model,
      prompt: imagePrompt,
      size: requestedSize,
      images: requestReferences.map((reference) => ({
        image_url: `data:${reference.mimeType};base64,${reference.bytes.toString("base64")}`,
      })),
    };
    if (normalizedQuality) body.quality = normalizedQuality;
    request = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...relayHeaders(normalizedRoute),
      },
      body: encodeRelayJsonBody(body, "Image edit request"),
    };
  } else {
    endpoint = `${normalizedRoute.baseURL}/images/edits`;
    const form = new FormData();
    form.append("model", normalizedRoute.model);
    form.append("prompt", imagePrompt);
    form.append("size", requestedSize);
    if (normalizedQuality) form.append("quality", normalizedQuality);
    const imageField = references.length === 1 ? "image" : "image[]";
    for (const reference of requestReferences) {
      form.append(imageField, new Blob([reference.bytes], { type: reference.mimeType }), path.basename(reference.path));
    }
    request = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...relayHeaders(normalizedRoute),
      },
      body: form,
    };
  }

  const response = await fetchResponse(endpoint, request, requestTimeoutMs, "Image API");
  const requestId = responseRequestId(response);
  const result = await readJsonResponse(response, "Image API");
  const bytes = await imageBytesFromResult(result, requestTimeoutMs);
  const actualDimensions = pngDimensions(bytes);

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);

  return {
    ...routeResult(normalizedRoute),
    requestId,
    requestedSize,
    requestedQuality: normalizedQuality,
    actualDimensions,
    outputPath: destination,
    usage: result?.usage ?? null,
    attempts: 1,
  };
}
