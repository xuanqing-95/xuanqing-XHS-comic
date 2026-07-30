#!/usr/bin/env python3

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
skill_file = ROOT / "SKILL.md"
text = skill_file.read_text(encoding="utf-8")

match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
if not match:
    raise SystemExit("SKILL.md is missing YAML frontmatter")

frontmatter = match.group(1)
name_match = re.search(r"^name:\s*(.+)$", frontmatter, re.MULTILINE)
description_match = re.search(r"^description:\s*(.+)$", frontmatter, re.MULTILINE)
if not name_match or name_match.group(1).strip() != "social-comic-generator":
    raise SystemExit("SKILL.md name must be social-comic-generator")
if not description_match or len(description_match.group(1).strip()) < 40:
    raise SystemExit("SKILL.md description is missing or too short")
if not re.fullmatch(r"[a-z0-9-]+", name_match.group(1).strip()):
    raise SystemExit("Skill name must use lowercase letters, digits, and hyphens")

required = [
    ROOT / "agents" / "openai.yaml",
    ROOT / "skill-manifest.json",
    ROOT / "references" / "style-presets.json",
    ROOT / "scripts" / "run.mjs",
]
missing = [str(path.relative_to(ROOT)) for path in required if not path.is_file()]
if missing:
    raise SystemExit(f"Missing required Skill files: {', '.join(missing)}")

print("Skill is valid!")
