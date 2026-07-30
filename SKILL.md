---
name: social-comic-generator
description: Turn a topic, proposition, lesson, draft, or ready-made story into a complete social-comic production package:传播角度、剧情、角色圣经、动态分页分格、native or deterministically lettered 3:4 comic pages、visual consistency、Eval/Diagnosis、and publish-ready titles/copy/tags. Use for 条漫、连续漫画、心理学/育儿/婚姻/人际/AI知识漫画, one-off posts, or recurring IP series. Preserve user-supplied stories, let the image model arrange panels freely by default when native lettering is used, determine page/panel counts from content rather than fixed templates, and never substitute naked illustrations for finished comic pages.
---

# 玄清小红书条漫

Turn one idea into a complete, executable comic-content package. Preserve the original creative premise: give the image model a strong story, character lock, aesthetic direction, and required copy, then let it direct the page composition unless stricter control is justified.

## Keep the complete product scope

Own the full sequence:

```text
topic or ready-made story
→传播角度
→完整剧情
→角色与系列锚点
→动态分页和分格
→直接生成完整3:4漫画页
→Eval
→问题归因
→发布文案与系列包装
```

Do not reduce the Skill to prompt writing, naked illustrations, or consistency testing alone.

## Use the correct units

- A **page** is one standalone 3:4 publishable deliverable: either a provider-direct native page or a same-canvas provider base with deterministic lettering applied only inside declared text regions.
- A **panel** is a framed scene inside a page.
- Generate panels, borders, bubbles/captions, actions, and page composition together in the final page image.
- Derive both page count and panel count from the story. Never default to 6, 8, 10, or another fixed count.
- Never replace a comic page with an unlettered illustration, character sheet, storyboard tile, contact sheet, or crop-derived asset.

## Read only the needed contracts

- Read [references/content-contract.md](references/content-contract.md) before producing传播角度、故事、角色或运营文案.
- Read [references/run-contract.md](references/run-contract.md) before creating run artifacts or integrating a backend.
- Read [references/planner-output-contract.md](references/planner-output-contract.md) when connecting a planning model. The planner returns decisions; deterministic code compiles prompts.
- Read [references/prompt-contract.md](references/prompt-contract.md) before compiling page prompts.
- Read [references/style-presets.json](references/style-presets.json) when the user selects a preset, asks what styles are available, or wants a stable reusable visual direction.
- Read [references/series-assets.md](references/series-assets.md) for recurring IP, supplied character sheets, three-view references, style anchors, or a series plan.
- Read [references/eval-contract.md](references/eval-contract.md) before evaluating or diagnosing.
- Read [references/platform-contract.md](references/platform-contract.md) before integrating a host action, uploading artifacts, or settling usage/costs.
- Read [references/editorial-safety.md](references/editorial-safety.md) for fact-sensitive content.
- Run `node scripts/validate-run.mjs <run-dir>` after planning and after evaluation.

## Use the automatic executor

The repository root is the one canonical Skill source. Never copy its prompts, style catalog, defaults, or workflow into a platform-only or Codex-only fork. Read `skill-manifest.json`, select one declared adapter, and keep the same version-3 artifact contract and `scripts/compile-prompts.mjs` prompt compiler across entries.

The unattended platform entry point is `scripts/run.mjs`. It keeps planning, page generation, visual evaluation, and diagnosis in distinct lifecycle stages while writing the same version-3 artifact contract.

```bash
node scripts/run.mjs \
  --input /absolute/path/input.json \
  --run-dir /absolute/path/run \
  --stage all \
  --planner-route-json /absolute/path/planner-route.json \
  --image-route-json /absolute/path/image-route.json \
  --compositor-route-json /absolute/path/compositor-route.json \
  --evaluator-route-json /absolute/path/evaluator-route.json \
  --authorize-model-calls
```

