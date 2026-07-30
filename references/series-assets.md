# Series and IP assets

Use this contract only for recurring characters, columns, or intentionally serialized comics.

## Reuse priority

Use the strongest available evidence in this order:

1. user-supplied three-view/expression sheet;
2. approved prior comic pages with stable identity;
3. approved character/style reference images;
4. Page 1 of the current episode as an anchor;
5. text-only immutable traits when no image reference exists.

Do not generate a character sheet merely to make a one-off post. A sheet is a separate deliverable and separate image cost.

## Character anchor

Maintain for each recurring character:

- immutable face, hair, age, body proportion, outfit silhouette, signature colors, and props;
- allowed expression/pose range;
- forbidden redesigns;
- front/side/back references when available;
- approved prior pages and version/date.

Reference entries may remain plain path strings for backward compatibility. When one image has a specific responsibility, use an object:

```json
{
  "file": "/absolute/path/phone-charger-identity-board.png",
  "roles": ["identity"],
  "assetType": "three-view",
  "characterIds": ["char-phone", "char-charger"],
  "views": ["front", "side", "back", "expression"]
}
```

In a hosted product, the browser should never construct that internal object or submit a server-local path. It sends only a host-owned asset selection, for example:

```json
{
  "series": {
    "referenceAssets": [
      { "assetId": "host-owned-image-id", "roles": ["identity", "style"] }
    ],
    "continuityAnchorAssetId": "host-owned-image-id"
  }
}
```

The host verifies asset ownership and parent-record authorization, selects the original asset when available, validates and bounds the raw image, and compiles a run-relative internal entry with immutable provenance. A series continuation must have at least one such external asset; an explicitly selected continuity anchor must be in the same selection.

Supported roles are `identity`, `style`, and `page-grammar`. Supported asset types are `reference`, `character-reference`, `character-sheet`, `three-view`, `expression-sheet`, `approved-page`, and `style-reference`.

Do not require a three-view asset for every series. Only an entry that explicitly declares `assetType: three-view` must list `front`, `side`, and `back`. Expressions, poses, battery state, gestures, and cable curves remain variable unless the user explicitly locks them.

## Style anchor

Maintain:

- medium and rendering texture;
- line weight and color;
- palette;
- lighting;
- background density;
- panel borders, bubbles, typography character, and page margins;
- visual motifs and exclusions.

Style references control treatment, not story content or copied composition.

Use these responsibilities separately when possible:

- a user example usually controls `style` and `page-grammar`, not its characters, story, text, or panel count;
- a character sheet or three-view board controls `identity`, not page layout;
- an approved prior page may control `identity`, `style`, and `page-grammar`, but never authorizes copying its dialogue, pose, plot, or exact panel geometry.

`scripts/reference-assets.mjs` preserves the first supplied attachment order, merges metadata for duplicate paths, and gives the prompt the same `Reference image N` numbering used by the generation adapter. Planner-derived artifacts may enrich metadata for an input reference, but cannot introduce a new external file path.

For a recurring series, `input.series.continuityAnchorFile` may select one of the already supplied references as the canonical cross-episode comparison anchor. It does not create or approve a new asset. Without this field, select in order: an `approved-page`, a series character anchor, a visual reference, then another identity reference.

For a `series-continuation` Eval, compare every new page against the selected external continuity anchor. Do not skip comparison merely because the new episode contains only one page, and do not require the new page to copy the anchor's text, poses, or panel geometry. Send other supplied references as supporting evidence, while keeping their declared roles distinct from the canonical continuity comparison.

## Ending hooks

Choose an ending function that serves the episode:

- insight;
- emotional release;
- visual reversal;
- practical action;
- gentle humor;
- open question.

Do not force every episode into a slogan. Record the selected ending function in `story.structure.endingHook`.

## Series planning

When the user requests a series, optionally write `series-plan.json` with:

- column name and promise;
- target audience;
- recurring cast;
- fixed style anchor;
- topic pillars;
- episode list;
- variation rules to avoid repetitive plots;
- publishing cadence and CTA pattern.

This file is optional for one-off runs and must not block validation when series planning was not requested.
