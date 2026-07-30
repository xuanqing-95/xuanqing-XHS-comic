# Page prompt contract

Compile one prompt for one provider-generated comic page. With `native` text it is the final page. With `post-layout` it is the immutable unlettered base that will receive deterministic lettering without changing its canvas or any pixels outside declared text regions. Keep the visual-lock block semantically identical across the series; change only page content. Use `compositionFreedom` to decide how much visual direction belongs in the prompt.

## Contents

- Required structure
- Composition freedom
- Prompt audit
- Route-specific rules
- Chinese text

## Required structure

```text
TASK
Create exactly one complete social-comic PAGE for page {{page_id}}.
This is a final publishable page, not an illustration or storyboard asset.

OUTPUT
- Target aspect ratio: portrait 3:4
- {{only when the user explicitly supplied exactSize: Exact execution size: width x height}}
- One standalone page image
- {{panel_count}} visible comic panels inside the page
- Clear borders and reading order
- Native: dialogue bubbles/captions already rendered with the exact required copy
- Post-layout: visually quiet reserved regions only; no words, placeholder copy, or slot IDs rendered by the image model
- No contact sheet, crop marks, watermark, character sheet, or unlettered single-scene substitute

VISUAL LOCK — DO NOT CHANGE
- Lock ID: {{lock_id}}
- Preset ID: {{preset_id OR custom/reference}}
- Medium: {{medium}}
- Line treatment: {{line}}
- Palette: {{palette}}
- Lighting: {{lighting}}
- Paper/background treatment: {{background}}
- Bubble and border language: {{page_grammar}}
- Character design language: {{character_design}}
- Typography character: {{typography}}
- Avoid: {{avoid}}

RECURRING CHARACTERS — DO NOT CHANGE
{{repeat every immutable character trait explicitly}}

CURRENT PAGE
- Story purpose: {{purpose}}
- Page-level change: {{change}}
- Setting continuity: {{scene}}
- Composition freedom: {{composition_freedom}}

ORDERED PANELS
Panel 1: {{required story change, action, emotion, plus exact native text OR post-layout slot IDs and grapheme counts}}
Panel 2: {{required story change, action, emotion, text}}
...

REQUIRED CONTENT TEXT
{{exact required native title/dialogue/narration OR post-layout normalized slot rectangles without literal copy}}

REFERENCE USE
{{identify every reference and which identity/style properties it controls}}

EXCLUSIONS
- No character redesign, wardrobe drift, or palette change
- No missing, merged, duplicated, or extra panel
- No extra people, limbs, invented dialogue, invented narration, factual claims, logos, or watermarks
- No single full-page illustration in place of the planned comic panels
```

## Composition freedom

### `model-arranged` — default

Specify the ordered semantic beats, required characters, emotional changes, exact text, and exclusions. Explicitly allow the image model to choose:

- panel sizes and emphasis;
- camera distance and angle;
- staging and character positions;
- visual transitions and reaction shots;
- decorative motion symbols and background simplification.

Do not prescribe a camera or coordinate for every panel. The purpose is to give GPT-image a strong story and aesthetic lock while preserving visual-directing freedom.

### `director-locked`

Specify exact panel geometry, shots, positions, and transitions only when the user requests strict direction, a reference layout must be reproduced, accessibility requires it, or Eval/Diagnosis has identified a composition problem. Record that reason in `comic-plan.json`.

## Prompt audit

Before generation, audit the compiled prompt against `comic-plan.json` and `visual-lock.json`:

- the prompt asks for a complete comic page;
- page and panel counts match the plan;
- composition freedom and its level of detail match the plan;
- native: all required title, dialogue, and narration is present and assigned to the correct panel/speaker; post-layout: every deterministic slot is present with the correct panel/box metadata and no literal copy leaks into the image prompt;
- no instruction forbids required panels, borders, bubbles, or text;
- immutable character and style traits are present;
- every selected preset field is carried into the prompt, not just the preset name;
- reference roles are explicit;
- the output ratio matches the plan;
- an exact pixel size appears only when it came from `input.output.exactSize` and the selected backend exposes a real size control.

Record omissions or contradictions as `prompt` faults. Do not wait for the image output to discover a deterministic prompt mismatch.

The image prompt communicates composition and aspect intent. The execution adapter controls pixels. Do not insert a guessed width/height into the prompt, plan, or lock. If exact pixels were explicitly requested but the backend has no exact-size parameter, stop before generation and report the runtime limitation.

## Route-specific rules

### `reference-parallel`

Attach the same approved reference set to every prompt. State which reference controls identity, page grammar, and style.

### `anchor-first-fanout`

Generate Page 1 as a final deliverable. Attach `images/01.png` to every later prompt and say:

```text
Preserve the recurring characters' identity, face, hair, body proportions,
wardrobe, signature colors, line treatment, palette, bubble style, borders,
and page grammar from the reference. Change only the current page's panels,
actions, expressions, camera, and story content.
```

Do not force later pages to copy the anchor's exact panel geometry or poses.

### `local-identity-lock`

Use the same approved model checkpoint, adapters/LoRAs, weights, sampler family, and resolution. Record non-secret identifiers in `debug.json`.

### `style-lock-parallel`

Use only when recurring identity is not required. Repeat the full style/page-grammar lock in every prompt.

## Chinese text

Use `native` when direct model lettering is part of the requested final comic. Put every required title, dialogue, and narration string in quotes and evaluate that required copy character-by-character.

The contract controls required content copy; it is not a whitelist for every mark in the image. Harmless panel numbers, clock digits, or incidental environmental marks do not fail the text gate by themselves. Extra text is material only when it invents dialogue/narration/factual claims, conflicts with user intent or source fidelity, introduces branding/safety problems, or harms readability. Use a stricter exact-visible-text rule only when the user explicitly requests it.

Use `post-layout` when exact typography is more important than native lettering and the deterministic compositor route has passed preflight. It is intentionally stricter than native generation:

- require `compositionFreedom: director-locked` and one normalized `textPlacements` box for every `requiredText` item;
- do not send the literal Chinese copy to the image model; send only stable slot IDs, normalized boxes, panel ownership, kind/tail metadata, and grapheme counts;
- tell the image model not to draw words, placeholder strings, or slot IDs, and to keep every reserved rectangle clear of faces, bodies, props, borders, and important detail;
- write the provider result to `source-images/NN.png` and treat it as immutable;
- let deterministic code draw the final bubble/caption and exact approved copy into `images/NN.png`, preserving canvas dimensions and all pixels outside the declared regions.

This separation prevents the image model from producing almost-correct Chinese underneath or alongside the deterministic text. A missing compositor, unavailable bundled font, insufficient text box, unsupported glyph, or overlapping placement is a hard pre-generation/compose failure—not a reason to loosen the text contract or claim a finished page.
