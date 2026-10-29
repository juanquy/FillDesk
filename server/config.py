"""FillDesk configuration: ports, tokens, LLM provider settings.

Nothing here requires a third-party package. Settings are read from, in order:
  1. environment variables (FILLDESK_*)
  2. data/settings.json (written by the dashboard)
  3. built-in defaults
"""
from __future__ import annotations

import json
import os
import secrets
import stat
from pathlib import Path
from typing import Any

APP_NAME = "FillDesk"
VERSION = "0.1.4"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("FILLDESK_DATA", ROOT / "data"))
WEB_DIR = ROOT / "web"

PROFILE_FILE = DATA_DIR / "profile.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
TOKEN_FILE = DATA_DIR / "api_token"
JOBS_DIR = DATA_DIR / "jobs"
PACKETS_DIR = DATA_DIR / "packets"
FILES_DIR = DATA_DIR / "files"
EVENTS_FILE = DATA_DIR / "events.jsonl"

DEFAULT_PORT = int(os.environ.get("FILLDESK_PORT", "8756"))
DEFAULT_HOST = os.environ.get("FILLDESK_HOST", "127.0.0.1")

# Field families the tool will refuse to answer on the user's behalf.
# Mirrored in extension/matcher.js -- keep both in sync.
BLOCKED_CATEGORIES = {
    "protected_class": "Race, ethnicity, gender, religion, sexual orientation, or other protected-class self-identification",
    "disability": "Disability status or accommodation requests",
    "veteran": "Veteran / protected-veteran status",
    "work_authorization": "Work authorization, citizenship, or visa sponsorship",
    "age": "Age or date of birth",
    "criminal": "Arrests, convictions, or background disclosures",
    "legal_declaration": "Certifications, electronic signatures, or attestations made in your name",
    "health": "Health, medical leave, or workers-comp history",
}

# Some questions are answerable but must always be re-read before submit.
REVIEW_CATEGORIES = {
    "salary": "Compensation figures",
    "relocation": "Location, relocation, and remote-work availability",
    "start_date": "Start date and availability",
    "notice": "Notice period / non-compete",
    "clearance": "Security clearance or government screening",
    "references": "Reference contact details",
}


def ensure_dirs() -> None:
    for d in (DATA_DIR, JOBS_DIR, PACKETS_DIR, FILES_DIR):
        d.mkdir(parents=True, exist_ok=True)


def _private(path: Path, payload: str) -> None:
    path.write_text(payload, encoding="utf-8")
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def api_token() -> str:
    """A local bearer token so that random websites cannot read your PII off 127.0.0.1."""
    ensure_dirs()
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    token = secrets.token_urlsafe(24)
    _private(TOKEN_FILE, token + "\n")
    return token


def api_required() -> bool:
    return os.environ.get("FILLDESK_OPEN_API", "") not in ("1", "true", "yes")


DEFAULT_SETTINGS: dict[str, Any] = {
    "llm": {
        "provider": "auto",            # auto | openai | anthropic | ollama | none
        "base_url": "",                # e.g. https://api.openai.com/v1 or http://localhost:11434
        "model": "",
        "api_key": "",                 # only ever written to local data/settings.json
        "temperature": 0.4,
        "max_tokens": 8000,
        # Reasoning models can spend the whole output budget thinking before they
        # answer, which truncates long JSON packets. Off by default; the field is
        # sent as enable_thinking=false and ignored by providers that lack it.
        "no_thinking": True,
    },
    "autofill": {
        "overwrite_filled": False,     # leave recruiter-prefilled values alone
        "click_navigation": True,      # may click "Next"/"Continue", never "Submit"
        "upload_documents": True,      # inject resume/cover letter into file inputs
        "visible_delay_ms": 260,       # pace so you can watch it happen
        "highlight_filled": True,
        "refuse_blocked_fields": True,
    },
    "packets": {
        "tailor_resume": True,
        "write_cover_letter": True,
        "draft_answers": True,
        "resume_pages": 1,
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_settings() -> dict:
    saved: dict[str, Any] = {}
    if SETTINGS_FILE.exists():
        try:
            saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            saved = {}
    return _deep_merge(DEFAULT_SETTINGS, saved)


def save_settings(patch: dict) -> dict:
    ensure_dirs()
    merged = _deep_merge(load_settings(), patch or {})
    _private(SETTINGS_FILE, json.dumps(merged, indent=2))
    return merged


def env_llm() -> dict:
    """Environment overrides so you can run without touching the dashboard."""
    return {
        "provider": os.environ.get("FILLDESK_LLM_PROVIDER", ""),
        "base_url": os.environ.get("FILLDESK_LLM_BASE_URL", ""),
        "model": os.environ.get("FILLDESK_LLM_MODEL", ""),
        "api_key": os.environ.get("FILLDESK_LLM_API_KEY", ""),
    }
