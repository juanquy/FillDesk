"""Local JSON storage. No database, no cloud: everything lives in ./data.

If this tool ever stops being useful, you can read every byte of it with a
text editor and delete the folder.
"""
from __future__ import annotations

import json
import re
import secrets
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config

# --------------------------------------------------------------------------- helpers


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slug(text: str, limit: int = 48) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return (text[:limit] or "item").rstrip("-")


def new_id(prefix: str) -> str:
    return f"{prefix}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{secrets.token_hex(2)}"


def _read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return default


KEEP_BACKUPS = 40
PROFILE_BACKUP_COOLDOWN = 600  # seconds; the dashboard saves on every edit


def _backup(path: Path, why: str = "replace", min_gap: int = 0):
    # Copy a record out before it is overwritten or deleted. A packet is minutes of
    # model calls plus manual review; a saved posting is a URL that may not exist next
    # week. Replacing either in silence is data loss, and it happened here: a throwaway
    # test wiped the jobs and packets directories and nothing was recoverable, because
    # only the profile had ever been copied anywhere.
    if not path.exists():
        return None
    config.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    family = sorted(config.BACKUP_DIR.glob(path.stem + "-*.json"), reverse=True)
    if min_gap and family and (datetime.now(timezone.utc).timestamp() - family[0].stat().st_mtime) < min_gap:
        return None  # a fresh copy already exists
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    # stamp before reason: recoverable_backups() sorts by name, and a name that leads
    # with "deleted" vs "replace" orders by reason instead of by time.
    target = config.BACKUP_DIR / f"{path.stem}-{stamp}-{why}.json"
    target.write_bytes(path.read_bytes())
    for stale in sorted(config.BACKUP_DIR.glob(path.stem + "-*.json"), reverse=True)[KEEP_BACKUPS:]:
        stale.unlink(missing_ok=True)
    return target


def recoverable_backups(stem: str):
    # Backups for one record, newest first: what "undo that delete" can restore.
    if not config.BACKUP_DIR.exists():
        return []
    return sorted(config.BACKUP_DIR.glob(stem + "-*.json"), reverse=True)


def restore_backup(backup_path, kind: str) -> bool:
    # Put a backed-up record back where it belongs. kind is "job" or "packet".
    data = _read_json(Path(backup_path))
    if not data or not data.get("id"):
        return False
    dest = (config.JOBS_DIR if kind == "job" else config.PACKETS_DIR) / f"{data['id']}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    _write_json(dest, data)
    return True


def _write_json(path: Path, payload: Any) -> None:
    config.ensure_dirs()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


# --------------------------------------------------------------------------- profile

DEFAULT_PROFILE: dict[str, Any] = {
    "name": "",
    "pronouns": "",
    "email": "",
    "phone": "",
    "location": "",              # city, state/country -- used for "location" fields
    "address_line1": "",         # street address e.g. "5 1/2 S Jefferson Ave"
    "address_line2": "",         # apt / suite / unit / NA
    "city": "",                  # city e.g. "Iola"
    "state": "",                 # state e.g. "Kansas" / "KS"
    "postal_code": "",           # zip e.g. "66749"
    "country": "United States",  # country
    "timezone": "",
    "links": {
        "linkedin": "",
        "github": "",
        "portfolio": "",
        "twitter": "",
        "other": "",
    },
    "headline": "",              # e.g. "Senior Product Manager"
    "target_title": "",          # what you are applying for, if different
    "work_authorization_note": "",   # e.g. "U.S. Citizen"
    "authorized_us": True,
    "requires_sponsorship": False,
    "citizenship_status": "U.S. Citizen",
    "eeoc": {
        "gender": "",            # Male | Female | Non-Binary | Decline
        "race": "",              # Hispanic or Latino | White | Black or African American | Asian | Decline
        "veteran": "",           # I am not a protected veteran | I identify as a protected veteran | Decline
        "disability": "",        # No | Yes | Decline
    },
    "salary_expectation": "",
    "relocation": "",            # e.g. "Open to relocation" / "Remote only"
    "willing_to_relocate": "No",
    "work_model": "Remote",
    "how_heard": "LinkedIn",
    "start_date": "",
    "notice_period": "",
    "summary": "",               # professional summary paragraph
    "skills": [],                # ["SQL", "A/B testing", ...]
    "certifications": [],
    "awards": [],
    "languages": [],             # ["English (native)", "Spanish (fluent)"]
    "experience": [
        {
            "id": "exp_1",
            "company": "",
            "title": "",
            "location": "",
            "start": "",         # "2021-06" or "June 2021"
            "end": "",           # "" or "Present"
            "current": True,
            "context": "",       # what the company/product does
            "bullets": [],
            "tech": [],
            "keywords": [],
        }
    ],
    "education": [
        {"id": "edu_1", "school": "", "degree": "", "field": "", "minor": "", "start_year": "", "start_month": "", "end_year": "", "end_month": "", "start": "", "end": "", "school_fallback": "Other", "location": "", "notes": ""}
    ],
    "projects": [
        {"id": "prj_1", "name": "", "description": "", "link": "", "bullets": []}
    ],
    "boilerplate": [],
    "master_resume_markdown": "",   # your canonical resume as markdown; the source of truth
    "extras": {},                   # anything else: clearance, driving license, etc.
    "updated_at": "",
}


