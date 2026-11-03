#!/usr/bin/env python3
"""Import your own LinkedIn **data export** into the FillDesk profile.

  python3 tools/import_linkedin.py ~/Downloads/linkedin-export.zip
  python3 tools/import_linkedin.py ~/Downloads/LinkedIn/     # already unzipped
  python3 tools/import_linkedin.py export.zip --dry
  python3 tools/import_linkedin.py export.zip --with-history  # also merge jobs and schooling

Get the file from LinkedIn itself: **Me → Settings & Privacy → Data privacy →
"Get a copy of your data" → request export → download the zip** (minutes to a day).
That archive contains Skills.csv, Positions.csv, Educations.csv, Certifications.csv,
Languages.csv and your About text — your own words, exported by you.

Why this route and not "connect your LinkedIn account": automating LinkedIn or
scraping it while logged in breaks its user agreement, is what gets accounts
permanently restricted, and an account you need for job hunting is a expensive
thing to lose. It is also not necessary — the export has the same data, in cleaner
shape, including skill endorsements. FillDesk never logs into anything on your
behalf.

Behaviour: skills always merge and deduplicate. Jobs and education are only added
with --with-history, and never overwrite what you have already typed by hand.
"""
from __future__ import annotations

import argparse
import csv
import io
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import store  # noqa: E402


def read_members(target: Path) -> dict[str, str]:
    """Return {filename: text} for a zip or a directory."""
    out: dict[str, str] = {}
    if target.is_dir():
        for f in target.rglob("*.csv"):
            out[f.name] = f.read_text(encoding="utf-8", errors="ignore")
        for f in target.rglob("*.md"):
            out[f.name] = f.read_text(encoding="utf-8", errors="ignore")
        return out
    with zipfile.ZipFile(target) as zf:
        for name in zf.namelist():
            if name.lower().endswith((".csv", ".md")):
                try:
                    out[Path(name).name] = zf.read(name).decode("utf-8-sig", "ignore")
                except Exception:  # noqa: BLE001 - one unreadable member is not fatal
                    continue
    return out


def rows(text: str) -> list[dict[str, str]]:
    try:
        return list(csv.DictReader(io.StringIO(text)))
    except Exception:  # noqa: BLE001
        return []


def pick(row: dict[str, str], *candidates: str) -> str:
    """LinkedIn's column names drift between exports; match loosely."""
    lowered = { (k or "").strip().lower(): v for k, v in row.items() if k }
    for want in candidates:
        w = want.lower()
        if w in lowered:
            return (lowered[w] or "").strip()
    for k, v in lowered.items():
        if all(word in k for word in w.split()):
            return (v or "").strip()
    return ""


def clean_date(value: str) -> str:
    v = (value or "").strip().split(" ")[0]
    m = re.match(r"^(\d{4})-(\d{1,2})", v)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}"
    m = re.match(r"^(\d{4})$", v)
    return m.group(1) if m else ""


def extract_skills(members: dict[str, str]) -> list[str]:
    out: list[str] = []
    for name, text in members.items():
        if "skill" not in name.lower():
            continue
        for row in rows(text):
            value = pick(row, "skill name", "skill", "name")
            if value and len(value) <= 60:
                out.append(value)
    seen, unique = set(), []
    for s in out:
        key = re.sub(r"[^a-z0-9+#./-]", "", s.lower())
        if key and key not in seen:
            seen.add(key)
            unique.append(s)
    return unique


def extract_experience(members: dict[str, str]) -> list[dict]:
    out: list[dict] = []
    for name, text in members.items():
        if "position" not in name.lower():
            continue
        for row in rows(text):
            company = pick(row, "company name", "company", "organization name")
            title = pick(row, "title", "job title", "position")
            if not (company or title):
                continue
            start = clean_date(pick(row, "start date", "start"))
            end = clean_date(pick(row, "end date", "end"))
            bullets = [b.strip(" -\u2022") for b in re.split(r"[\n\u2022]", pick(row, "job description"))
                       if len(b.strip(" -\u2022")) > 24]
            out.append({"id": f"exp_li_{len(out) + 1}", "company": company, "title": title,
                        "location": pick(row, "location", "location name"),
                        "start": start, "end": end, "current": not end,
                        "context": "", "bullets": bullets[:8], "tech": [], "keywords": [],
                        "company_phone": "",
                        "ref_name": "", "ref_last_name": "", "ref_phone": "", "ref_email": "",
                        "notes": "imported from your LinkedIn export — check the dates"})
    return out


