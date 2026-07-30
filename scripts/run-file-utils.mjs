import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { sha256Bytes } from "./usage-contract.mjs";

export function resolveRunReferenceFile(inputBaseDir, file) {
  const referencePath = typeof file === "string" ? file : file?.file ?? file?.path ?? file?.image;
  if (typeof referencePath !== "string" || referencePath.trim() === "") {
    throw new Error("Every reference image must be a path string or an object with file/path/image.");
  }
  if (path.isAbsolute(referencePath)) return referencePath;
  return path.resolve(inputBaseDir, referencePath);
}

export async function ensureRunFilesExist(files) {
  for (const file of files) await access(file);
}

export async function hashRunFiles(files) {
  const hashes = [];
  for (const file of files) {
    const bytes = await readFile(file);
    hashes.push({ file: path.basename(file), sha256: sha256Bytes(bytes) });
  }
  return hashes;
}
