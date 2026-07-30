# Run contract

Use schema version 3 for the complete topic-to-publishing workflow.

## Contents

- Required file tree
- `input.json`
- Content artifacts
- `comic-plan.json`
- `visual-lock.json`
- Result and runtime artifacts

## Required file tree

```text
<run-dir>/
├── input.json
├── topic-angles.json
├── story.json
├── character-bible.json
├── comic-plan.json
├── visual-lock.json
├── prompts/
│   ├── 01.md
│   └── NN.md
├── source-images/                 # post-layout only: immutable provider outputs
│   ├── 01.png
│   └── NN.png
├── images/
│   ├── 01.png
│   └── NN.png
├── lettering-plan.json            # post-layout only: deterministic compilation
├── lettering-report.json          # post-layout only: compositor provenance/audit
├── copywriting.json
├── eval-report.json
├── diagnosis.json
├── result.json
├── usage.json
└── debug.json
```

`series-plan.json` is optional and appears only when serialized planning is requested.

## `input.json`

```json
{
  "version": 3,
  "mode": "topic-to-comic",
  "source": {"topic": "为什么孩子越催越慢", "story": null, "draft": null},
  "domain": "育儿心理学",
  "audience": "年轻父母",
  "coreMessage": "频繁催促有时会让孩子更慌乱",
  "tone": "温暖、认知反转、轻科普",
  "platform": "小红书",
  "language": "zh-CN",
  "ctaGoal": "收藏与讨论",
  "visual": {
    "styleMode": "preset",
    "preset": "warm-japanese-educational-manga",
    "customStyle": null,
    "referenceImages": []
  },
  "layout": {"countMode": "auto", "totalPanelCount": null, "preferredPanelsPerPage": null},
  "output": {"aspectRatio": "3:4", "textStrategy": "native", "quality": "final", "pageCountCeiling": null},
  "series": {"enabled": false, "characterAnchorFiles": [], "styleAnchorFiles": []}
}
```

Reference arrays accept either path strings or role-bearing objects from [series-assets.md](series-assets.md). For series work, `series.continuityAnchorFile` may point to one of those already supplied assets. It is optional and never causes the system to create a new image.

`mode` is `topic-to-comic`, `story-to-comic`, or `series-continuation`.

`visual.styleMode` is `preset`, `custom`, or `reference`:

- `preset` requires a valid `visual.preset` from [style-presets.json](style-presets.json). The preset's complete lock must be copied to `visual-lock.json`.
- `custom` requires a non-empty `visual.customStyle`; compile it into the same complete lock fields.
- `reference` requires at least one `visual.referenceImages` entry and explicit reference roles.

`layout.countMode` is `auto` or `user-fixed`. `user-fixed` requires a positive `totalPanelCount`; `auto` derives counts from content. `preferredPanelsPerPage` is optional and does not become a hard cap unless the user says so.

`output.aspectRatio` is the normal user-facing size requirement. Do not add a pixel size by default. If and only if the user explicitly requests exact pixels, add:

```json
"exactSize": {"width": 1080, "height": 1440}
```

Pass an explicit `exactSize` through the image backend's execution parameter. Prompt text alone is not proof that exact pixels can be delivered.

## Content artifacts

Follow [content-contract.md](content-contract.md) for `topic-angles.json`, `story.json`, `character-bible.json`, and `copywriting.json`.

## `comic-plan.json`

```json
{
  "version": 3,
  "title": "为什么孩子越催越慢",
  "coreMessage": "频繁催促有时会让孩子更慌乱，清楚的小步骤更有助于行动。",
  "compositionFreedom": "model-arranged",
  "compositionReason": "故事与文字被锁定，允许模型自由安排镜头和格子以获得自然漫画节奏。",
  "pageCount": 3,
  "countReason": "冲突、理解、解决是三个不可合并的页面功能。",
  "aspectRatio": "3:4",
  "quality": "final",
  "textStrategy": "native",
  "generationStrategy": "anchor-first-fanout",
  "pages": [
    {
      "id": "page-01",
      "purpose": "建立冲突并升级",
      "change": "连续催促让孩子更加慌乱",
      "scene": "清晨玄关",
      "panelCount": 3,
      "panels": [
        {
          "id": "page-01-panel-01",
          "change": "妈妈第一次催促",
          "action": "妈妈看表，孩子开始穿鞋",
          "emotion": "焦急",
          "dialogue": ["快点！要迟到了！"],
          "direction": null
        }
      ],
      "requiredText": ["快点！要迟到了！"],
      "textPlacements": [
        {
          "id": "page-01-title-01",
          "requiredTextIndex": 0,
          "text": "快点！要迟到了！",
          "panelId": "page-01-panel-01",
          "kind": "speech",
          "tail": "left",
          "box": {"x": 70, "y": 70, "width": 360, "height": 170}
        }
      ],
      "promptFile": "prompts/01.md",
      "outputFile": "images/01.png"
    }
  ]
}
```