- `--authorize-model-calls` is mandatory for any provider call. Without it, the executor records a truthful failed or blocked state and makes zero model requests.
- Use `--stage plan`, `generate`, `compose`, or `evaluate` to run one stage. `all` runs them in that order and skips compose for native text. Use `--resume` when continuing the same run directory.
- `anchor-first-fanout` generates Page 1 first, then uses that final page as the shared reference for the remaining bounded-parallel requests.
- The executor never performs a paid retry or regeneration after Eval. A failed Eval becomes `needs-review` plus `diagnosis.json`.
- Route JSON contains non-secret provider configuration. Credentials are named through `apiKeyEnv` and never written to run artifacts.
- `usage.json` records stable per-call receipts for planner, every image generation/edit, and evaluator. `complete` means every successful provider call exposed real usage; `partial` or `unavailable` is truthful evidence but must fail closed in a billable host action. Local compose is `not_applicable`, and an ambiguous started call never authorizes an automatic paid retry.
- Run `node scripts/test-image-route-capabilities.mjs` for the zero-call route capability matrix, `node scripts/test-usage-contract.mjs` for per-call metering receipts, and `node scripts/test-post-layout.mjs` for deterministic lettering/font/pixel-integrity tests. Then run `node scripts/test-runner.mjs` and `node scripts/test-post-layout-runner.mjs` for native and post-layout local loopback integration. Together they verify authorization, dimension/operation preflight, anchor generation, native 3:4 metadata, compositor preflight, source preservation, same-canvas lettering, zero-call compose resume, visual Eval, diagnosis, and truthful usage handling.

For interactive self-use through Codex's built-in image model, follow `references/adapters/codex-builtin.md`. It uses this same Skill and canonical compiled prompts, but the host tool currently exposes no executable size parameter. After planning, run `node scripts/prepare-codex-builtin.mjs /absolute/path/to/run-dir`; the thin adapter writes deterministic derived prompts, a runtime-generated aspect-only 3:4 blank reference, and an ordered invocation plan without copying or changing the shared story/style/Eval contract. Attach the dedicated blank aspect reference to every page and additionally attach Page 1 on dependent pages for identity/style continuity. When a PNG returns, pass it through `scripts/ingest-codex-builtin-result.mjs` so the original bytes, dimensions, hash, dependency state, and compliance outcome are recorded without image transformation. When the host returns no image or times out, use `scripts/record-codex-builtin-failure.mjs`; do not create a fake visual Eval. Never crop, resize, pad, stretch, stitch, or silently retry. Exact pixel requests fail closed on this adapter. Record host usage as unavailable rather than inventing platform billing receipts. This local interactive adapter is not the unattended platform route.

## Execute the workflow

### 1. Normalize input and choose the route

Write `input.json` and choose one mode:

- `topic-to-comic`: the user supplies a topic, proposition, or lesson. Generate three传播角度, select the strongest, then write the story.
- `story-to-comic`: the user supplies a usable plot or draft. Preserve it; skip angle invention unless explicitly requested.
- `series-continuation`: reuse approved character/style/column anchors, then plan a new episode from the supplied topic or story.

Do not make a user restate information that already exists. Preserve audience, core message, tone, platform, CTA, references, text strategy, quality/cost priority, any explicit panel/page count, and any style choice.

Normalize visual intent as one of:

- `preset`: resolve `visual.preset` from `references/style-presets.json` and copy the complete preset lock into `visual-lock.json`; a preset name alone is not an implementation.
- `custom`: translate `visual.customStyle` into the same complete lock fields without forcing it into a preset.
- `reference`: derive the lock from supplied reference images and record what each reference controls.

Legacy inputs with only `visual.style` remain readable, but all new runs should use `styleMode`. Never silently replace a user's custom or reference-led direction with the default preset.

### 2. Plan the传播 angle

Write `topic-angles.json`.

For `topic-to-comic`, generate exactly three meaningfully different angles. For each, identify audience tension, conflict, emotion, turn, and why comics help. Select one using relevance, visual action, emotional movement, factual safety, and platform fit—not clickbait alone.

