# Content-stage contract

Use these artifacts to turn a topic or ready-made story into a comic-ready narrative without losing the user's intent.

## Contents

- Route selection
- `topic-angles.json`
- `story.json`
- `character-bible.json`
- Story and dialogue quality
- `copywriting.json`

## 1. Route selection

### `topic-to-comic`

Use when the input is a topic, proposition, lesson, question, or loose idea. Produce three angles, select one, then write the story.

### `story-to-comic`

Use when the user already supplies a plot, scene sequence, or usable draft. Preserve the story and record why angle generation was skipped. Improve only clarity, pacing, dialogue length, and factual safety unless the user asks for a rewrite.

### `series-continuation`

Use when approved recurring characters, style references, or a column already exist. Reuse them and choose either topic or story handling for the episode.

## 2. `topic-angles.json`

```json
{
  "version": 3,
  "status": "generated",
  "angles": [
    {
      "id": "angle-01",
      "title": "越想让孩子快，越容易让他卡住",
      "audienceTension": "父母担心迟到，孩子面对多个同时指令",
      "conflict": "催促增加，行动反而更乱",
      "emotion": "焦急到理解",
      "turn": "孩子不是故意磨蹭，而是处理不过来",
      "comicFit": "能用重复催促、表情和动作失误形成可视化反差"
    }
  ],
  "selectedAngleId": "angle-01",
  "selectionReason": "冲突可视化且能自然承载核心观点",
  "skipReason": null
}
```

For `generated`, require exactly three genuinely different angles. For `skipped`, use an empty angle array, `selectedAngleId: null`, and a concrete reason.

## 3. `story.json`

```json
{
  "version": 3,
  "sourceMode": "generated",
  "title": "为什么孩子越催越慢",
  "logline": "一个忙乱的早晨，妈妈发现不断催促正在让孩子更难行动。",
  "coreMessage": "频繁催促有时会增加慌乱，清楚的小步骤更有助于行动。",
  "summary": "...",
  "structure": {
    "hook": "妈妈催促即将迟到",
    "escalation": "多个指令让孩子手忙脚乱",
    "turn": "妈妈停下并听见孩子的困难",
    "resolution": "妈妈改用单步指令",
    "endingHook": "指令越清楚，行动越从容"
  },
  "emotionalCurve": ["焦急", "慌乱", "理解", "放松"],
  "claims": [
    {"text": "频繁催促有时会增加孩子的慌乱", "status": "general-education", "verification": "editorial review"}
  ],
  "sourceFaithfulness": "User topic and core message preserved without diagnosis or universal claims."
}
```

Use `sourceMode: user-supplied` for preserved stories. Record meaningful changes in `sourceFaithfulness`.
For topic-led generated stories, the runtime compiles `sourceFaithfulness` from the validated topic and core message. Do not use that deterministic provenance field as a substitute for evaluating whether the generated story actually stayed faithful.
The runtime also supplies a platform- and `ctaGoal`-aligned CTA only when the planner omits `copywriting.cta`. This fallback repairs structure, not story meaning; all title, summary, quote, and tag quality gates remain unchanged.

## 4. `character-bible.json`

```json
{
  "version": 3,
  "seriesMode": false,
  "characters": [
    {
      "id": "char-mother",
      "role": "mother",
      "personality": ["caring", "easily anxious in a rush"],
      "immutable": {
        "age": "early 30s",
        "face": "soft oval face and brown almond eyes",
        "hair": "dark-brown chin-length side-parted bob",
        "body": "slim adult manga proportion",
        "outfit": "sage cardigan, cream shirt, brown trousers, cream slippers",
        "signatureColors": ["sage green", "cream", "brown"],
        "recurringProps": []
      },
      "expressionRange": ["anxious", "surprised", "thoughtful", "gentle"],
      "signatureActions": ["checks time", "crouches to eye level"],
      "forbiddenChanges": ["long hair", "different cardigan color", "photorealistic age shift"],
      "referenceImages": []
    }
  ],
  "relationships": [
    {"from": "char-mother", "to": "char-child", "type": "parent-child", "dynamic": "anxiety changes into listening"}
  ],
  "seriesAssets": {
    "characterSheetFiles": [],
    "styleAnchorFiles": [],
    "columnName": null
  }
}
```

`visual-lock.json` is the compiled visual subset of this bible. Character IDs and immutable traits must not contradict it.

## 5. Story and dialogue quality

- Build conflict, progression, turn, and resolution, but vary form and ending.
- Keep bubbles short enough to read on a phone.
- Give each speaker a natural voice.
- Prefer observable actions over abstract lectures.
- Do not invent studies, numbers, experts, or diagnoses.
- Preserve uncertainty in psychology and parenting claims.

## 6. `copywriting.json`

```json
{
  "version": 3,
  "platform": "小红书",
  "titleCandidates": ["...", "...", "...", "...", "..."],
  "summary": "一段可直接发布的简介",
  "pullQuotes": ["...", "...", "..."],
  "tags": ["..."],
  "seriesNames": ["...", "...", "..."],
  "cta": "你有没有经历过越催越乱的早晨？"
}
```

Require five titles, three pull quotes, ten tags, and three series names. Keep titles aligned with the actual comic; do not promise clinical or universal conclusions.