Rules:

- `pageCount = pages.length` and each `panelCount = panels.length`.
- Counts follow content, not a default.
- `compositionFreedom` is `model-arranged` or `director-locked`.
- A `model-arranged` panel may leave `direction` null; its change/action/emotion/text remain locked.
- A `director-locked` plan requires a non-empty direction for each panel and a concrete reason.
- The sum of all `panelCount` values must equal `input.layout.totalPanelCount` when count mode is `user-fixed`.
- `requiredText` contains the title/dialogue/narration that must render accurately. It is not a whitelist of every visible environmental mark.
- For `textStrategy: native`, omit `textPlacements` and let the image provider render the required copy.
- For `textStrategy: post-layout`, `compositionFreedom` must be `director-locked`. Every required string must have exactly one `textPlacements` entry with the same exact text and index, a valid panel assignment, a unique ID, a `title|speech|thought|caption` kind, a `none|left|right` tail, and a non-overlapping integer box normalized to a 0..1000 page. The planner must keep faces, bodies, props, borders, and important details outside those boxes.
- Every page has one unique prompt and direct 3:4 output.
- Omit `exactSize` unless it came from `input.output.exactSize`. Never create an exact pixel requirement inside the plan.
- `generationStrategy` is `reference-parallel`, `anchor-first-fanout`, `local-identity-lock`, or `style-lock-parallel`.

## `visual-lock.json`

```json
{
  "version": 3,
  "lockId": "comic-visual-lock-v3",
  "sourceCharacterBible": "character-bible.json",
  "style": {
    "presetId": "warm-japanese-educational-manga",
    "medium": "warm Japanese educational manga with light watercolor texture",
    "line": "clean dark-brown ink with gentle organic variation",
    "palette": ["cream", "sage green", "soft mustard", "dusty rose", "warm brown"],
    "lighting": "soft natural daylight",
    "background": "lived-in but simplified domestic or everyday spaces on cream paper",
    "pageGrammar": "clean borders, rounded bubbles, calm spacing and varied but easy-to-follow panel sizes",
    "characterDesign": "soft rounded proportions, expressive eyes, restrained chibi exaggeration and stable everyday outfits",
    "typography": "clean friendly Simplified Chinese lettering with concise dialogue",
    "avoid": ["photorealism", "neon lighting", "heavy black shadows", "hyper-detailed backgrounds", "extreme chibi deformation"]
  },
  "characters": [],
  "output": {"aspectRatio": "3:4", "textStrategy": "native"},
  "referenceImages": []
}
```

Character IDs and immutable fields must agree with `character-bible.json`.

For preset mode, every style field in `visual-lock.json` must match the selected catalog preset. This is what makes a preset executable rather than a loose keyword.

## Result and runtime artifacts

```json
{
  "version": 3,
  "status": "reviewed",
  "pageCount": 3,
  "aspectRatio": "3:4",
  "pages": ["images/01.png", "images/02.png", "images/03.png"],
  "actualDimensions": [
    {"file": "images/01.png", "width": 1085, "height": 1449},
    {"file": "images/02.png", "width": 1086, "height": 1449},
    {"file": "images/03.png", "width": 1085, "height": 1449}
  ],
  "contentPackage": {
    "story": "story.json",
    "characters": "character-bible.json",
    "copywriting": "copywriting.json"
  }
}
```

Use version 3 for `result.json`, `usage.json`, `debug.json`, `eval-report.json`, and `diagnosis.json`. `reviewed` requires a complete content package, all direct pages, passing Eval, and no material diagnosis issue.

