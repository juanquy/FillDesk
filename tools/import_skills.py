#!/usr/bin/env python3
"""Import skills into your profile from a text file.

  python3 tools/import_skills.py skills.txt
  python3 tools/import_skills.py skills.txt --dry     # show what would change
  python3 tools/import_skills.py --from-resume        # take them from your profile's resume text

Handles the two shapes people actually have: one skill per line (with category
headings that get dropped), and comma/pipe separated lists.

This never overwrites silently: existing skills are kept, duplicates are skipped,
and the result is printed so you can prune it in the dashboard afterwards.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import store  # noqa: E402

# Generic section labels only. Anything that merely looks like a category heading is
# kept as a skill, because "Identity & Access Management" is a legitimate thing to
# list, and a tool that guesses which of your lines are headings will guess wrong.
SECTION_WORDS = {
    "skills", "core skills", "technical skills", "core competencies", "competencies",
    "technologies", "tools", "tech stack", "certifications", "education", "experience",
    "work experience", "professional experience", "professional summary", "summary",
    "profile", "objective", "additional information", "highlights", "languages",
    "projects", "adjacent", "emerging", "adjacent / emerging", "soft skills",
    "core technical experience", "certifications & training", "certifications and training",
}
# A line that reads like prose, not a skill: long, or a full sentence with a verb phrase.
PROSE_HINTS = re.compile(r"\b(you |your |appears to|aligns more|which is|and often|proven experience)\b", re.I)


def looks_like_prose(line: str) -> bool:
    return len(line) > 80 or line.count(".") >= 2 or bool(PROSE_HINTS.search(line))


def split_items(line: str) -> list[str]:
    """Split on separators, but never inside parentheses: 'Microsoft Entra ID
    (Azure AD)' is one skill, not a skill and a dangling fragment."""
    out, buf, depth = [], "", 0
    for ch in line:
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth = max(0, depth - 1)
        if depth == 0 and ch in ";,|":
            out.append(buf)
            buf = ""
            continue
        if depth == 0 and ch == " " and buf.endswith("  "):
            out.append(buf.rstrip())
            buf = ""
            continue
        buf += ch
    out.append(buf)
    return [p.strip() for p in out if p.strip()]


def extract(text: str) -> list[str]:
    out: list[str] = []
    for raw in text.splitlines():
        line = re.sub(r"^[\s\-\u2013\u2014\u2022*\u25aa\uf0b7]+", "", raw).strip().strip(".,;")
        if not line or line.lower() in SECTION_WORDS or looks_like_prose(line):
            continue
        for part in split_items(line):
            part = part.strip().strip(".")
            if not (2 <= len(part) <= 60):
                continue
            if looks_like_prose(part) or part.lower() in SECTION_WORDS:
                continue
            if part.count("(") != part.count(")"):
                continue  # a fragment, not a skill
            out.append(part)
    seen, unique = set(), []
    for s in out:
        key = re.sub(r"[^a-z0-9+#.]", "", s.lower())
        if key and key not in seen:
            seen.add(key)
            unique.append(s)
    return unique


def main() -> int:
    ap = argparse.ArgumentParser(description="Import skills into the FillDesk profile.")
    ap.add_argument("file", nargs="?", help="text file of skills (one per line, or comma separated)")
    ap.add_argument("--from-resume", action="store_true", help="read the master resume already in your profile")
    ap.add_argument("--dry", action="store_true", help="report only, save nothing")
    ap.add_argument("--replace", action="store_true", help="replace the existing list instead of merging")
    args = ap.parse_args()

    if args.from_resume:
        text = store.load_profile().get("master_resume_markdown", "")
        if not text.strip():
            print("no master resume on file -- import the resume first (dashboard → Profile)")
            return 1
        source = "your master resume"
    elif args.file:
        path = Path(args.file).expanduser()
        if not path.exists():
            print(f"no such file: {path}")
            return 1
        text = path.read_text(encoding="utf-8", errors="ignore")
        source = str(path)
    else:
        ap.print_help()
        return 1

    skills = extract(text)
    if not skills:
        print(f"no skills recognised in {source}. One per line, or a comma separated list, works best.")
        return 1

    profile = store.load_profile()
    existing = list(profile.get("skills") or [])
    keep = [] if args.replace else existing
    added = [s for s in skills if s.lower() not in {k.lower() for k in keep}]
    merged = keep + added

    print(f"from {source}: {len(skills)} candidate skills")
    print(f"  already on file: {len(skills) - len(added)}")
    print(f"  new:             {len(added)}")
    print(f"  total after import: {len(merged)}")
    preview = ", ".join(added[:14])
    print(f"\n  adding: {preview}{'…' if len(added) > 14 else ''}")

    resume_text = (profile.get("master_resume_markdown") or "").lower()
    in_resume = [s for s in merged if s.lower() in resume_text]
    print(f"  of your final list, {len(in_resume)} also appear in your resume text")

    if args.dry:
        print("\n(--dry: nothing saved)")
        return 0

    store.save_profile({"skills": merged})
    warnings = store.validate_profile(store.load_profile())
    print(f"\nsaved. profile warnings: {warnings or 'none'}")
    print("prune anything wrong in the dashboard → Profile → Skills.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
