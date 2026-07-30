# Editorial safety

Apply these rules when the comic teaches, advises, diagnoses, or claims facts.

## Source boundary

- Preserve user-provided facts as provided but distinguish facts, opinions, and metaphors.
- Verify time-sensitive or high-stakes claims with reliable sources when the task requires factual publication.
- Mark unverified claims as `待核实`; do not convert them into confident dialogue.
- Do not invent studies, statistics, experts, quotations, or citations for dramatic effect.

## Psychology and parenting

- Avoid diagnosing a person from one behavior.
- Avoid universal claims such as “孩子拖延就是因为父母催促”. Prefer “频繁催促有时会让孩子更慌乱”.
- Avoid blame-only framing. Show context, needs, choices, and repair behavior.
- Separate educational content from individual treatment advice.
- Require human professional review when the comic offers clinical guidance or discusses self-harm, abuse, trauma, medication, or mental disorders.

## Medical, legal, and financial topics

- Treat the comic as general education, not personalized professional advice.
- Verify current rules and evidence before publication.
- Include an appropriate limitation note in the publishing copy when needed; do not hide it in tiny artwork text.

## Sensitive scenarios

- Do not turn violence, humiliation, discrimination, or a child's distress into a visual joke.
- Avoid identifiable real-person likeness without authorization.
- Avoid exposing private names, messages, addresses, account identifiers, or screenshots in generated prompts and images.

Record every unresolved editorial risk in `eval-report.json` under `editorialRisks`, and set `humanReviewRequired` to `true` when specialist judgment is necessary. Editorial review is read-only and does not authorize another image-generation call.