For `post-layout`, the provider's direct base pages live under `source-images/`. After generation, `result.status` is `generated-unlettered` and records `sourcePages` plus `sourceActualDimensions`; it must not expose final `pages` yet. The deterministic compositor then writes the publishable files under `images/` without resizing the canvas and records both source and final provenance in `lettering-report.json`. A successfully composited run returns to `generated` and records `sourcePages`, `sourceActualDimensions`, `pages`, `actualDimensions`, `letteringPlan`, and `letteringReport`.

`actualDimensions` records file metadata after generation; it does not create a new user requirement. When `input.output.exactSize` exists, also copy that object to `comic-plan.exactSize`, `visual-lock.output.exactSize`, and `result.exactSize`, then verify every generated file matches it exactly.

For the normal aspect-only route, deterministic validation accepts a direct portrait 3:4 provider output with at most one pixel of integer rounding on either edge. This handles native model canvases without turning a backend's incidental pixel count into a user contract, while still rejecting square, landscape, or materially wrong ratios.

## Lifecycle artifact requirements

- `failed`: require only valid `input.json`, `result.json`, `usage.json`, and `debug.json`; preserve any completed artifacts but never fabricate placeholders. `result.json` must include a non-empty `stage` and `error`. If a provider returned a usable but noncompliant direct image, the failed result may retain `pages` and measured `actualDimensions`, and an optional Eval/Diagnosis may record the failed gate. Preserving evidence does not turn the output into a deliverable.
- `planned`: require the complete content package, plan, visual lock, and prompts; images and Eval are not yet required.
- `generated-unlettered`: post-layout only; require every direct provider base PNG under `source-images/`, measured source dimensions, and `lettering-plan.json`; final `images/`, Eval, and `lettering-report.json` are not yet allowed.
- `generated`: additionally require every planned PNG and `result.actualDimensions`.
- `reviewed` or `needs-review`: additionally require `eval-report.json` and `diagnosis.json`.

This lifecycle lets an executor record an early provider or planning failure truthfully instead of leaving an invalid or fake-complete run directory.

Record actual usage only. New runs use `usage.status: complete|partial|unavailable|not_applicable`:

- `complete`: every successful provider call recorded positive real usage;
- `partial`: at least one successful provider call has usage and at least one does not; never settle this run;
- `unavailable`: successful provider calls completed but none exposed positive usage; do not invent tokens or charge;
- `not_applicable`: no billable provider call completed, such as a local compose-only artifact set.

Every planner, page generation/edit, and evaluator call has a stable `callId`, role, stage, operation, provider/model/pricing key, status, metering status, input/output hashes, timestamps, request ID when exposed, and raw provider usage when available. Write a `started/pending` intent before the request, then update the same `callId` after completion so a crashed process leaves an explicit ambiguous receipt rather than silently retrying. A resume may reuse a fully evidenced page, but must not automatically repeat a `started` call whose provider outcome is unknown. Local post-layout compose records `meteringStatus: not_applicable`; it is not a fake zero-token model call.

Parallel image calls must serialize only their `usage.json` read-modify-write commits. This preserves image concurrency while preventing one completed page receipt from overwriting another; incomplete usage must still fail closed before upload or settlement.

## Deterministic post-layout compositor

`post-layout` is a two-artifact strategy, not permission to crop, resize, pad, or rebuild a page:

1. the image provider returns one complete, unlettered comic base per page under `source-images/` at the requested native canvas;
2. before any final page is written, deterministic code verifies the source against its direct-output sidecar: planned page and paths, generation/edit operation, stable call ID, measured dimensions, and SHA-256 hash must all agree;
3. deterministic code draws only the approved bubbles/captions and exact strings inside the declared normalized boxes;
4. the final PNG under `images/` must retain the source width and height exactly;
5. a raw RGBA pixel audit must prove that every changed pixel is inside a declared text box and that pixels and alpha outside those boxes are unchanged.

`lettering-plan.json` is compiled deterministically from `comic-plan.json`; it is not free-form model output. `lettering-report.json` records the compositor engine, pinned font hash, generation-sidecar provenance, source/output hashes and dimensions, exact text-to-panel assignments, and the pixel audit. The final validator rechecks the recorded provenance against the current sidecar and source bytes, so later tampering cannot remain publishable. Overflow, missing glyphs, stale plans, source/sidecar mismatch, font tampering, overlapping boxes, or a missing compositor fail before publishing. A compose failure preserves the paid source images so `--resume --stage compose` can retry locally with zero new image-provider calls.