def load_profile() -> dict:
    stored = _read_json(config.PROFILE_FILE, None)
    if not stored:
        p = json.loads(json.dumps(DEFAULT_PROFILE))
        p["updated_at"] = now()
        return p
    merged = json.loads(json.dumps(DEFAULT_PROFILE))
    for k, v in stored.items():
        if k in ("experience", "education", "projects", "boilerplate"):
            if isinstance(v, list) and v:
                merged[k] = v
        else:
            merged[k] = v
    return merged


def save_profile(patch: dict) -> dict:
    profile = load_profile()
    for k, v in (patch or {}).items():
        profile[k] = v
    profile["updated_at"] = now()
    _backup(config.PROFILE_FILE, "replace", min_gap=PROFILE_BACKUP_COOLDOWN)
    _write_json(config.PROFILE_FILE, profile)
    return profile


DATE_SHAPE = re.compile(r"^(\d{4})(-(\d{1,2})(-(\d{1,2}))?)?$")
PRESENT_SHAPE = re.compile(r"present|current|now|ongoing", re.I)


def _now_year() -> int:
    return int(now()[:4])


def _date_problem(value: str, label: str) -> str | None:
    """Return a warning when a date cannot be trusted, or None.

    A date is the field where a typo becomes a false statement on a real
    application, so it gets checked before it is ever allowed into a packet.
    """
    v = (value or "").strip()
    if not v or PRESENT_SHAPE.fullmatch(v):
        return None
    m = DATE_SHAPE.match(v)
    if not m:
        return f'{label} "{v}" is not a date FillDesk understands (use YYYY or YYYY-MM)'
    year = int(m.group(1))
    month, day = m.group(3), m.group(5)
    if month is not None and not 1 <= int(month) <= 12:
        return f'{label} "{v}" has no month {int(month)}'
    if day is not None and not 1 <= int(day) <= 31:
        return f'{label} "{v}" has no day {int(day)}'
    if year < 1900 or year > _now_year() + 1:
        return f'{label} "{v}" has an implausible year'
    return None


def _ymd_key(value: str) -> tuple[int, int]:
    m = DATE_SHAPE.match((value or "").strip())
    if not m:
        return (0, 0)
    return (int(m.group(1)), int(m.group(3) or 0))