For `story-to-comic`, record `status: skipped` and the reason. Never rewrite a supplied story merely to satisfy a template.

### 3. Write or preserve the complete story

Write `story.json` with title, logline, summary, hook, escalation, turn, resolution, ending hook, emotional curve, core message, and claims needing verification.

Require conflict, progression, and a memorable ending, but vary the structure. Do not force every topic into identical “conflict → lecture → slogan” beats. Prefer concrete human action and natural dialogue over explanatory monologues.

### 4. Build the character and series bible

Write `character-bible.json`, then compile `visual-lock.json` from it.

Keep core characters few, distinctive, and reproducible. Lock face, hair, body proportion, wardrobe silhouette, signature colors, recurring props, personality, relationships, expression range, and forbidden changes.

- Reuse user-supplied character sheets or three-view images when present.
- Do not generate a disposable character sheet for a one-off post.
- Generate or maintain three-view/expression sheets only when the user is intentionally building a recurring IP or explicitly requests them.
- For series work, follow [references/series-assets.md](references/series-assets.md).

### 5. Plan pages and panels from content

Write `comic-plan.json`.

Identify irreducible story changes, merge repetition, then group them into the fewest readable 3:4 pages. Design each page's panels around its dramatic purpose. Set `pageCount = pages.length` and each `panelCount = panels.length`.

- With `layout.countMode: auto`, derive the total panel count from content.
- With `layout.countMode: user-fixed`, honor `layout.totalPanelCount` exactly and distribute those panels across pages. Treat `preferredPanelsPerPage` as a preference unless the user explicitly makes it a hard limit.

Choose `compositionFreedom`:

- `model-arranged` is the default: lock ordered story beats, characters, emotional purpose, required text, and exclusions; allow the image model to choose panel sizes, shots, staging, and transitions.
- `director-locked` is for exact layouts, reference replication, accessibility constraints, or a diagnosed composition failure. Specify shots and positions only where necessary.

Do not over-direct visual details that the model can solve creatively.

### 6. Choose the consistency route

1. `reference-parallel`: attach the same approved identity/style references to every page and generate concurrently.
2. `anchor-first-fanout`: with recurring characters but no reference, generate Page 1 as a final comic page, then attach it to every later page request and generate those concurrently.
3. `local-identity-lock`: apply the same approved local checkpoint/adapters/LoRAs/settings.
4. `style-lock-parallel`: use only when recurring identity is irrelevant.

One batch does not guarantee consistency. Shared references or equivalent identity controls do.

Before choosing any route that can spend money, run the image capability preflight from [references/run-contract.md](references/run-contract.md). It must prove that the requested 3:4 size mapping is itself 3:4, that every required `generation`/`edit` operation is documented or runtime-verified, and that product quality labels map to valid provider values. A host tool with no executable size parameter is `unsupported` even if it happened to return 3:4 in an earlier run.

### 7. Compile and audit one prompt per final page

Create `prompts/01.md` through `prompts/NN.md` using [references/prompt-contract.md](references/prompt-contract.md).

Every prompt must request one complete publishable comic page, carry the unchanged character/style lock, contain the page's ordered beats and required content text, state reference roles, and forbid naked-illustration substitution.

`requiredText` is not an exhaustive whitelist of every visible mark in the artwork. Do not reject harmless panel numbers, clock digits, or incidental environmental marks unless they materially damage user intent, source fidelity, safety, branding, or readability. Do not invent dialogue, narration, factual claims, logos, or watermarks.

Audit prompt vs contract before generation. A missing or contradictory instruction is a `prompt` fault, not model drift.

### 8. Generate provider pages and finish the selected text strategy

Generate one model output per distinct page. With `native`, it is the final file under `images/`. With `post-layout`, it is an immutable unlettered base under `source-images/`; deterministic code then produces the final file under `images/`.

