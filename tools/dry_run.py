#!/usr/bin/env python3
"""Resume in, review-out: see exactly what FillDesk would do before you use it.

  python3 tools/dry_run.py --resume ~/resumes/me.pdf
  python3 tools/dry_run.py --resume me.docx --keep-existing
  python3 tools/dry_run.py --resume me.pdf --posting acme.txt --company Acme --title "Staff Engineer"

What it does, entirely on this machine:

  1. reads your resume (PDF / DOCX / TXT / MD) and reports how well it extracted
  2. drafts profile fields from it (contact details, links, skills, history)
  3. builds a packet for a posting (yours if you pass --posting, else a sample)
  4. runs the REAL field matcher over a sample application form, no browser needed
  5. writes reports/dry-run-<stamp>.md: what would be filled, uploaded, left alone,
     and refused, plus what it could not work out from your resume

Your existing profile is backed up first and the report tells you how to restore it.
No job site is involved. The only network call possible is the model call you
configured yourself; with no key it runs on rules alone.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

from server import config, resume_export, resume_parse, store  # noqa: E402

MONTHS = {m.lower(): i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}

EMAIL_RX = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
URL_RX = re.compile(r"(?:https?://|www\.)[^\s|,;()<>\"']+", re.I)
PHONE_RX = re.compile(r"(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{2,5}")
_PLACES = ("Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|"
           "Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|"
           "Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|"
           "Nebraska|Nevada|Ohio|Oklahoma|Oregon|Pennsylvania|Tennessee|Texas|Utah|Vermont|"
           "Virginia|Washington|Wisconsin|Wyoming|Yorkshire|Ontario|Quebec|"
           "United States|America|UK|United Kingdom|England|Scotland|Wales|Germany|France|"
           "India|Spain|Italy|Netherlands|Holland|Poland|Brazil|Mexico|Australia|Japan|"
           "Singapore|Ireland|Sweden|Norway|Denmark|Finland|Switzerland|Portugal|Israel|"
           "Emirates|Nigeria|Kenya|Africa|New Zealand|Canada|China|Korea|Turkey|Taiwan|Belgium|"
           "Austria|Czechia|Romania|Argentina|Chile|Colombia|Remote")
LOC_RX = re.compile(r"\b([A-Z][A-Za-z .'-]{1,22},\s*(?:[A-Z]{2}\b|(?:" + _PLACES + r")\b))")
DATE_RX = re.compile(
    r"((?:[A-Z][a-z]{2}[a-z]*\.?\s+)?\d{4}|\d{1,2}/\d{4})\s*(?:-|–|—|to|until|~)\s*"
    r"((?:[A-Z][a-z]{2}[a-z]*\.?\s+)?\d{4}|present|current|now|ongoing)", re.I)
NAME_STOP = {
    "resume", "curriculum", "vitae", "cv", "summary", "profile", "objective", "contact",
    "experience", "education", "skills", "work", "professional", "employment", "projects",
    "highlights", "references", "awards", "honors", "certifications", "activities",
}
ROLE_WORDS = re.compile(
    r"\b(engineer|developer|manager|designer|analyst|scientist|architect|consultant|"
    r"director|lead|vp|vice president|specialist|coordinator|administrator|"
    r"accountant|attorney|teacher|nurse|researcher|marketer|writer|recruiter)\b", re.I)

SECTION_WORDS = {
    "summary": ("summary", "profile", "objective", "about me", "overview"),
    "experience": ("experience", "employment history", "work history"),
    "education": ("education", "academic background", "qualifications", "degrees"),
    "skills": ("skills", "competencies", "technologies", "tech stack", "expertise"),
    "projects": ("projects", "open source", "publications"),
}


def is_heading(line: str, key: str) -> bool:
    """A section heading is short, uncommented, undated, and named.
    'EDUCATION & CERTIFICATIONS' must count; a bullet about "15+ years of experience"
    must not."""
    t = (line or "").strip()
    if not t or len(t) > 48 or t.startswith("- ") or t.endswith(".") or re.search(r"\d", t):
        return False
    low = t.lower()
    return any(w in low for w in SECTION_WORDS[key])

# Sub-headings that carry dates in prose but are not jobs.
NOT_A_ROLE = re.compile(
    r"\b(summary|overview|profile|highlights|competencies|skills|education|certifications?"
    r"|additional\s+information|early\s+career|other\s+experience|references)\b", re.I)


# --------------------------------------------------------------------------- io

def http(base: str, token: str, method: str, path: str, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"content-type": "application/json", "x-filldesk-token": token})
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except Exception:  # noqa: BLE001
            return exc.code, {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return 0, {"error": str(exc)}


def ensure_server(port: int):
    """Always start a server of our own when the port is free. Reusing a server that
    happens to be running means testing whatever code was loaded when it started,
    which is how a fixed bug keeps showing up in a 'fresh' report."""
    base = f"http://127.0.0.1:{port}"
    if http(base, "", "GET", "/api/status")[0] in (200, 401):
        print(f"note: reusing the server already on port {port} (it may be running older code)")
        return base, None
    proc = subprocess.Popen([sys.executable, "-m", "server", "--port", str(port)],
                            cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        time.sleep(0.25)
        if http(base, "", "GET", "/api/status")[0] in (200, 401):
            return base, proc
    proc.terminate()
    raise SystemExit("could not start the local server; run `python3 -m server` and retry")


def pick_port(preferred: int) -> int:
    """Use the preferred port if it is free, so a dry run never depends on what else
    is listening there."""
    import socket

    for port in (preferred, *range(preferred + 1, preferred + 20)):
        with socket.socket() as probe:
            try:
                probe.bind((config.DEFAULT_HOST, port))
                return port
            except OSError:
                continue
    return preferred


def strip_deco(line: str) -> str:
    """Flatten markup, but keep a bullet as `- `: whether a line is its own bullet or
    the wrapped tail of the one above it is the difference between a clean resume and
    one that gets cut off mid-sentence."""
    t = re.sub(r"<[^>]+>", " ", line)
    t = t.replace("\uf0b7", " ").replace("**", "").replace("__", "")
    t = re.sub(r"^#{1,6}\s*", "", t)
    lead = re.match(r"^\s*[-\u2013\u2014\u2022*\u25aa\u2043\u2219`]+[\s]+", t)
    t = t.rstrip().strip("`")
    if lead:
        t = "- " + t[lead.end():]
    return t.strip()


def lines_of(text: str) -> list[str]:
    return [strip_deco(l) for l in text.splitlines()]


def section_block(lines: list[str], key: str):
    """(start, end) indices of the block under the first matching heading."""
    for i, line in enumerate(lines[:200]):
        if is_heading(line, key):
            end = len(lines)
            for j in range(i + 1, min(len(lines), i + 140)):
                nxt = lines[j]
                if not nxt:
                    continue
                if any(is_heading(nxt, other) for other in SECTION_WORDS if other != key):
                    end = j
                    break
            return i + 1, end
    return None


# ------------------------------------------------------------------- extraction

def split_skills(raw: str) -> list[str]:
    """Split a skills line on separators, but keep `AWS (S3, Lambda, ECS)` whole —
    the commas inside parentheses are part of one skill, not separators."""
    groups: list[str] = []

    def stash(m: re.Match) -> str:
        groups.append(m.group(0))
        return f"\x00{len(groups) - 1}\x00"

    protected = re.sub(r"\([^()]*\)", stash, raw or "")
    out: list[str] = []
    for part in re.split(r"[;,|\u2022\u00b7]|\band\b", protected):
        piece = re.sub(r"\x00(\d+)\x00", lambda m: groups[int(m.group(1))], part).strip(" .:-")
        if 1 < len(piece) <= 40 and piece.lower() not in out:
            out.append(piece)
    return out


ACRONYMS = {"Ai": "AI", "Ml": "ML", "It": "IT", "Ux": "UX", "Ui": "UI", "Db": "DB", "Api": "API",
            "Sre": "SRE", "Devops": "DevOps", "Gpu": "GPU", "Cpu": "CPU", "Eo": "EO"}


def titlecase_role(s: str) -> str:
    """Resumes shout; forms and cover letters should not. Title-case an ALL CAPS
    headline, then put the acronyms back."""
    if s.upper() != s:
        return s
    out = re.sub(r"\s+", " ", s).title()
    return " ".join(ACRONYMS.get(w, w) for w in out.split())


def parse_resume(text: str) -> dict:
    """Draft profile fields from raw resume text. Best effort: everything it
    guesses is listed in the report for you to check, never silently trusted."""
    lines = lines_of(text)
    head = [l for l in lines[:20] if l]
    out: dict = {"_sources": {}, "_gaps": []}

    email = EMAIL_RX.search(text)
    if email:
        out["email"] = email.group(0)
        out["_sources"]["email"] = email.group(0)

    for line in head:
        if "@" in line and EMAIL_RX.sub("", line).strip() == line.strip():
            continue
        cand = PHONE_RX.search(line)
        if cand and 9 <= len(re.sub(r"\D", "", cand.group(0))) <= 15:
            out["phone"] = cand.group(0).strip()
            out["_sources"]["phone"] = cand.group(0).strip()
            break

    links = {"linkedin": "", "github": "", "portfolio": "", "twitter": "", "other": ""}
    bare = re.findall(r"(?i)\b(?:linkedin|github|twitter|x)\.com/[^\s|,;)\"']+", text)
    for url in list(URL_RX.findall(text)) + bare:
        u = url.rstrip(".,);")
        low = u.lower()
        if not low.startswith(("http://", "https://", "www.")) and ("linkedin.com" in low or "github.com" in low):
            u = "https://" + u.lstrip("/")
        if "linkedin.com" in low and not links["linkedin"]:
            links["linkedin"] = u
        elif "github.com" in low and not links["github"]:
            links["github"] = u
        elif re.search(r"(twitter|x)\.com", low) and not links["twitter"]:
            links["twitter"] = u
        elif not links["portfolio"] and "@" not in u:
            links["portfolio"] = u if u.startswith(("http", "www")) else "https://" + u
    # A bare personal domain in the contact block, e.g. `samokafor.example.com`.
    if not links["portfolio"]:
        email_domain = out.get("email", "").split("@")[-1].lower()
        top = "\n".join(head[:6])
        for cand in re.findall(r"\b(?:[\w-]+\.)+(?:com|dev|io|me|co|net|org|design|studio|app)\b", top):
            low = cand.lower()
            if any(h in low for h in ("linkedin.", "github.", "twitter.", "x.com", "example.com")):
                continue
            if low == email_domain or low.endswith("." + email_domain and email_domain):
                continue
            links["portfolio"] = "https://" + cand
            break

    if any(links.values()):
        out["links"] = links
        out["_sources"]["links"] = ", ".join(v for v in links.values() if v)

    name = ""
    for line in head[:10]:
        t = EMAIL_RX.sub("", line)
        t = URL_RX.sub("", t)
        t = PHONE_RX.sub("", t).strip(" ,|·-")
        if not (2 <= len(t) <= 44):
            continue
        parts = t.split()
        if not (2 <= len(parts) <= 4):
            continue
        if any(p.lower().strip(".") in NAME_STOP for p in parts):
            continue
        if not all(re.match(r"^[A-Z][\w'’.-]*$", p) for p in parts):
            continue
        name = re.sub(r"\s+", " ", t)
        if name.upper() == name:  # resumes shout; forms do not
            name = re.sub(r"\b([A-Z])\b", lambda m: m.group(1).upper(),
                          name.title().replace(" Mc ", " Mac "))
        out["name"] = name
        out["_sources"]["name"] = line
        break

    for line in head:
        m = LOC_RX.search(line)
        if m and m.group(1) != name:
            out["location"] = m.group(1)
            out["_sources"]["location"] = m.group(1)
            break

    # A headline is a short label, not a sentence: take the piece of a top line
    # that names a role, after contact details are removed.
    for line in head[:8]:
        if line == name:
            continue
        bare = re.sub(r"\s([\u00b7|])\s*[\u00b7|]\s*", r" \1 ", PHONE_RX.sub("", URL_RX.sub("", EMAIL_RX.sub("", line))))
        for piece in (p.strip(" ,·|-") for p in re.split(r"\s[·|]\s|\s[-–—]\s", bare)):
            if piece and piece != name and len(piece) <= 60 and len(piece.split()) <= 8 and ROLE_WORDS.search(piece):
                out["headline"] = titlecase_role(piece)
                out["target_title"] = titlecase_role(piece)
                out["_sources"]["headline"] = line.strip()
                break
        if out.get("headline"):
            break

    if (blk := section_block(lines, "summary")):
        para = " ".join(l[2:] if l.startswith("- ") else l for l in lines[blk[0]:blk[1]] if l)
        if len(para) > 60:
            out["summary"] = para[:900]
            out["_sources"]["summary"] = f"{len(para)} chars from the summary section"

    if (blk := section_block(lines, "skills")):
        block_lines = [l for l in lines[blk[0]:blk[1]] if l]
        joined = " ".join(l.lstrip("- ") for l in block_lines)
        wide = [l for l in block_lines if re.search(r"\s{2,}", l)]
        if len(wide) >= max(2, len(block_lines) // 3):
            # Two-column PDF competency blocks: the gaps are the separators, and
            # pdftotext -layout preserves them.
            raw = [tok.strip(" .\u00b7-") for l in block_lines for tok in re.split(r"\s{2,}", l.lstrip("- ").rstrip())]
            skills = [t for t in raw if 2 < len(t) <= 40 and not (t.upper() == t and len(t.split()) > 2)]
        elif len(re.findall(r"[,;|\u2022\u00b7]", joined)) >= 3:
            skills = split_skills(joined)
        else:
            skills = []  # not a delimited list -- better an honest gap than garbage
        skills = list(dict.fromkeys(skills))
        if skills:
            out["skills"] = skills[:40]
            out["_sources"]["skills"] = f"{len(out['skills'])} skills, e.g. {', '.join(skills[:6])}"

    out["experience"] = parse_experience(lines)
    out["_sources"]["experience"] = f"{len(out['experience'])} roles"
    out["education"] = parse_education(lines)
    out["_sources"]["education"] = f"{len(out['education'])} entries"

    for key, label in (("email", "email address"), ("phone", "phone number"), ("location", "city / location"),
                       ("name", "your name")):
        if not out.get(key):
            out["_gaps"].append(f"no {label} found in the resume text")
    if not out.get("skills"):
        out["_gaps"].append("no clean skills list found (common with two-column PDFs) -- add them in Profile, "
                            "they drive keyword matching")
    if not out["experience"]:
        out["_gaps"].append("could not split out any dated roles — the Experience section will need typing")
    if not out["education"]:
        out["_gaps"].append("education was unreadable (usually a multi-column block) — type the school and "
                            "degree in Profile rather than let anything guess it")
    if not out.get("summary"):
        out["_gaps"].append("no summary/objective paragraph found")
    return out


def parse_dates(chunk: str):
    m = DATE_RX.search(chunk)
    if not m:
        return "", "", False

    def norm(part: str) -> tuple[str, str]:
        part = part.strip().rstrip(".")
        month = ""
        for mk, mi in MONTHS.items():
            if part.lower().startswith(mk):
                month = f"{mi:02d}"
                break
        year = re.search(r"\d{4}", part)
        return (year.group(0) if year else ""), month

    sy, sm = norm(m.group(1))
    ey, em = norm(m.group(2))
    current = bool(re.search(r"present|current|now|ongoing", m.group(2), re.I))
    start = f"{sy}-{sm}" if sy and sm else sy
    end = "Present" if current else (f"{ey}-{em}" if ey and em else ey)
    return start, end, current


def split_pieces(text: str) -> list[str]:
    """Split 'Acme (Fortune 500 retailer) | Engineer' style lines on separators --
    but never inside parentheses, which is what turns a company into
    'Acme Communications (Regional ISP'."""
    out, buf, depth = [], "", 0
    i = 0
    seps = (" | ", " \u00b7 ", " \u2022 ", " , ", " \u2013 ", " \u2014 ")
    while i < len(text):
        if text[i] in "([":
            depth += 1
        elif text[i] in ")]":
            depth = max(0, depth - 1)
        if depth == 0:
            match = next((s for s in seps if text.startswith(s, i)), None)
            if match:
                out.append(buf.strip(" .`"))
                buf = ""
                i += len(match)
                continue
        buf += text[i]
        i += 1
    out.append(buf.strip(" .`"))
    return [p for p in out if p]


def parse_experience(lines: list[str]) -> list[dict]:
    blk = section_block(lines, "experience")
    if not blk:
        return []
    entries: list[dict] = []
    current: dict | None = None
    for line in lines[blk[0]:blk[1]]:
        if not line:
            continue
        if DATE_RX.search(line) and len(line) <= 160:
            if NOT_A_ROLE.search(line):
                current = None      # a dated sub-heading like "Early Leadership (Summary)"
                continue
            start, end, is_current = parse_dates(line)
            without_dates = DATE_RX.sub("", line).strip(" ,|·-\t")
            # Pull the location out first: "Seattle, WA" must not be split in two by
            # the comma rule, and it is the one piece whose shape we can trust.
            loc_m = LOC_RX.search(without_dates)
            location = loc_m.group(1) if loc_m else ""
            rest = (without_dates[:loc_m.start()] + " \u00b7 " + without_dates[loc_m.end():]) if loc_m else without_dates
            pieces = split_pieces(rest)
            # Whichever piece names a role is the title; the first other piece is the
            # company. Order in the resume varies far more than people expect.
            title = next((p for p in pieces if ROLE_WORDS.search(p)), "")
            company = next((p for p in pieces if p != title and p != location), "")
            if len(company) > 44 and " (" in company:  # a parenthetical blurb, not part of the name
                company = company.split(" (", 1)[0].strip()
            current = {"id": f"exp_{len(entries) + 1}", "company": company, "title": title,
                       "location": location, "start": start, "end": end, "current": is_current,
                       "context": "", "bullets": [], "tech": [], "keywords": [],
                       "company_phone": "",
                       "ref_name": "", "ref_last_name": "", "ref_phone": "", "ref_email": "",
                       "notes": "drafted from your resume by dry_run — check these dates"}
            entries.append(current)
            continue
        if current is None:
            continue
        if line.startswith("- ") and len(line) > 4:
            current["bullets"].append(line[2:][:400])
        elif (current["bullets"] and len(line) <= 200 and not DATE_RX.search(line)
              and not current["bullets"][-1].rstrip().endswith((".", "?", "!"))):
            # one resume line wrapped onto the next, not a new bullet
            current["bullets"][-1] = (current["bullets"][-1] + " " + line.lstrip("- ")).strip()[:400]
        elif 8 <= len(line) <= 400:
            current["bullets"].append(line[:400])
    for e in entries:
        e["bullets"] = e["bullets"][:8]
    return [e for e in entries if e["company"] or e["bullets"]]


DEGREE_RX = re.compile(
    r"\b(ph\.?d|doctor|master|m\.?s\.?c?|m\.?sc|mba|m\.?eng|b\.?s\.?c?|b\.?sc|b\.?a\.?|b\.?eng|"
    r"bachelor|associate|diploma|b\.?tech|m\.?tech)\b", re.I)


def parse_education(lines: list[str]) -> list[dict]:
    blk = section_block(lines, "education")
    if not blk:
        return []
    block = [l for l in lines[blk[0]:blk[1]] if l]
    # A three-column education block survives PDF extraction as word salad. School
    # names are exactly the kind of thing that must not be guessed: a wrong school
    # typed into a real application is worse than an empty one.
    wide = sum(1 for l in block if re.search(r"\s{2,}", l))
    if block and wide >= max(2, len(block) // 2):
        return []
    out: list[dict] = []
    for line in lines[blk[0]:blk[1]]:
        if not line or len(line) < 6:
            continue
        school = re.split(r",|\s[-–—]\s|\|", line)[0].strip(" .")
        degree, field = "", ""
        if m := DEGREE_RX.search(line):
            degree = re.sub(r"[\s.]+", " ", m.group(0)).strip().upper().replace(" ", "")
            field = re.sub(r"[,\s]*(?:19|20)\d{2}[,\s]*$", "", line[m.end():]).strip(" ,.-")[:120]
        year = re.findall(r"\b(?:19|20)\d{2}\b", line)
        out.append({"id": f"edu_{len(out) + 1}", "school": school[:120], "degree": degree,
                    "field": field, "start": "", "end": (year[-1] if year else ""), "location": "",
                    "notes": "drafted from your resume by dry_run — check"})
    schoolish = re.compile(r"universit|college|school|institute|polytechnic|academy|conservatory", re.I)
    keep = [e for e in out if e["school"] and schoolish.search(e["school"])]
    return keep[:6]


# ---------------------------------------------------------------------- report

def md_escape(s: str) -> str:
    return (s or "").replace("|", "\\|")


def table(rows: list[list[str]], header: list[str]) -> str:
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(md_escape(c) for c in r) + " |")
    return "\n".join(out)


def clip(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", str(s or ""))
    return s if len(s) <= n else s[: n - 1] + "…"


def main() -> int:
    ap = argparse.ArgumentParser(description="Dry run a real resume through FillDesk and write a review report.")
    ap.add_argument("--resume", required=True, help="path to resume: .pdf .docx .txt .md .rtf")
    ap.add_argument("--posting", help="text file with a real job posting to test against")
    ap.add_argument("--company", default="Sample Co")
    ap.add_argument("--title", default="")
    ap.add_argument("--port", type=int, default=config.DEFAULT_PORT)
    ap.add_argument("--keep-existing", action="store_true",
                    help="merge into your current profile instead of replacing it")
    ap.add_argument("--restore", metavar="BACKUP", help="restore a profile backup and exit")
    args = ap.parse_args()

    token_file = config.TOKEN_FILE
    backups = config.DATA_DIR / "backups"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    if args.restore:
        src = Path(args.restore)
        if not src.exists():
            print(f"no such backup: {src}")
            return 1
        shutil.copyfile(src, config.PROFILE_FILE)
        print(f"restored {config.PROFILE_FILE} from {src}")
        return 0

    src = Path(args.resume).expanduser()
    if not src.exists():
        print(f"no such file: {src}")
        return 1

    base, proc = ensure_server(pick_port(args.port))
    token = token_file.read_text().strip() if token_file.exists() else ""
    try:
        return run(args, src, base, token, stamp, backups)
    finally:
        if proc:
            proc.terminate()


def run(args, src: Path, base: str, token: str, stamp: str, backups: Path) -> int:
    # 1. read the resume
    extracted = resume_parse.extract_path(src)
    text = extracted.get("text", "")
    if len(text) < 120:
        print(f"could not read enough text from {src} ({extracted.get('warning') or 'no text layer'}). "
              "Export the resume to .docx or .txt, or paste it into the dashboard instead.")
        return 1

    # 2. back up and apply a profile drafted from it
    previous = store.load_profile()
    backup_path = None
    if config.PROFILE_FILE.exists():
        backups.mkdir(parents=True, exist_ok=True)
        backup_path = backups / f"profile-{stamp}.json"
        shutil.copyfile(config.PROFILE_FILE, backup_path)

    drafted = parse_resume(text)
    completeness_before = store.profile_completeness(previous)["score"]
    if args.keep_existing:
        patch = {"master_resume_markdown": text}
        for k, v in drafted.items():
            if k.startswith("_"):
                continue
            cur = previous.get(k)
            empty = (cur in ("", None, [])) if not isinstance(cur, dict) else not any(cur.values())
            if empty and v:
                patch[k] = v
        store.save_profile(patch)
    else:
        fresh = json.loads(json.dumps(store.DEFAULT_PROFILE))
        for k, v in drafted.items():
            if not k.startswith("_"):
                fresh[k] = v
        fresh["master_resume_markdown"] = text
        store.replace_profile(fresh)
    profile = store.load_profile()
    completeness_after = store.profile_completeness(profile)["score"]

    # 3. the posting to test against
    if args.posting:
        posting = Path(args.posting).expanduser().read_text(encoding="utf-8", errors="ignore")
        company, title = args.company, args.title or "the role"
    else:
        sys.path.insert(0, str(ROOT / "tools"))
        import seed_demo  # the two sample postings shipped with the tool

        demo = seed_demo.JOBS[0]
        posting = demo["description"]
        company, title = demo["company"], demo["title"]
    code, job = http(base, token, "POST", "/api/jobs",
                     {"company": company, "title": title, "description": posting, "source": "dry_run"})
    if code != 200:
        print(f"could not save the test posting: {job}")
        return 1
    job_id = job["id"]

    # 4. build and (for the test only) approve a packet
    code, packet = http(base, token, "POST", "/api/packets", {"job_id": job_id})
    if code != 200:
        print(f"packet build failed: {packet}")
        return 1
    packet_id = packet["id"]
    http(base, token, "POST", f"/api/packets/{packet_id}/approve", {"force": True})
    _, ats = http(base, token, "GET", f"/api/packets/{packet_id}/ats")
    _, status = http(base, token, "GET", "/api/status")

    # 5. the real matcher over a sample application form
    matcher = None
    node_error = ""
    try:
        res = subprocess.run(["node", "tools/simulate.mjs", "--json", base, packet_id],
                             cwd=str(ROOT), capture_output=True, text=True, timeout=120)
        if res.returncode == 0 and res.stdout.strip():
            matcher = json.loads(res.stdout.strip().splitlines()[-1])
        else:
            node_error = (res.stderr or res.stdout).strip()[:400]
    except FileNotFoundError:
        node_error = "node is not installed, so the browser-free matcher run was skipped"
    except Exception as exc:  # noqa: BLE001
        node_error = str(exc)[:400]

    report = build_report(args, src, extracted, text, drafted, previous, profile,
                          completeness_before, completeness_after, job, packet, ats,
                          status, matcher, node_error, backup_path)
    out_dir = ROOT / "reports"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"dry-run-{stamp}.md"
    out_path.write_text(report, encoding="utf-8")

    t = (matcher or {}).get("tally", {})
    print(f"\nresume:      {src.name}  ({extracted['method']}, {extracted['chars']:,} chars extracted)")
    print(f"profile:     {completeness_before}% -> {completeness_after}% complete, no LLM key needed"
          if status["llm"]["provider"] == "none" else
          f"profile:     {completeness_before}% -> {completeness_after}% complete (model: {status['llm']['provider']})")
    print(f"packet:      {packet_id} for {company} — {title}")
    if matcher:
        print(f"sample form: {t.get('fill', 0)} filled ({sum(1 for r in matcher['rows'] if r['review'])} to verify), "
              f"{t.get('upload', 0)} uploads, {t.get('block', 0)} refused, {t.get('skip', 0)} left alone")
    else:
        print(f"sample form: skipped — {node_error}")
    print(f"\nreport:      {out_path}")
    if backup_path:
        print(f"undo:        python3 tools/dry_run.py --resume x --restore {backup_path}")
    print()
    return 0


def build_report(args, src, extracted, text, drafted, previous, profile, before, after,
                 job, packet, ats, status, matcher, node_error, backup_path) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    gaps = drafted["_gaps"][:]
    answers = packet.get("answers", [])
    blank = [a for a in answers if "[NEEDS INPUT]" in (a.get("answer") or "") or a.get("needs_input")]
    real = [a for a in answers if a not in blank]
    letter = packet.get("cover_letter", {}).get("text", "")
    resume_md = packet.get("resume", {}).get("markdown", "")
    fit = packet.get("resume", {}).get("fit", {}) or resume_export.fit_note(resume_md)
    flags = packet.get("needs_input_flags") or resume_export.needs_input_flags(letter + "\n" + resume_md)

    parts = [f"# FillDesk dry run — {now}", ""]
    parts += [
        f"Source: `{src}` — read as **{extracted['method']}**, {extracted['chars']:,} characters extracted"
        + (f". Warning: {extracted['warning']}" if extracted.get("warning") else "."),
        "",
        f"Posting used: **{job.get('company')} — {job.get('title')}**"
        + (" (the sample posting shipped with the tool, so keyword overlap is expected to be "
           "poor; pass `--posting your_jd.txt` to test a real one)." if job.get("source") == "dry_run" else " (yours).")
        + "  ",
        f"Model: **{status['llm']['provider']}**"
        + (" — rule-based drafting, nothing left this machine." if status["llm"]["provider"] == "none"
           else f" ({status['llm']['model']}) — the packet text below passed through that provider."),
        "",
        "## 1. Headline", "",
        f"- profile completeness: **{before}% → {after}%** from the resume alone",
        f"- roles parsed: **{sum(1 for e in profile.get('experience', []) if e.get('company') or e.get('bullets'))}**, "
        f"education entries: **{sum(1 for e in profile.get('education', []) if e.get('school'))}**, "
        f"skills: **{len(profile.get('skills', []))}**, bullets carried over: **{sum(len(e.get('bullets', [])) for e in profile.get('experience', []))}**",
        f"- employer questions in the posting: **{len(answers)}**, of which **{len(real)}** have real content and **{len(blank)}** are flagged `[NEEDS INPUT]`",
        f"- the tailored resume: {fit.get('note') or f'{resume_export.word_count(resume_md)} words'}",
        "",
    ]

    if matcher:
        t = matcher["tally"]
        verify = sum(1 for r in matcher["rows"] if r["review"])
        parts += [
            f"On the sample application form ({len(matcher['rows'])} controls): "
            f"**{t['fill']} filled** ({verify} flagged for you to check), **{t['upload']} documents attached**, "
            f"**{t['block']} refused outright**, **{t['skip']} deliberately left alone**.",
            "",
        ]
    else:
        parts += [f"Matcher dry run skipped: {node_error}", ""]

    parts += [
        "Nothing submitted anything. The extension has no submit code at all, and this run never",
        "opened a browser or contacted a job site.",
        "",
        "## 2. What it read off your resume", "",
    ]
    rows = []
    for key in ("name", "email", "phone", "location", "headline", "summary", "skills", "links", "experience", "education"):
        src_note = drafted["_sources"].get(key, "")
        value = profile.get(key, "")
        if isinstance(value, dict):
            value = ", ".join(v for v in value.values() if v)
        elif key == "experience":
            value = "; ".join(f"{e.get('company', '?')} ({e.get('title', '?')}, {e.get('start', '?')}–{e.get('end', 'now')})"
                              for e in value[:3])
        elif key == "education":
            value = "; ".join(f"{e.get('school', '?')} {e.get('degree', '')} {e.get('field', '')}".strip()
                              for e in value[:3])
        elif isinstance(value, list):
            value = ", ".join(str(v) for v in value[:8]) + ("…" if len(value) > 8 else "")
        elif key == "summary":
            value = clip(value, 200)
        if value:
            rows.append([key, clip(value, 200), clip(src_note, 60)])
    parts += [table(rows, ["field", "value FillDesk will use", "where it came from"]), ""]

    if any(e.get("company") or e.get("bullets") for e in profile.get("experience", [])):
        parts += ["### Drafted work history — check these", "",
                  table([[e.get("company") or "?", e.get("title") or "?", e.get("start") or "?",
                          e.get("end") or "",
                          f"{len(e.get('bullets', []))} bullet" + ("s" if len(e.get('bullets', [])) != 1 else "")]
                         for e in profile["experience"] if e.get("company") or e.get("bullets")],
                        ["company", "title", "start", "end", "detail"]), "",
                  "Dates and company/title splits are guesses from the text layout. Fix them in **Profile** "
                  "before real use — a wrong date typed into a real application is the failure mode this tool "
                  "is built to make impossible.", ""]

    parts += ["## 3. What it could not work out", ""]
    if not gaps:
        parts.append("Nothing major. Still read section 2.")
    else:
        parts += [f"- {g}" for g in gaps]
    if not profile.get("boilerplate") or not any(b.get("text") for b in profile.get("boilerplate", [])):
        parts += ["- **no reusable answers yet.** The five questions almost every application asks "
                  "(*why this company, a challenge, why leaving, a project you shipped, your weakness*) "
                  "are the difference between a packet and a template. Twenty minutes in Profile fixes "
                  f"{len(blank)} of the {len(answers)} blank answers below."]
    parts += ["", "## 4. Tailored resume for this posting", "",
              f"Keyword coverage: **{ats.get('coverage_percent', 0)}%** of the posting's recurring terms "
              "appear in your tailored resume. This is a word-presence check, not an ATS score — "
              "no vendor can honestly give you a real one, they are per-tenant and undocumented.", ""]
    def term_of(m):
        return m.get("term") if isinstance(m, dict) else m

    def count_of(m):
        return f" ×{m.get('in_job')}" if isinstance(m, dict) and m.get("in_job") else ""

    missing = [(term_of(m), count_of(m)) for m in (ats.get("missing_frequent") or []) + (ats.get("missing_phrases") or []) if term_of(m)]
    if missing:
        parts += ["Absent from your resume — real gaps to decide on, never to stuff. "
                  "The number is how often the posting repeats it: "
                  + ", ".join(f"`{t}`{c}" for t, c in missing[:18]), ""]
    parts += ["```markdown", resume_md[:5200], "```", ""]

    parts += ["## 5. Cover letter", "", "```text", letter[:3200], "```", ""]

    parts += ["## 6. Employer questions", ""]
    if answers:
        parts += [table([[clip(a.get("question"), 90),
                          "needs input" if a in blank else ("your wording" if a.get("source") == "boilerplate" else a.get("source", "drafted")),
                          clip(a.get("answer"), 220)] for a in answers],
                         ["question", "source", "what would be typed"]), ""]
    else:
        parts += ["No questions were found in the posting text. On a real application page the extension "
                  "reads the visible form, which catches more than the posting text does.", ""]

    parts += ["## 7. What the extension would do on the form", ""]
    if matcher:
        verbs = {"fill": "fill", "upload": "attach", "block": "REFUSE", "skip": "leave alone"}
        parts += [table(
            [[clip(r["label"], 46), verbs[r["action"]],
              ("⚠ verify: " if (r["review"] and r["action"] == "fill") else "")
              + clip(r["value"] or r["category"] or r["reason"], 90)]
             for r in matcher["rows"]],
            ["field on the form", "action", "value / reason"]), ""]
        blocked = [r for r in matcher["rows"] if r["action"] == "block"]
        if blocked:
            parts += ["**Refused, by design — you answer these yourself:** "
                      + ", ".join(sorted({r["category"] for r in blocked}))
                      + ". These are protected-class, work-authorization, age, health and attestation "
                      "questions. There is no setting to turn this off, because an autofilled wrong answer "
                      "here is not a typo, it is a problem.", ""]
        uploads = [r for r in matcher["rows"] if r["action"] == "upload"]
        if uploads:
            parts += ["Documents it would attach: " + ", ".join(
                "cover letter" if r["value"] == "cover_letter" else "resume" for r in uploads)
                + " (from the approved packet, as .docx).", ""]
    else:
        parts += [f"Skipped: {node_error}", ""]

    if flags:
        parts += ["## 8. Open placeholders in the packet", "",
                  f"{len(flags)} placeholder(s) in the drafted text. Autofill refuses to type any field whose "
                  "approved text still holds one, even on a forced approval:", "",
                  *[f"- `{f}` ×{flags.count(f)}" for f in dict.fromkeys(flags)], ""]

    parts += ["## 9. Undo", ""]
    if backup_path:
        parts += [f"Your previous profile is at `{backup_path}`.", "",
                  "```bash", f"python3 tools/dry_run.py --resume {src} --restore {backup_path}", "```", "",
                  "Or edit everything in the dashboard: **Profile** — nothing here is irreversible."]
    else:
        parts.append("No previous profile existed, so nothing to restore.")
    parts.append("")
    parts.append("*Generated by `tools/dry_run.py`. No job site was contacted and no form was submitted.*")
    return "\n".join(parts)


if __name__ == "__main__":
    raise SystemExit(main())
