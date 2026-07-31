#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const major = Number.parseInt(process.versions.node.split(".")[0], 10);
if (major < 20) throw new Error(`Node.js 20+ is required; current runtime is ${process.version}`);

const requiredFiles = [
  "SKILL.md",
  "LICENSE",
  "assets/fonts/OFL-1.1.txt",
  "package-lock.json",
  "scripts/run.mjs",
  "scripts/provider-clients.mjs",
  "references/style-presets.json",
];
await Promise.all(requiredFiles.map((relativePath) => access(path.join(root, relativePath))));

const [packageJson, manifest, fontRoute] = await Promise.all([
  readJson("package.json"),
  readJson("skill-manifest.json"),
  readJson("references/routes/bundled-sharp-post-layout.json"),
]);
if (packageJson.version !== manifest.version || manifest.version !== "0.3.9") {
  throw new Error("package.json and skill-manifest.json must both declare version 0.3.9");
}
if (packageJson.dependencies?.sharp !== "0.35.3") {
  throw new Error("sharp must be pinned exactly to 0.35.3");
}

const sharp = (await import("sharp")).default;
const sharpVersion = sharp.versions?.sharp;
if (sharpVersion !== "0.35.3") throw new Error(`Installed sharp must be 0.35.3; found ${sharpVersion || "unknown"}`);

const fontPath = path.resolve(path.dirname(path.join(root, "references/routes/bundled-sharp-post-layout.json")), fontRoute.fontFile);
const fontHash = sha256(await readFile(fontPath));
if (fontHash !== fontRoute.fontSha256) throw new Error(`Bundled font hash mismatch: ${fontHash}`);
const fcQuery = spawnSync("fc-query", ["-f", "%{family}|%{charset}", fontPath], { encoding: "utf8" });
if (fcQuery.error?.code === "ENOENT") throw new Error("fc-query is required for post-layout font verification");
if (fcQuery.status !== 0 || !fcQuery.stdout.includes("Noto Sans CJK SC")) {
  throw new Error("fc-query could not verify the bundled Noto Sans CJK SC font");
}

console.log(JSON.stringify({
  valid: true,
  node: process.version,
  skillVersion: manifest.version,
  artifactVersion: manifest.artifactVersion,
  sharp: sharpVersion,
  fontSha256: fontHash,
  fontconfig: "verified",
}, null, 2));