- Use the same model version, quality, lock, reference policy, and backend size controls.
- Run the route capability preflight once for the complete plan before the first image request. Fail closed when size control is missing/unknown, the 3:4 mapping is wrong, or a later reference-based page would require an unsupported edit operation.
- By default, request a portrait `3:4` output directly and accept the backend's native pixel dimensions. Do not invent a fixed pixel size.
- Only when the user explicitly supplies an exact pixel size, copy it to `input.output.exactSize` and pass it through the backend's real size parameter. If the selected backend cannot control exact pixels, report that limitation before generation instead of pretending prompt wording can guarantee it.
- Record every generated page's actual width and height. Native uses `result.actualDimensions`. Post-layout first uses `result.sourceActualDimensions`, then records both source and final dimensions after composition. Never crop, resize, pad, or stitch a different image to manufacture compliance.
- Inspect each direct page's dimensions immediately after the provider returns it. If it is not the requested aspect/explicit exact size, preserve the file and evidence, mark generation failed, and do not request later pages.
- Preserve order as `01.png`, `02.png`, and so on.
- Do not create hidden variants or low-resolution drafts unless requested.
- Retry only calls that returned no usable image.
- Record real usage when exposed; concurrency reduces waiting, not per-page image cost.
- For `native` Chinese, render and evaluate the required copy exactly.
- For `post-layout`, require `director-locked` geometry and one normalized `textPlacements` box per required string. Preflight the configured compositor, pinned bundled font, glyph coverage, and box geometry before the first paid image call. Do not send literal Chinese copy to the image model; request quiet reserved regions and render the approved text locally afterward.
- Preserve provider bases as `source-images/NN.png` with their direct-output generation sidecars, compile `lettering-plan.json` deterministically, and record the completed work in `lettering-report.json`. Before composition, bind every source to the planned page, output path, provider operation, call ID, measured dimensions, and SHA-256 sidecar evidence; revalidate that provenance on completed runs. The final canvas must equal the source canvas and a raw RGBA audit must prove that every changed pixel is inside a declared text box.
- If composition fails, preserve the source images and use `--resume --stage compose` after fixing the local cause; this must make zero new image-provider calls. If no compositor is configured, stop before image generation rather than spending money on an output that cannot be finished.

### 9. Evaluate, then diagnose

Inspect all pages and write `eval-report.json` with fixed gates and scores from [references/eval-contract.md](references/eval-contract.md). Then write `diagnosis.json` by comparing:

```text
user intent → contract → compiled prompt → output → eval finding
```

Assign issues to `contract`, `prompt`, `model-execution`, `evaluator`, or `runtime`. Never weaken Eval to make output pass. Eval and diagnosis are read-only and never authorize an additional paid generation.

For `series-continuation`, compare every new page against the approved external series anchor, even when the new episode has only one page.

### 10. Package for publishing

Write `copywriting.json` after the story is stable. Include five titles, one publishable summary, three pull quotes, ten platform-appropriate tags, three series/column names, and a natural CTA. Keep claims aligned with the comic and avoid exaggerated promises.

## Return truthful artifacts

Always produce:

```text
<run-dir>/
├── input.json
├── topic-angles.json
├── story.json
├── character-bible.json
├── comic-plan.json
├── visual-lock.json
├── prompts/
├── source-images/          # post-layout only: direct provider bases
├── images/
├── lettering-plan.json     # post-layout only
├── lettering-report.json   # post-layout only after compose
├── copywriting.json
├── eval-report.json
├── diagnosis.json
├── result.json
├── usage.json
└── debug.json
```

Use `planned`, `generated-unlettered`, `generated`, `reviewed`, `needs-review`, and `failed` truthfully. `generated-unlettered` is post-layout only and must not expose final pages. `reviewed` requires the full content package, all final pages, strategy-aware `outputIntegrity`, a passing Eval, and no material diagnosis issue.

## Preserve boundaries

Save cost with minimal content-derived counts, direct output, useful references, and no disposable assets or hidden redraws. Keep billing, credit mutation, storage upload, and product-action routing in the host runtime, not inside this Skill.
