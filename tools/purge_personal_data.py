#!/usr/bin/env python3
"""Pre-publish scrubber: find and replace personal data in the working tree.

  python3 tools/purge_personal_data.py --dry     # list files that contain something
  python3 tools/purge_personal_data.py           # replace it with an invented persona

It derives the strings from your own gitignored local data (data/profile.json: name,
town, phone, employers, school, headline, links; plus any locally configured provider
and model names) so nothing about you has to be listed in this file. Paste-a-resume
tools leak this way: the person testing writes their own history into a test fixture
and publishes it.

This only rewrites the **working tree**. Reaching into git history is deliberately
left to you, because it is destructive and depends on where the repo is published:

  git checkout --orphan clean && git add -A
  git commit -m "FillDesk vX.Y"
  git branch -D main && git branch -m main
  git reflog expire --expire=now --all && git gc --prune=now --aggressive
  git push --force --force-with-lease=main:<old-sha> origin main

Then ask the host to garbage-collect the old objects: force-pushing makes commits
unreachable, but they stay fetchable by exact SHA until the host sweeps them.
tests/test_no_personal_data.py checks every blob in history and will stay red until
the old commits are gone.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Only strings derived from YOUR local data are replaced. No generic "looks like a
# phone number" patterns: they hit the invented demo personas in the fixtures and
# quietly rewrite fiction as if it were a leak.

FICTION = ["Dana K. Whitfield", "DANA K. WHITFIELD", "Dayton, OH", "dana.whitfield@example.com",
           "+1 (555) 010-0148", "KwiTel Communications", "State College",
           "Senior Platform & Observability Engineer", "SENIOR PLATFORM & OBSERVABILITY ENGINEER",
           "example-user", "example-model"]


def real_strings() -> list[tuple[str, str]]:
    """(real, replacement) pairs, longest real string first so partials lose."""
    pairs: list[tuple[str, str]] = []
    f = ROOT / "data" / "profile.json"
    if f.exists():
        p = json.loads(f.read_text(encoding="utf-8"))
        name = str(p.get("name") or "").strip()
        if name:
            pairs.append((name, "Dana K. Whitfield"))
            pairs.append((name.upper(), "DANA K. WHITFIELD"))
            pairs.append((name.title(), "Dana K. Whitfield"))
            for part in re.split(r"[\s,.]+", name):
                if len(part) >= 4:
                    pairs.append((part, "Whitfield" if part == name.split()[-1] else "Dana"))
        loc = str(p.get("location") or "").strip()
        if loc:
            pairs.append((loc, "Dayton, OH"))
            pairs.append((loc.split(",")[0].strip(), "Dayton"))
        phone = re.sub(r"\D", "", str(p.get("phone") or ""))
        if len(phone) >= 10:
            pairs.append((str(p.get("phone")), "+1 (555) 010-0148"))
            pairs.append((phone, "15550100148"))
        for link in (p.get("links") or {}).values():
            for m in re.finditer(r"(?:linkedin\.com/in|github\.com)/([^/?#]+)", str(link or "")):
                if len(m.group(1)) >= 5:
                    pairs.append((m.group(1), "example-user"))
        headline = str(p.get("headline") or "").strip()
        if headline:
            pairs.append((headline, "Senior Platform & Observability Engineer"))
        for e in p.get("experience", []) or []:
            company = str(e.get("company") or "").split(" (")[0].strip()
            if len(company) >= 5:
                pairs.append((company, "KwiTel Communications"))
        for e in p.get("education", []) or []:
            school = str(e.get("school") or "").strip()
            if len(school) >= 5:
                pairs.append((school, "State College"))
    email = str((json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}).get("email") or "")
    if email:
        pairs.append((email, "dana.whitfield@example.com"))
        local = email.split("@")[0]
        if len(local) >= 4:
            pairs.append((local, "dana.whitfield"))

    models = Path.home() / ".pi" / "agent" / "models.json"
    if models.exists():
        try:
            providers = (json.loads(models.read_text(encoding="utf-8")).get("providers") or {})
        except (ValueError, OSError):
            providers = {}
        for pid, prov in providers.items():
            pairs.append((pid, "example-provider"))
            for m in prov.get("models") or []:
                if m.get("id") and len(str(m["id"])) >= 4:
                    pairs.append((str(m["id"]), "example-model"))
    home_name = Path.home().name
    if len(home_name) >= 4:
        pairs.append((str(Path.home()), "/home/example-user"))
        pairs.append((home_name, "example-user"))

    seen, unique = set(), []
    for real, repl in pairs:
        if not real or real in seen or real in FICTION:
            continue
        seen.add(real)
        unique.append((real, repl))
    return sorted(unique, key=lambda t: -len(t[0]))


def scrub_text(text: str, pairs: list[tuple[str, str]]) -> tuple[str, bool]:
    changed = False
    for real, repl in pairs:
        if real in text:
            text = text.replace(real, repl)
            changed = True
    return text, changed


def each_blob(apply: bool, pairs) -> list[str]:
    touched: list[str] = []
    refs = subprocess.run(("git", "rev-list", "--all"), cwd=ROOT, capture_output=True, text=True).stdout.split()
    seen = set()
    for sha in refs:
        names = subprocess.run(("git", "ls-tree", "-r", "--name-only", "-z", sha),
                               cwd=ROOT, capture_output=True, text=True).stdout.split("\0")
        for name in names:
            if not name or (sha, name) in seen:
                continue
            seen.add((sha, name))
            path = ROOT / name
            if not path.exists():
                continue
            try:
                original = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            cleaned, changed = scrub_text(original, pairs)
            if changed:
                touched.append(name)
                if apply:
                    path.write_text(cleaned, encoding="utf-8")
    return sorted(set(touched))


def main() -> int:
    ap = argparse.ArgumentParser(description="Scrub personal data from this repository.")
    ap.add_argument("--dry", action="store_true", help="report only")
    args = ap.parse_args()

    pairs = real_strings()
    if not pairs:
        print("nothing local to scrub (no data/profile.json, no provider config)")
        return 0
    if args.dry:
        for path in each_blob(False, pairs):
            print(f"would scrub: {path}")
        print(f"\n{len(pairs)} personal strings known; run without --dry to rewrite the working tree")
        return 0

    each_blob(True, pairs)
    print("working tree scrubbed; run ./tests.sh then commit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
