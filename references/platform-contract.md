# Host platform contract

This Skill owns comic semantics, deterministic artifacts, validation, and the delivery manifest. The integrating host owns authentication, authorization, durable task state, storage, publication, pricing, billing, and settlement.

## Integration boundary

The host may expose any product action or workflow name. It compiles user-owned input into the version-3 run contract, invokes `scripts/run.mjs`, validates the completed run, and maps the generic delivery manifest back to its own records.

Client input must never contain arbitrary server-local paths or credential values. When a host offers uploaded reference selection, it must authorize ownership, decode and bound the file safely, copy it into the run directory, and give the Skill only a run-relative path plus immutable provenance.

The Skill adapter owns:

- compiling the normalized version-3 input and non-secret route JSON;
- executing `plan → generate → compose? → evaluate`;
- comic planning, prompts, lettering, Eval, and Diagnosis semantics;
- validating run artifacts and building a generic delivery manifest;
- returning final pages, private artifacts, usage receipts, and result status.

The host owns:

- action routing, concurrency control, cancellation, and durable state;
- user and reference-asset authorization;
- secret resolution and model-call authorization;
- conservative budget or credit preflight;
- storage upload, database writes, publication, and cleanup;
- transactional, idempotent billing and settlement.

Do not move comic semantics into generic host billing or storage helpers. Do not move host credentials, account balances, or database writes into this Skill.

## Generic delivery identity

Call `buildDeliveryManifest` with:

- `runId`: the host's stable execution identifier;
- `hostActionId`: the host-defined action or workflow identifier;
- `hostItemId`: the host record receiving the result;
- `hostMetadata`: optional JSON metadata, limited to 16 KiB;
- `sourceIdentity`: the pinned release repository, tag, commit, version, artifact version, and hashes.

These names deliberately avoid any specific product database schema. An integration maps them to its own identifiers outside this package.

## Route roles

The unattended adapter expects:

- a planner route using OpenAI-compatible JSON chat;
- an image route with executable native 3:4 size mapping and every required generation/edit capability;
- an evaluator route using OpenAI-compatible multimodal JSON chat.

The post-layout compositor is local deterministic code, not a model call. Route files contain environment-variable names, never credential values. A relay may be used, but it is still host-owned infrastructure and must preserve provider identity and usage evidence.

## Delivery gate

Only all of the following may become a host publication success:

- `result.status === "reviewed"`;
- `node scripts/validate-run.mjs <run-dir>` passes;
- Eval is `pass` and Diagnosis is `no-material-failure`;
- `outputIntegrity` passes;
- final page count, hashes, and dimensions match the manifest;
- `usage.status === "complete"` and every successful paid call has usable pricing identity;
- every public upload succeeds;
- host settlement commits atomically and readback confirms the result.

`needs-review`, `generated`, `generated-unlettered`, `planned`, and `failed` are not publishable deliveries. A provider source page under `source-images/` is never a final page.

## Storage split

Public storage receives only `delivery-manifest.pages`, which come from validated `result.pages` under `images/`.

Private evidence storage may receive the safe, relative-path artifact set: input, story package, plans and locks, result, usage receipts, Eval, Diagnosis, optional lettering artifacts, and immutable provider sources. Never upload route JSON, secrets, local absolute paths, temporary compose files, or unsanitized debug sidecars.

## Usage and settlement

Planner, every image generation/edit, and evaluator are separately metered. Local compose is `not_applicable`. `partial` or `unavailable` usage is truthful evidence but must fail closed before any billable publication.

Before settlement, the host must validate artifacts and receipts, resolve pricing, upload final pages, stage private evidence, and call one idempotent finalize operation keyed by its stable run ID. Sequential partial charging is unsafe because a later failure can leave the user charged without a valid delivery.

The Skill makes no database writes and never mutates credits directly.
