#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { generatePage, runJsonChat } from "./provider-clients.mjs";

const apiKeyEnv = "SOCIAL_COMIC_RELAY_TEST_API_KEY";
const relayTokenEnv = "SOCIAL_COMIC_RELAY_TEST_TOKEN";
const previous = {
  apiKey: process.env[apiKeyEnv],
  relayToken: process.env[relayTokenEnv],
  resolveFrom: process.env.SOCIAL_COMIC_SHARP_RESOLVE_FROM,
};
process.env[apiKeyEnv] = "test-api-key";
process.env[relayTokenEnv] = "test-relay-token";
process.env.SOCIAL_COMIC_SHARP_RESOLVE_FROM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");

const png = Buffer.alloc(24);
Buffer.from("89504e470d0a1a0a", "hex").copy(png);
png.writeUInt32BE(1, 16);
png.writeUInt32BE(1, 20);

const calls = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  calls.push({
    url: request.url,
    authorization: request.headers.authorization,
    relayToken: request.headers["x-redflow-relay-token"],
    contentType: request.headers["content-type"],
    body: Buffer.concat(chunks),
  });
  response.writeHead(200, { "content-type": "application/json" });
  if (request.url?.endsWith("/chat/completions")) {
    response.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ verdict: "pass" }) } }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  } else {
    response.end(JSON.stringify({
      data: [{ b64_json: png.toString("base64") }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
const relayBaseURL = `http://127.0.0.1:${address.port}/api/internal/zenmux`;
const directBaseURL = `http://127.0.0.1:${address.port}/direct`;
const common = { provider: "example", apiKeyEnv: [apiKeyEnv], relayTokenEnv };
const temporary = await mkdtemp(path.join(os.tmpdir(), "social-comic-relay-"));

try {
  const raw = randomFillSync(Buffer.alloc(1024 * 1365 * 3));
  const largePng = await sharp(raw, { raw: { width: 1024, height: 1365, channels: 3 } }).png().toBuffer();
  assert.ok(largePng.length > 4 * 1024 * 1024);
  const referencePath = path.join(temporary, "reference.png");
  await writeFile(referencePath, largePng);

  const vision = {
    ...common,
    baseURL: relayBaseURL,
    capability: "vision",
    adapter: "openai_compatible_chat",
    model: "example-vision",
    pricingModel: "example:vision",
  };
  assert.deepEqual((await runJsonChat({ route: vision, prompt: "Return JSON.", imageFiles: [referencePath] })).data, { verdict: "pass" });
  await runJsonChat({ route: { ...vision, baseURL: directBaseURL }, prompt: "Return JSON.", imageFiles: [referencePath] });

  const image = {
    ...common,
    baseURL: relayBaseURL,
    capability: "image",
    adapter: "openai_compatible_image",
    model: "example-image",
    pricingModel: "example:image",
    dimensionControl: {
      status: "supported",
      mechanism: "size",
      guarantee: "exact",
      operations: ["generation", "edit"],
      evidence: { level: "runtime-verified", source: "loopback" },
    },
    aspectRatioSizes: { "3:4": "1x1" },
    supportedSizes: ["1x1"],
    exactOutputSizes: ["1x1"],
    qualityMap: { final: "high" },
    supportsReferences: true,
  };
  const generatedPath = path.join(temporary, "generated.png");
  await generatePage({ route: image, prompt: "Generate.", aspectRatio: "3:4", quality: "final", outputPath: generatedPath });
  assert.deepEqual(await readFile(generatedPath), png);

  const editedPath = path.join(temporary, "edited.png");
  await generatePage({
    route: image,
    prompt: "Edit.",
    referenceFiles: [referencePath],
    aspectRatio: "3:4",
    quality: "final",
    outputPath: editedPath,
  });

  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.authorization === "Bearer test-api-key"));
  assert.ok(calls.every((call) => call.relayToken === "test-relay-token"));
  assert.ok(calls[0].body.length < 4 * 1024 * 1024);
  const relayPayload = JSON.parse(calls[0].body.toString("utf8"));
  const relayImage = relayPayload.messages[1].content.find((part) => part.type === "image_url").image_url.url;
  assert.match(relayImage, /^data:image\/webp;base64,/);
  assert.match(calls[1].body.toString("utf8"), /data:image\/png;base64,/);
  assert.equal(calls[2].url, "/api/internal/zenmux/images/generations");
  assert.match(calls[3].contentType || "", /^application\/json/);
  assert.match(calls[3].body.toString("utf8"), /data:image\/webp;base64,/);
  assert.deepEqual(await readFile(referencePath), largePng);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
  if (previous.apiKey === undefined) delete process.env[apiKeyEnv];
  else process.env[apiKeyEnv] = previous.apiKey;
  if (previous.relayToken === undefined) delete process.env[relayTokenEnv];
  else process.env[relayTokenEnv] = previous.relayToken;
  if (previous.resolveFrom === undefined) delete process.env.SOCIAL_COMIC_SHARP_RESOLVE_FROM;
  else process.env.SOCIAL_COMIC_SHARP_RESOLVE_FROM = previous.resolveFrom;
}

console.log(JSON.stringify({ valid: true, calls: calls.length, relayCompression: "webp-under-4MiB", directPath: "source-bytes-preserved" }, null, 2));
