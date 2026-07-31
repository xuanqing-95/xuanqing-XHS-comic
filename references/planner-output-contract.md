# Planner output contract

The planner returns narrative and visual decisions only. A deterministic compiler turns those decisions into page prompts. This boundary prevents prompt wording from drifting between runs and keeps prompt faults distinguishable from planning faults.

## Top-level JSON shape

Return one JSON object with exactly these six keys and no others:

```json
{
  "topicAngles": {},
  "story": {},
  "characterBible": {},
  "comicPlan": {},
  "visualLock": {},
  "copywriting": {}
}
```

Each value is the content of the corresponding version-3 run artifact:

| Planner key | Run artifact |
| --- | --- |
| `topicAngles` | `topic-angles.json` |
| `story` | `story.json` |
| `characterBible` | `character-bible.json` |
| `comicPlan` | `comic-plan.json` |
| `visualLock` | `visual-lock.json` |
| `copywriting` | `copywriting.json` |

Follow [content-contract.md](content-contract.md) and [run-contract.md](run-contract.md) for the complete artifact fields. Use `null` or an empty array only where those contracts permit it; do not fabricate placeholders.

## Model responsibilities

The planner must:

- preserve the user's topic, story, audience, core message, tone, platform, count choice, style choice, and series anchors;
- generate or skip topic angles according to the selected mode;
- write or preserve the complete story;
- create a reproducible character bible;
- derive page and panel counts from content unless the user fixed the total;
- choose `model-arranged` or `director-locked` composition honestly;
- build a complete visual lock;
- write publishing copy aligned with the actual comic.

The planner must not return `prompts`, `images`, `eval`, `evalReport`, `diagnosis`, `result`, `usage`, `debug`, backend requests, or executable tool instructions. It must not embed a page prompt inside any of the six artifacts. `comicPlan.pages[*].promptFile` is only the destination path; prompt text comes exclusively from `scripts/compile-prompts.mjs`.

## Mode rules

### `topic-to-comic`

- Set `topicAngles.status` to `generated`.
- Return exactly three meaningfully different angles and select one of their IDs.
- Set `story.sourceMode` to `generated`.
- Treat `story.sourceFaithfulness` as input provenance, not a creative field. The runtime compiles it deterministically from the validated topic and core message so a complete otherwise-valid plan cannot fail because the model omitted this metadata.
- Treat artifact versions, output ratio/quality/text strategy, page and panel counts, canonical file paths, visual-lock output fields, copywriting platform, and a missing CTA fallback as runtime-owned structure. The planner may author a better CTA, but omission must not invalidate an otherwise complete plan.
- In native-text mode, the runtime merges every panel dialogue and narration string into that page's `requiredText` array while preserving additional page-level title/caption strings. Do not make the planner maintain two independently fallible copies of the same text.

### `story-to-comic`

- Preserve the supplied story.
- Set `topicAngles.status` to `skipped`, return no angles, and explain the skip.
- Set `story.sourceMode` to `user-supplied` and explain any clarity or pacing edits in `sourceFaithfulness`.

### `series-continuation`

- Reuse the approved recurring character and style anchors.
- When `input.source.story` is present, follow the `story-to-comic` angle and story rules.
- Otherwise, follow the `topic-to-comic` angle and story rules for the new episode.
- Set `characterBible.seriesMode` to `true`.
- Keep reference paths and their roles explicit so the prompt compiler can state what controls identity, style, or page grammar.

## Layout and composition rules

- `comicPlan.pageCount` must equal `comicPlan.pages.length`.
- Every page's `panelCount` must equal its `panels.length`.
- With `input.layout.countMode: auto`, determine counts from the irreducible story changes; do not use a default number.
- With `input.layout.countMode: user-fixed`, the total number of planned panels must exactly equal `input.layout.totalPanelCount`.
- Use `compositionFreedom: model-arranged` by default. Lock semantic beats, actions, emotions, required copy, and exclusions while leaving panel geometry, camera, staging, and transitions to the image model.
- Use `compositionFreedom: director-locked` only for a concrete recorded reason. Give every panel a non-empty `direction`.
- Request one complete comic page per `comicPlan.pages` entry. Native text asks the provider for the final page; post-layout asks for the same complete page composition with declared text regions reserved for deterministic lettering. Never plan naked illustrations, crops, stitched panels, contact sheets, or hidden variants as page outputs.

For `input.output.textStrategy: post-layout`, deterministic lettering requires a stricter spatial contract:

- use `compositionFreedom: director-locked` for the entire plan;
- add `textPlacements` to every page with exactly one item for every `requiredText` index;
- each item must contain a unique `id`, `requiredTextIndex`, exact `text`, valid `panelId`, `kind` (`title`, `speech`, `thought`, or `caption`), `tail` (`none`, `left`, or `right`), and a non-overlapping integer `box` normalized to a 0..1000 page;
- each box must remain inside the page and be large enough for deterministic wrapping; panel directions must reserve it from faces, bodies, props, panel borders, and important detail;
- never combine `post-layout` with `model-arranged`, because a compositor cannot safely place exact text into geometry the plan did not lock.

For `native`, omit `textPlacements`.

## Style modes

Every `visualLock.style` must contain all of these fields:

```json
{
  "presetId": "preset-id, custom, or reference",
  "medium": "...",
  "line": "...",
  "palette": ["..."],
  "lighting": "...",
  "background": "...",
  "pageGrammar": "...",
  "characterDesign": "...",
  "typography": "...",
  "avoid": ["..."]
}
```

- `preset`: `presetId` and every lock field must exactly match the selected entry in [style-presets.json](style-presets.json). Do not paraphrase a preset.
- `custom`: set `presetId` to `custom` and compile the user's description into every lock field without silently replacing it with a catalog preset.
- `reference`: set `presetId` to `reference`, derive every lock field from the supplied references, and give every reference an explicit role such as `identity`, `style`, or `page-grammar`.

Every `visualLock.characters[*].id` and `immutable` object must exactly match the corresponding entry in `characterBible.characters`. Do not weaken or summarize immutable traits in the lock.

## Text, references, and size

- Put every required title, dialogue, and narration string in `comicPlan.pages[*].requiredText`. With post-layout, copy the same exact strings into the corresponding `textPlacements` entries; the deterministic compiler, not the planner or evaluator, proves equality.
- `requiredText` is required copy, not a whitelist of every harmless mark in the artwork.
- Preserve reference paths. Prefer `{ "file": "...", "roles": ["identity", "style"] }` when one file has explicit roles. A series character anchor controls identity; a series style anchor controls style and page grammar.
- Default to `aspectRatio: "3:4"`. Do not invent pixel dimensions.
- Only when `input.output.exactSize` exists, copy that exact object to `comicPlan.exactSize` and `visualLock.output.exactSize`. The execution adapter, not prompt wording alone, must enforce it.

Before accepting planner output, call:

```js
validatePlannerPackage(pkg, input, styleCatalog)
```

Reject the package when the returned error array is non-empty. Then call `compilePagePrompts(...)`; do not ask the planner to repair or rewrite deterministic prompt formatting.