def validate_profile(profile: dict) -> list[str]:
    """Human-readable problems worth fixing before a packet is built.

    Warnings, not blocks: you know your own history better than a validator does,
    and a tool that refuses to save is its own kind of harm. Nothing invalid is ever
    typed into an application either -- see the date guard in extension/matcher.js.
    """
    warnings: list[str] = []
    for e in profile.get("experience", []) or []:
        if not isinstance(e, dict):
            continue
        who = e.get("company") or e.get("title") or "a role"
        start, end = str(e.get("start") or ""), str(e.get("end") or "")
        for value, label in ((start, f"Start date at {who}"), (end, f"End date at {who}")):
            if (problem := _date_problem(value, label)):
                warnings.append(problem)
        if start and end and not PRESENT_SHAPE.fullmatch(end):
            if _ymd_key(start)[0] and _ymd_key(end)[0] and _ymd_key(end) < _ymd_key(start):
                warnings.append(f"{who}: ends {end} but starts {start} - those look swapped")
        if e.get("current") and end and not PRESENT_SHAPE.fullmatch(end):
            warnings.append(f"{who}: marked as current, but also has an end date of {end}")
        if not e.get("current") and not end and (e.get("company") or e.get("bullets")):
            warnings.append(f"{who}: no end date, so FillDesk will leave that field for you")
    for e in profile.get("education", []) or []:
        if not isinstance(e, dict):
            continue
        who = e.get("school") or "an education entry"
        start, end = str(e.get("start") or ""), str(e.get("end") or "")
        for value, label in ((start, f"Start date at {who}"), (end, f"End date at {who}")):
            if (problem := _date_problem(value, label)):
                warnings.append(problem)
        if start and end and _ymd_key(start)[0] and _ymd_key(end)[0] and _ymd_key(end) < _ymd_key(start):
            warnings.append(f"{who}: shows {end} as the end but {start} as the start - "
                            "forms read the end year as your graduation year")
    if not any((e.get("company") or e.get("bullets")) for e in (profile.get("experience") or []) if isinstance(e, dict)):
        warnings.append("no work history yet - most applications will not autofill anything useful")
    if not profile.get("skills"):
        warnings.append("no skills listed - keyword matching against postings will be weak")
    for key, label in (("salary_expectation", "salary expectation"), ("start_date", "start date"),
                       ("relocation", "relocation answer")):
        if "[needs input]" in str(profile.get(key) or "").lower():
            warnings.append(f"your {label} still says [NEEDS INPUT]")
    return warnings


def sanitize_profile(value, _key: str = ""):
    """Collapse stray whitespace everywhere it could end up typed into a form.

    "State University " with a trailing space is invisible in the dashboard and
    obvious on an application, and autofill types exactly what the profile holds.
    """
    if isinstance(value, str):
        cleaned = re.sub(r"[ \t]+", " ", value).strip()
        if _key in ("start", "end") and cleaned:
            cleaned = cleaned.replace("/", "-")
        return cleaned
    if isinstance(value, list):
        return [sanitize_profile(v) for v in value]
    if isinstance(value, dict):
        return {k: sanitize_profile(v, k) for k, v in value.items()}
    return value


def replace_profile(profile: dict) -> dict:
    """Full replacement, used by tools that build a profile from scratch. Always
    back up data/profile.json first; save_profile() is the normal path."""
    merged = json.loads(json.dumps(DEFAULT_PROFILE))
    for k, v in (profile or {}).items():
        if k in ("experience", "education", "projects", "boilerplate"):
            if isinstance(v, list) and v:
                merged[k] = v
        else:
            merged[k] = v
    merged["updated_at"] = now()
    _write_json(config.PROFILE_FILE, merged)
    return merged


def profile_completeness(profile: dict) -> dict:
    checks = {
        "name": bool(profile.get("name")),
        "email": bool(profile.get("email")),
        "phone": bool(profile.get("phone")),
        "location": bool(profile.get("location")),
        "master resume": bool((profile.get("master_resume_markdown") or "").strip()),
        "experience": any((e.get("company") or "").strip() for e in profile.get("experience", []) if isinstance(e, dict)),
        "skills": bool(profile.get("skills")),
        "summary": bool((profile.get("summary") or "").strip()),
        # Only employer-agnostic answers count: "why this company?" cannot be answered
        # before there is a company, and demanding it left people stuck on the gap list.
        "reusable answers": any(
            (b.get("text") or "").strip() and not config.employer_specific(b.get("label") or "")
            for b in profile.get("boilerplate", []) if isinstance(b, dict)
        ),
        "links": any((profile.get("links") or {}).values()),
    }
    done = sum(1 for v in checks.values() if v)
    return {"checks": checks, "score": round(done / len(checks) * 100), "missing": [k for k, v in checks.items() if not v]}


# --------------------------------------------------------------------------- jobs


def save_job(job: dict) -> dict:
    config.ensure_dirs()
    job_id = job.get("id") or new_id("job")
    record = {
        "id": job_id,
        "created_at": job.get("created_at") or now(),
        "updated_at": now(),
        "source": job.get("source", "manual"),
        "url": job.get("url", ""),
        "title": (job.get("title") or "").strip(),
        "company": (job.get("company") or "").strip(),
        "location": job.get("location", ""),
        "posted": job.get("posted", ""),
        "salary": job.get("salary", ""),
        "employment_type": job.get("employment_type", ""),
        "description": (job.get("description") or "").strip(),
        "questions": job.get("questions", []),
        "tags": job.get("tags", []),
        "notes": job.get("notes", ""),
        "status": job.get("status", "saved"),  # saved|packet|autofilled|submitted|rejected|applied
        "applied_at": job.get("applied_at") or None,
        # A cover-letter draft is not a packet: nothing here is ever autofilled.
        "draft_cover": job.get("draft_cover") or None,
    }
    target = config.JOBS_DIR / f"{job_id}.json"
    _backup(target, "replace")
    _write_json(target, record)
    return record


