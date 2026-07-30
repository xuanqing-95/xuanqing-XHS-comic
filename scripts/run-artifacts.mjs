import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ARTIFACT_VERSION = 3;

const INITIAL_RESULT_ERROR = 'Execution started but did not reach a completed lifecycle state.';

export async function readJson(filePath) {
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    error.message = `Cannot read JSON ${filePath}: ${error.message}`;
    throw error;
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new SyntaxError(`Invalid JSON ${filePath}: ${error.message}`, { cause: error });
  }
}

export async function readJsonIfExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return readJson(filePath);
}

export async function writeJsonAtomic(filePath, value) {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError(`Cannot serialize JSON value for ${filePath}`);

  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, `${serialized}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }

  return filePath;
}

export async function mergeJsonArtifact(filePath, patch) {
  requirePlainObject(patch, 'artifact patch');
  const current = await readJsonIfExists(filePath);
  if (current !== null) requirePlainObject(current, filePath);
  const next = { ...(current || {}), ...patch, version: ARTIFACT_VERSION };
  await writeJsonAtomic(filePath, next);
  return next;
}

export async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function pngMetadata(filePath) {
  const bytes = await readFile(filePath);
  const pngSignature = '89504e470d0a1a0a';
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString('hex') !== pngSignature ||
    bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    throw new Error(`Not a readable PNG: ${filePath}`);
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error(`PNG has invalid dimensions: ${filePath}`);

  return {
    width,
    height,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function initializeRunArtifacts({
  runDir,
  stage = 'initialize',
  resume = false,
  inputPath = null,
  now = new Date().toISOString(),
} = {}) {
  requireNonEmptyString(runDir, 'runDir');
  requireNonEmptyString(stage, 'stage');

  await mkdir(path.join(runDir, 'prompts'), { recursive: true });
  await mkdir(path.join(runDir, 'images'), { recursive: true });
  await mkdir(path.join(runDir, 'source-images'), { recursive: true });

  const initial = {
    result: {
      version: ARTIFACT_VERSION,
      status: 'failed',
      stage,
      error: INITIAL_RESULT_ERROR,
    },
    usage: {
      version: ARTIFACT_VERSION,
      status: 'not_applicable',
      reason: 'No billable provider call has completed in this artifact set.',
      calls: [],
    },
    debug: {
      version: ARTIFACT_VERSION,
      status: 'running',
      stage,
      inputPath,
      resumed: Boolean(resume),
      startedAt: now,
      updatedAt: now,
      events: [{ at: now, stage, status: 'started' }],
      errors: [],
    },
  };

  for (const [name, value] of Object.entries(initial)) {
    const filePath = path.join(runDir, `${name}.json`);
    if (resume && (await readJsonIfExists(filePath)) !== null) continue;
    await writeJsonAtomic(filePath, value);
  }

  return {
    result: await readJson(path.join(runDir, 'result.json')),
    usage: await readJson(path.join(runDir, 'usage.json')),
    debug: await readJson(path.join(runDir, 'debug.json')),
  };
}

export function updateResult(runDir, patch) {
  return updateNamedArtifact(runDir, 'result', patch);
}

export function updateUsage(runDir, patch) {
  return updateNamedArtifact(runDir, 'usage', patch);
}

export function updateDebug(runDir, patch) {
  return updateNamedArtifact(runDir, 'debug', patch);
}

async function updateNamedArtifact(runDir, name, patch) {
  requireNonEmptyString(runDir, 'runDir');
  return mergeJsonArtifact(path.join(runDir, `${name}.json`), patch);
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be a plain object`);
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}