def extract_education(members: dict[str, str]) -> list[dict]:
    out: list[dict] = []
    for name, text in members.items():
        if "education" not in name.lower():
            continue
        for row in rows(text):
            school = pick(row, "school name", "school", "institution")
            if not school:
                continue
            out.append({"id": f"edu_li_{len(out) + 1}", "school": school,
                        "degree": pick(row, "degree", "degree name"),
                        "field": pick(row, "field of study", "field"),
                        "start": clean_date(pick(row, "start date")),
                        "end": clean_date(pick(row, "end date")),
                        "location": "", "notes": "imported from your LinkedIn export — check"})
    return out


def extract_summary(members: dict[str, str]) -> str:
    for name, text in members.items():
        if name.lower().startswith("profile"):
            for row in rows(text):
                summary = pick(row, "summary")
                if len(summary) > 80:
                    return summary.strip()
            # newer exports ship Profile.md with a "## Summary" section
            m = re.search(r"##\s*Summary\s*\n+([\s\S]{80,?})", text)
            if m:
                return re.sub(r"\s+", " ", m.group(1)).strip()
    return ""


def plan_import(profile: dict, skills: list[str], experience: list[dict],
                education: list[dict], summary: str) -> dict:
    """Decide what an export should change. Pure, so it is testable without touching
    your real profile: existing hand-typed data is never overwritten."""
    patch: dict = {}
    existing_skills = [s.lower() for s in (profile.get("skills") or [])]
    new_skills = [s for s in skills if s.lower() not in existing_skills]
    if new_skills:
        patch["skills"] = (profile.get("skills") or []) + new_skills

    have = {(str(e.get("company", "")) + "|" + str(e.get("title", ""))).lower()
            for e in profile.get("experience", []) if isinstance(e, dict)}
    new_roles = [e for e in experience if (e["company"] + "|" + e["title"]).lower() not in have]
    if new_roles:
        patch["experience"] = (profile.get("experience") or []) + new_roles

    has_school = any(e.get("school") for e in profile.get("education", []) if isinstance(e, dict))
    if education and not has_school:
        patch["education"] = education

    if summary and not profile.get("summary"):
        patch["summary"] = summary
    return patch


def main() -> int:
    ap = argparse.ArgumentParser(description="Import a LinkedIn data export into FillDesk.")
    ap.add_argument("export", help="linkedin export .zip, or the unzipped folder")
    ap.add_argument("--dry", action="store_true", help="report only")
    ap.add_argument("--with-history", action="store_true",
                    help="also add jobs and education that are missing from your profile")
    args = ap.parse_args()

    target = Path(args.export).expanduser()
    if not target.exists():
        print(f"no such file or folder: {target}")
        return 1
    members = read_members(target)
    if not members:
        print("no CSV/MD files in there. A LinkedIn export contains Skills.csv, Positions.csv, "
              "Educations.csv and Profile.csv/md.")
        return 1

    skills = extract_skills(members)
    experience = extract_experience(members) if args.with_history else []
    education = extract_education(members) if args.with_history else []
    summary = extract_summary(members)

    print(f"export read: {len(members)} files")
    print(f"  skills:        {len(skills)}")
    print(f"  positions:     {len(extract_experience(members))}"
          f"{'' if args.with_history else '  (not merged: pass --with-history)'}")
    print(f"  education:     {len(extract_education(members))}"
          f"{'' if args.with_history else '  (not merged: pass --with-history)'}")
    print(f"  about/summary: {len(summary)} chars")

    profile = store.load_profile()
    patch = plan_import(profile, skills, experience, education, summary)

    print(f"\n  new skills:    {len(patch.get('skills', [])) - len(profile.get('skills') or [])}")
    print(f"  new roles:     {len(patch.get('experience', [])) - len(profile.get('experience') or [])}"
          if "experience" in patch else "\n  new roles:     0")
    if "summary" in patch:
        print("  summary:       will fill the empty About/summary field")
    if not patch:
        print("\nnothing to import: your profile already has all of it.")
        return 0
    if args.dry:
        print("\n(--dry: nothing saved. Add --with-history to include jobs and education.)")
        return 0
    updated = store.save_profile(store.sanitize_profile(patch))
    warnings = store.validate_profile(updated)
    print(f"\nsaved: {len(updated.get('skills', []))} skills, "
          f"{len(updated.get('experience', []))} roles")
    print(f"warnings: {warnings or 'none'}")
    print("check the dates in the dashboard → Profile. LinkedIn's own end dates are often wrong.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