def list_jobs() -> list[dict]:
    jobs = []
    for p in sorted(config.JOBS_DIR.glob("job_*.json"), reverse=True):
        rec = _read_json(p)
        if rec:
            rec["description_preview"] = (rec.get("description") or "")[:220]
            rec.pop("description", None)
            jobs.append(rec)
    return jobs


def get_job(job_id: str) -> dict | None:
    return _read_json(config.JOBS_DIR / f"{job_id}.json")


def delete_job(job_id: str) -> bool:
    p = config.JOBS_DIR / f"{job_id}.json"
    if p.exists():
        _backup(p, "deleted")
        p.unlink()
        return True
    return False


# --------------------------------------------------------------------------- packets


def save_packet(packet: dict) -> dict:
    config.ensure_dirs()
    packet["updated_at"] = now()
    packet.setdefault("created_at", now())
    target = config.PACKETS_DIR / f"{packet['id']}.json"
    _backup(target, "replace")
    _write_json(target, packet)
    return packet


def list_packets() -> list[dict]:
    out = []
    for p in sorted(config.PACKETS_DIR.glob("packet_*.json"), reverse=True):
        rec = _read_json(p)
        if not rec:
            continue
        out.append(
            {
                "id": rec["id"],
                "job_id": rec.get("job_id"),
                "title": rec.get("title", ""),
                "company": rec.get("company", ""),
                "status": rec.get("status", "draft"),
                "approved": bool(rec.get("approved")),
                "created_at": rec.get("created_at"),
                "provider": (rec.get("llm") or {}).get("provider"),
                "answers_total": len(rec.get("answers", [])),
                "answers_needs_input": sum(1 for a in rec.get("answers", []) if a.get("needs_input")),
                "answers_blocked": sum(1 for a in rec.get("answers", []) if a.get("blocked")),
            }
        )
    return out


def get_packet(packet_id: str) -> dict | None:
    return _read_json(config.PACKETS_DIR / f"{packet_id}.json")


def delete_packet(packet_id: str) -> bool:
    p = config.PACKETS_DIR / f"{packet_id}.json"
    if p.exists():
        _backup(p, "deleted")
        p.unlink()
        return True
    return False


def latest_approved_packet() -> dict | None:
    packets = [p for p in list_packets() if p.get("approved")]
    if not packets:
        return None
    packets.sort(key=lambda p: p.get("updated_at") or p.get("created_at") or "", reverse=True)
    return get_packet(packets[0]["id"])


# --------------------------------------------------------------------------- events (local coverage stats)


def log_event(event: str, payload: dict) -> None:
    config.ensure_dirs()
    line = json.dumps({"ts": now(), "event": event, **(payload or {})}, ensure_ascii=False)
    with config.EVENTS_FILE.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def event_stats() -> dict:
    if not config.EVENTS_FILE.exists():
        return {"total": 0, "by_event": {}, "by_host": {}, "blocked": 0, "filled": 0, "unmatched": 0}
    by_event: dict[str, int] = {}
    by_host: dict[str, dict[str, int]] = {}
    filled = unfilled = blocked = 0
    total = 0
    for line in config.EVENTS_FILE.read_text(encoding="utf-8").splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        total += 1
        ev = rec.get("event", "?")
        by_event[ev] = by_event.get(ev, 0) + 1
        host = rec.get("host") or "local"
        slot = by_host.setdefault(host, {"filled": 0, "unmatched": 0, "blocked": 0, "runs": 0})
        if ev == "autofill_run":
            slot["runs"] += 1
            filled += int(rec.get("filled", 0))
            unfilled += int(rec.get("unmatched", 0))
            blocked += int(rec.get("blocked", 0))
            slot["filled"] += int(rec.get("filled", 0))
            slot["unmatched"] += int(rec.get("unmatched", 0))
            slot["blocked"] += int(rec.get("blocked", 0))
    return {"total": total, "by_event": by_event, "by_host": by_host, "filled": filled, "unmatched": unfilled, "blocked": blocked}
