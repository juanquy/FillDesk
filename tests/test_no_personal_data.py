"""Publish guard: `python3 tests/test_no_personal_data.py`

This repository gets published. Your machine holds the things that must never be in
it: your resume, your name, your phone number, your employers, your local API tokens,
and the name of whatever model endpoint you happen to be testing against.

The forbidden strings are never written in this file. They are derived at run time
from your own gitignored local data (`data/profile.json`, `data/settings.json`,
`data/api_token`, your home-directory name, and any locally configured provider
names), then checked against **every blob in the entire git history**, not just the
working tree -- deleting a secret in a later commit does not remove it from a public
repo.

On a fresh clone with no local data, most checks skip: there is nothing to derive.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SECRET_PATTERNS = [
    re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}"),
    re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(rb"(?i)authorization:\s*bearer\s+[A-Za-z0-9._-]{20,}"),
]

# Words that legitimately contain a personal substring and are not leaks.
ALLOW = {"example", "examples"}


def git(*args: str) -> bytes:
    return subprocess.run(("git", *args), cwd=ROOT, capture_output=True).stdout


def git_ok() -> bool:
    return subprocess.run(("git", "rev-parse", "--git-dir"), cwd=ROOT, capture_output=True).returncode == 0


def profile_strings() -> list[str]:
    f = ROOT / "data" / "profile.json"
    if not f.exists():
        return []
    try:
        p = json.loads(f.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    out: list[str] = []
    for key in ("name", "email", "phone", "location", "headline"):
        if p.get(key):
            out.append(str(p[key]))
    name = str(p.get("name") or "")
    out += [t for t in re.split(r"[\s,.]+", name) if len(t) >= 4 and t.lower() not in ALLOW]
    for link in (p.get("links") or {}).values():
        m = re.search(r"(?:linkedin\.com/in|github\.com)/([^/?#]+)", str(link or ""))
        if m and len(m.group(1)) >= 5:
            out.append(m.group(1))
    for e in p.get("experience", []) or []:
        if e.get("company"):
            out.append(str(e["company"]).split(" (")[0])
    for e in p.get("education", []) or []:
        if e.get("school"):
            out.append(str(e["school"]))
    return [s.strip() for s in out if len(s.strip()) >= 4]


def local_secret_strings() -> list[str]:
    out: list[str] = []
    for rel in ("data/settings.json", "data/api_token"):
        f = ROOT / rel
        if not f.exists():
            continue
        if rel.endswith(".json"):
            try:
                key = ((json.loads(f.read_text(encoding="utf-8")).get("llm") or {}).get("api_key") or "")
            except (ValueError, OSError):
                key = ""
            if len(key) >= 12:
                out.append(key)
        else:
            token = f.read_text(encoding="utf-8").strip()
            if len(token) >= 8:
                out.append(token)
    return out


def provider_strings() -> list[str]:
    """Names of whatever endpoint this machine is testing against. Nothing in a
    published repo should identify the vendor a developer happens to use."""
    out: list[str] = []
    for f in (Path.home() / ".pi" / "agent" / "models.json",):
        if not f.exists():
            continue
        try:
            providers = (json.loads(f.read_text(encoding="utf-8")).get("providers") or {})
        except (ValueError, OSError):
            continue
        for pid, prov in providers.items():
            out.append(pid)
            for m in prov.get("models") or []:
                if m.get("id"):
                    out.append(str(m["id"]))
    return [s for s in out if len(s) >= 4]


def username_string() -> str:
    return Path.home().name


class History(unittest.TestCase):
    def refspec(self) -> str:
        return "--all"

    def setUp(self):
        if not git_ok():
            self.skipTest("not a git repository")

    def blobs(self):
        seen = set()
        for sha in git("rev-list", self.refspec()).decode(errors="ignore").split():
            for name in git("ls-tree", "-r", "--name-only", "-z", sha).decode(errors="ignore").split("\0"):
                if not name or (sha, name) in seen:
                    continue
                seen.add((sha, name))
                yield name, git("cat-file", "blob", f"{sha}:{name}")

    def test_no_secrets_anywhere_in_history(self):
        extra = [s.encode() for s in local_secret_strings()]
        hits = []
        for name, blob in self.blobs():
            for pat in SECRET_PATTERNS:
                if pat.search(blob):
                    hits.append(f"{name}: {pat.pattern}")
            for secret in extra:
                if secret in blob:
                    hits.append(f"{name}: a local API key/token from {ROOT / 'data'}")
        self.assertEqual(hits, [], "secrets in published blobs:\n  " + "\n  ".join(sorted(set(hits))))

    def test_no_personal_data_in_history(self):
        forbidden = profile_strings() + provider_strings()
        user = username_string()
        if user and user.lower() not in ALLOW:
            forbidden.append(user)
        if not forbidden:
            self.skipTest("no local profile/provider data to derive personal strings from")
        hits = []
        for name, blob in self.blobs():
            text = blob.decode("utf-8", "ignore").casefold()
            squished = re.sub(r"[^a-z0-9]", "", text)
            for item in forbidden:
                low = item.casefold()
                if low in ALLOW or low in ("present", "example.com"):
                    continue
                if low in text:
                    hits.append(f"{name}: {item!r}")
                elif len(re.sub(r"[^a-z0-9]", "", low)) >= 9 and re.sub(r"[^a-z0-9]", "", low) in squished:
                    hits.append(f"{name}: {item!r} (digits/punctuation differ)")
        self.assertEqual(hits, [], "personal data in published blobs:\n  " + "\n  ".join(sorted(set(hits))))

    def test_no_personal_data_in_commit_messages(self):
        forbidden = profile_strings() + provider_strings()
        user = username_string()
        if user:
            forbidden.append(user)
        if not forbidden:
            self.skipTest("nothing local to check against")
        log = git("log", self.refspec(), "--format=%s%n%b").decode("utf-8", "ignore").casefold()
        hits = [f for f in forbidden if f.casefold() in log and f.casefold() not in ALLOW]
        self.assertEqual(hits, [], f"commit messages mention: {sorted(set(hits))}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
