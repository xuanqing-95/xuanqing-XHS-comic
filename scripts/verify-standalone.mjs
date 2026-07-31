#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), "utf8"));

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules", "dist", "runs", "output"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }
  return files;
}

const files = await walk(root);
const moduleFiles = files.filter((file) => file.endsWith(".mjs"));
for (const file of moduleFiles) {
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(checked.status, 0, `${path.relative(root, file)} failed syntax validation:\n${checked.stderr}`);
}

const [pkg, manifest, provenance] = await Promise.all([
  readJson("package.json"),
  readJson("skill-manifest.json"),
  readJson("assets/previews/provenance.json"),
]);
assert.equal(pkg.version, "0.3.9");
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.source.policy, "github-release-pinned");
assert.equal(manifest.source.canonicalPath, ".");
assert.equal(manifest.source.releaseTag, "v0.3.9");
assert.equal(manifest.license, "AGPL-3.0-only");
assert.equal(provenance.items.length, 6);

for (const item of provenance.items) {
  const bytes = await readFile(path.join(root, item.file));
  assert.equal(sha256(bytes), item.sha256, `${item.file} hash mismatch`);
}

const license = await readFile(path.join(root, "LICENSE"), "utf8");
assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
assert.match(await readFile(path.join(root, "NOTICE.md"), "utf8"), /AGPL-3\.0-only/);
assert.match(await readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8"), /SIL Open Font License 1\.1/);

for (const relativePath of [
  "skill-manifest.json",
  "scripts/delivery-manifest.mjs",
  "references/platform-contract.md",
  "references/series-assets.md",
  "references/adapters/codex-builtin.md",
]) {
  const text = await readFile(path.join(root, relativePath), "utf8");
  assert.doesNotMatch(text, /xhs_originals|task_costs|github-monorepo-pinned|PINNED_SKILL_SOURCE_IDENTITIES_B64/);
}

console.log(JSON.stringify({
  valid: true,
  syntaxChecked: moduleFiles.length,
  previewAssets: provenance.items.length,
  sourcePolicy: manifest.source.policy,
}, null, 2));
