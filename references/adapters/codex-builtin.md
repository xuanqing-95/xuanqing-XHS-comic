# Codex built-in image adapter

This adapter is an interactive self-use entry into the canonical `social-comic-generator` Skill. It is not a second Skill and must not own copied prompts, style presets, defaults, Eval thresholds, or artifact schemas.

## Shared source

- Read `skill-manifest.json` and the same references selected by `SKILL.md`.
- Produce version-3 input, story, character, plan, visual-lock, prompt, result, Eval, diagnosis, and copywriting artifacts.
- Compile each complete comic-page prompt with `scripts/compile-prompts.mjs`.
- Use the chosen canonical style preset's complete lock, or the user's custom/reference-led lock.

## Prepare the interactive invocation plan

After the version-3 run reaches `planned`, prepare the built-in host calls without changing the canonical plan or prompts:

```bash
node scripts/prepare-codex-builtin.mjs /absolute/path/to/run-dir
```

The preparation step uses only Node built-in modules and makes zero provider calls. It writes:

- `codex-builtin-assets/aspect-only-blank-3x4.png`: a deterministic shallow warm-gray `1080x1440` reference used only to suggest the canvas aspect;
- `codex-prompts/NN.md`: thin derived prompts that retain the canonical story, character, style, panel, and text contract while declaring the aspect-only reference honestly;
- `codex-builtin-invocations.json`: ordered interactive calls, prompt paths, attachment order and roles, output paths, dependencies, measurement requirements, and no-retry/no-post-processing guardrails.

The blank reference is an adapter aid, not a style or content reference. It is attached to every page because a controlled follow-up showed that a native 3:4 generated Page 1 did not reliably preserve 3:4 when used alone for Page 2. When original user references exist, they keep their canonical order. For `anchor-first-fanout`, Page 1 attaches the original references and then the blank reference; later pages attach the original references, the generated Page 1 anchor, and finally the blank reference. The blank reference is always last so canonical user-reference and generated-anchor numbering remains stable.

Fail closed when `input.output.exactSize` is present. The observed workaround supports aspect intent only and does not prove exact pixel delivery.

## Interactive image call

1. Tell the user that the built-in host tool uses their host-account allowance and currently exposes no independent size/aspect-ratio execution parameter.
2. Run the preparation command and follow `codex-builtin-invocations.json` exactly. Ask for one complete publishable portrait 3:4 comic page per planned page. Never request naked illustrations or separately generated panels for later stitching.
3. Attach references in the listed order. For `anchor-first-fanout`, finish and measure Page 1 before starting dependent pages.
4. Inspect the returned image dimensions and visible comic form immediately.
5. Accept a page only if the returned canvas is provider-native 3:4 within the canonical one-pixel rounding tolerance. Otherwise preserve the evidence and mark the run failed or needs-review.
6. Do not crop, resize, pad, stretch, or stitch. Do not automatically retry a usable but noncompliant image.

When the host returns a PNG, ingest the untouched provider file before continuing:

```bash
node scripts/ingest-codex-builtin-result.mjs \
  --run-dir /absolute/path/to/run-dir \
  --page-id page-01 \
  --provider-output /absolute/path/to/provider-result.png
```

The ingestion tool copies identical bytes only, measures PNG dimensions, records SHA-256 and dependency acceptance, rejects tampering and path escape, and preserves a non-3:4 original under `codex-builtin-evidence/noncompliant/` with a non-zero exit. It never edits `result.json` or creates a visual Eval; those remain later workflow stages.

If a bounded host invocation returns no image, record that runtime outcome rather than inventing a visual result or changing the prompt:

```bash
node scripts/record-codex-builtin-failure.mjs \
  --run-dir /absolute/path/to/run-dir \
  --page-id page-01 \
  --code HOST_TIMEOUT_NO_OUTPUT \
  --message "The host returned no image inside the bounded observation window." \
  --wall-time-seconds 1500
```

This writes a failed generation result, unavailable failed-call receipt, debug event and runtime diagnosis, preserves any already accepted page prefix, leaves `eval-report.json` absent when no image exists, and does not authorize a retry.

Current runtime evidence has two parts. First, the same Page 1 prompt returned `1024x1536` without a reference and provider-direct `1086x1448` when the blank `1080x1440` 3:4 reference was attached; the successful treatment took about 677 seconds. Second, a provider-direct `1086x1448` Page 1 used alone as the generated identity/style anchor still produced a `1024x1536` Page 2. Therefore every page gets the dedicated blank aspect reference, including generated-anchor pages. This remains a runtime-verified interactive workaround, not an unattended size API, and every returned page still requires measurement. It also does not guarantee native Chinese punctuation: required text must still pass normal character-level visual evaluation.

A fresh two-page every-page-blank test was attempted with an auto-planned seven-panel black-and-white screentone comic. Page 1 returned no image within a bounded 1500-second observation window and was terminated; Page 2 was not invoked because its anchor dependency was unavailable. This proves the failure recorder and stop rule, but it does not yet visually verify the corrected multi-page aspect strategy. See `references/evidence/codex-builtin-case04-timeout-v1.json`.

## Usage and delivery boundary

- Record successful built-in model calls with the real host identity when known and `meteringStatus: unavailable` when the host does not expose usage. Never invent tokens or platform prices.
- Local interactive results may be reviewed and handed to the user, but they are not automatically eligible for a host platform's settlement or public delivery.
- Hosted publication must run through the `platform-api` adapter, whose capability preflight and complete provider metering fail closed.