The bundled route is `references/routes/bundled-sharp-post-layout.json`. It uses `sharp-svg-v1` plus the pinned `NotoSansCJKsc-Regular.otf` asset and its SIL Open Font License 1.1 file. Do not fall back silently to a machine's system font.

## Automatic executor and provider routes

Run `scripts/run.mjs` with explicit route JSON files. A route is resolved by the host or operator; it is not a credential container.

Planner and evaluator route:

```json
{
  "capability": "text",
  "baseURL": "https://provider.example/v1",
  "apiKeyEnv": "PROVIDER_API_KEY",
  "model": "planner-model-id",
  "provider": "provider-name",
  "adapter": "openai-compatible",
  "pricingModel": "provider-pricing-id"
}
```

Use `capability: "vision"` for the evaluator. Image route:

```json
{
  "capability": "image",
  "baseURL": "https://provider.example/v1",
  "apiKeyEnv": "PROVIDER_API_KEY",
  "model": "image-model-id",
  "provider": "provider-name",
  "adapter": "openai-compatible",
  "pricingModel": "provider-pricing-id",
  "dimensionControl": {
    "status": "supported",
    "mechanism": "size",
    "guarantee": "exact",
    "operations": ["generation", "edit"],
    "evidence": {
      "level": "documented",
      "source": "provider documentation URL"
    }
  },
  "aspectRatioSizes": {"3:4": "768x1024"},
  "supportedSizes": ["768x1024"],
  "exactOutputSizes": ["768x1024"],
  "qualityMap": {"draft": "low", "standard": "medium", "final": "high"},
  "supportsReferences": true
}
```

`aspectRatioSizes` is a provider capability mapping, not a user pixel contract. It tells the adapter which provider-native size parameter produces the requested aspect ratio. The actual PNG width and height still come from the provider output and are recorded in `result.actualDimensions`.

Before the first paid image call, the executor runs a route preflight that:

- rejects `dimensionControl.status` values other than `supported`;
- verifies the mapped size is actually the requested aspect ratio;
- derives whether this run needs `generation`, `edit`, or both and checks every operation;
- treats `supportedSizes` only as requestable API values;
- treats `exactOutputSizes` as the separate list of pixel sizes the route is allowed to promise exactly;
- records a credential-free request preview and the product-quality-to-provider-quality mapping in `debug.json`.

`evidence.level: documented` proves that current provider documentation declares the capability. It does not prove that a particular live request complied. After generation, the executor still reads the returned PNG and enforces the measured dimensions. A successful live provider test may upgrade the evidence to `runtime-verified`; it must remain tied to the same provider, model, adapter, operation, and requested size.

If the user explicitly supplies `input.output.exactSize`, that exact `WIDTHxHEIGHT` must appear in both `supportedSizes` and `exactOutputSizes`; otherwise generation fails before the first image call. Inline `apiKey` or authorization values are forbidden.

Two concrete descriptors live under `references/routes/`:

- `zenmux-gpt-image-2-3x4.json`: documented OpenAI-compatible `generation` + `edit`, direct `1152x1536`, reference inputs, and `final → high` quality mapping. It still needs one authorized live run before being called runtime-verified.
- `codex-builtin-imagegen-uncontrolled.json`: explicitly `unsupported` for strict 3:4 because the host tool exposes no executable size parameter. Historical lucky 3:4 outputs do not change that capability decision.

Lifecycle behavior:

- Planning or generation errors use `result.status: failed` with the true `stage` and `error`.
- Missing evaluator authorization/route, evaluator provider failure, or invalid evaluator JSON preserves the valid generated pages and leaves `result.status: generated`; `debug.json` records evaluation as blocked.
- A complete passing visual evaluation becomes `reviewed`.
- A completed but failing evaluation becomes `needs-review`; it never triggers automatic paid repair.

The executor accepts `--stage plan|generate|compose|evaluate|all`. Supply `--compositor-route-json` for every post-layout generation or compose run. Post-layout generation preflights the compositor before the first image request, so a missing engine/font/route cannot spend image credits and then discover that the page cannot be finished.
