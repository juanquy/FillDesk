"""Application packet = tailored resume + cover letter + answers to employer questions.

Two builders:
  build_with_llm()     -- uses whatever model you configured
  build_with_rules()   -- pure Python: template + keyword re-ranking + your boilerplate.
                          Exists so the tool is useful with zero API keys.

Both paths enforce the same invariants, in code rather than in a prompt:
  * blocked questions are never drafted (see sensitive.py)
  * anything the writer is unsure about is marked needs_input, not invented
  * you approve the packet before the extension will use it
"""
from __future__ import annotations

import difflib
import re
from typing import Any

from . import config, llm, resume_export, sensitive, store

BLOCKED_ANSWER = "\u26d4 FillDesk will not answer this. It is a compliance or protected-class question and must reflect only your own circumstances."
UNKNOWN = "[NEEDS INPUT]"

_QUESTION_SPLIT = re.compile(r"(?<=[.?!])\s+|(?<=[.?!])\n|\n{2,}")


# --------------------------------------------------------------------------- profile text


def experience_bullets(exp: dict) -> list[str]:
    return [b for b in (exp.get("bullets") or []) if str(b).strip()]


def profile_plain_text(profile: dict) -> str:
    parts = [
        profile.get("name", ""),
        profile.get("headline", ""),
        profile.get("summary", ""),
        " ".join(profile.get("skills") or []),
    ]
    for exp in profile.get("experience", []):
        parts.append(" ".join([exp.get("title", ""), exp.get("company", ""), exp.get("context", "")]))
        parts.extend(experience_bullets(exp))
    for edu in profile.get("education", []):
        parts.append(" ".join(str(edu.get(k, "")) for k in ("school", "degree", "field")))
    parts.append(profile.get("master_resume_markdown", ""))
    for b in profile.get("boilerplate", []):
        parts.append(f"{b.get('label','')}: {b.get('text','')}")
    return sensitive.normalize(" \n ".join(p for p in parts if p))


def profile_brief(profile: dict, limit: int = 9000) -> str:
    """Compact, token-cheap profile digest for the model."""
    lines: list[str] = []
    a = lines.append
    a(f"NAME: {profile.get('name') or UNKNOWN}")
    a(f"HEADLINE: {profile.get('headline') or profile.get('target_title') or UNKNOWN}")
    a(f"LOCATION: {profile.get('location') or UNKNOWN}   EMAIL: {profile.get('email') or UNKNOWN}   PHONE: {profile.get('phone') or UNKNOWN}")
    links = {k: v for k, v in (profile.get("links") or {}).items() if v}
    if links:
        a("LINKS: " + ", ".join(f"{k}={v}" for k, v in links.items()))
    if profile.get("summary"):
        a(f"SUMMARY: {profile['summary']}")
    if profile.get("skills"):
        a("SKILLS: " + ", ".join(profile["skills"][:40]))
    if profile.get("certifications"):
        a("CERTIFICATIONS: " + ", ".join(profile["certifications"][:15]))
    if profile.get("languages"):
        a("LANGUAGES: " + ", ".join(profile["languages"][:10]))
    if profile.get("salary_expectation"):
        a(f"SALARY EXPECTATION (answer only if asked, user must verify): {profile['salary_expectation']}")
    if profile.get("relocation"):
        a(f"RELOCATION: {profile['relocation']}")
    a("\nEXPERIENCE:")
    for exp in profile.get("experience", []):
        if not isinstance(exp, dict) or not (exp.get("company") or exp.get("title")):
            continue
        span = f"{exp.get('start','?')} - {exp.get('end') or ('Present' if exp.get('current') else '?')}"
        a(f"  * {exp.get('title')} @ {exp.get('company')} ({span}) {exp.get('location','')}")
        if exp.get("context"):
            a(f"      context: {exp['context']}")
        for b in experience_bullets(exp)[:12]:
            a(f"      - {b}")
        if exp.get("tech"):
            a(f"      tech: {', '.join(exp['tech'][:20]) if isinstance(exp['tech'], list) else exp['tech']}")
    a("\nEDUCATION:")
    for edu in profile.get("education", []):
        if isinstance(edu, dict) and (edu.get("school") or edu.get("degree")):
            a(f"  * {edu.get('degree','')} {edu.get('field','')} - {edu.get('school','')} ({edu.get('start','')}-{edu.get('end','')})")
    for prj in profile.get("projects", []):
        if isinstance(prj, dict) and prj.get("name"):
            a(f"PROJECT: {prj['name']} - {prj.get('description','')}")
    has_boiler = [b for b in profile.get("boilerplate", []) if isinstance(b, dict) and (b.get("text") or "").strip()]
    if has_boiler:
        a("\nYOUR OWN REUSABLE ANSWERS (prefer these verbatim where they fit):")
        for b in has_boiler:
            a(f"  Q: {b.get('label')}\n  A: {b['text']}")
    if profile.get("master_resume_markdown"):
        a("\nMASTER RESUME (markdown):\n" + profile["master_resume_markdown"][:4500])
    return "\n".join(lines)[:limit]


def resume_markdown(profile: dict) -> str:
    """Canonical resume text: the user's master resume if present, else synthesized."""
    md = (profile.get("master_resume_markdown") or "").strip()
    if md:
        return md
    lines = [f"# {profile.get('name') or 'Your Name'}", ""]
    contact = " | ".join(x for x in [profile.get("email"), profile.get("phone"), profile.get("location")] if x)
    if contact:
        lines += [contact, ""]
    if profile.get("summary"):
        lines += [profile["summary"], ""]
    if profile.get("experience"):
        lines += ["## Experience", ""]
        for exp in profile["experience"]:
            if not isinstance(exp, dict) or not exp.get("company"):
                continue
            span = f"{exp.get('start','')} \u2013 {exp.get('end') or ('Present' if exp.get('current') else '')}".strip(" \u2013")
            lines.append(f"### {exp.get('title','')} \u2014 {exp.get('company','')}  ({span})")
            for b in experience_bullets(exp):
                lines.append(f"- {b}")
            lines.append("")
    if profile.get("skills"):
        lines += ["## Skills", ", ".join(profile["skills"]), ""]
    if profile.get("education"):
        lines += ["## Education", ""]
        for edu in profile.get("education", []):
            if isinstance(edu, dict) and (edu.get("school") or edu.get("degree")):
                lines.append(f"- **{edu.get('degree','')} {edu.get('field','')}** — {edu.get('school','')} ({edu.get('start','')}–{edu.get('end','')})")
    if profile.get("certifications"):
        lines += ["", "## Certifications", ", ".join(profile["certifications"])]
    return "\n".join(lines).strip()


# --------------------------------------------------------------------------- job digest


# Words that recur in postings but say nothing about the job. Without this filter
# the "their posting emphasises …" line fills up with "end", "work", "team".
_GENERIC = set(
    """work working worked end ends yourself our you your will with that this have has from they
    their about other most more such than when where which what who how why all any been being
    some also into over under across within including looks like role roles position positions
    candidate candidates applicant team teams time times full part new great strong excellent
    plus nice must level things thing day days year years experience experienced skill skills
    ability able both each per etc business hire hiring looking join joining ideal company
    companies requirements responsibilities benefits nice""".split()
)


def job_keywords(job: dict, limit: int = 45) -> list[str]:
    text = f"{job.get('title','')} {job.get('description','')}"
    counts: dict[str, int] = {}
    for raw in re.findall(r"[A-Za-z][A-Za-z+#./-]{2,}", text):
        w = raw.strip(".-/")
        lw = w.lower()
        if len(w) < 3 or lw in resume_export._STOPWORDS or lw in _GENERIC:
            continue
        counts[lw] = counts.get(lw, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [w for w, _ in ranked][:limit]


def extract_questions(job: dict, extra: list[str] | None = None) -> list[str]:
    """Employer questions from the saved description + anything the extension scraped live."""
    found: list[str] = []

    def add(candidate: str) -> None:
        q = sensitive.normalize(candidate)
        if len(q) < 8 or len(q) > 420:
            return
        if not sensitive.is_question_like(q):
            return
        if any(difflib.SequenceMatcher(None, q.lower(), f.lower()).ratio() > 0.86 for f in found):
            return
        found.append(q)

    for q in (job.get("questions") or []):
        add(str(q))
    for q in (extra or []):
        add(str(q))
    desc = job.get("description") or ""
    for sentence in _QUESTION_SPLIT.split(desc):
        add(sentence)
    return found[:40]


def job_brief(job: dict, limit: int = 7000) -> str:
    return "\n".join(
        [
            f"TITLE: {job.get('title') or UNKNOWN}",
            f"COMPANY: {job.get('company') or UNKNOWN}",
            f"LOCATION: {job.get('location') or UNKNOWN}",
            f"TYPE: {job.get('employment_type') or UNKNOWN}   POSTED: {job.get('posted') or UNKNOWN}   PAY: {job.get('salary') or UNKNOWN}",
            f"SOURCE URL: {job.get('url') or UNKNOWN}",
            "\nJOB DESCRIPTION:\n" + (job.get("description") or "")[:limit],
        ]
    )


# --------------------------------------------------------------------------- rules builder

_SKILLISH = re.compile(r"^(sql|python|java|javascript|typescript|react|node|aws|gcp|azure|docker|kubernetes|terraform|figma|excel|tableau|salesforce|hubspot|snowflake|dbt|git|c\+\+|c#|go|rust|r|matlab|sap|wordpress|photoshop|illustrator|solidworks|autocad|osha|hipaa|quickbooks|xero|jira|confluence|scrum|kanban|six sigma|pmp|cpa|gaap|cad|bim|revit|qc|pmp)$", re.I)


def best_bullet(bullets: list[str], keywords: list[str]) -> tuple[str, int]:
    """Highest keyword overlap wins. Ties break on earlier bullet."""
    scored = []
    for i, b in enumerate(bullets):
        low = b.lower()
        score = sum(low.count(k) * (2 if _SKILLISH.match(k) else 1) for k in keywords)
        score += min(len(b.split()) / 40, 1)  # prefer a substantive line over a stub
        scored.append((score, i, b))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return (scored[0][2], int(scored[0][0])) if scored else ("", 0)


def tailor_resume_with_rules(profile: dict, job: dict, keywords: list[str]) -> tuple[str, list[str]]:
    md = resume_markdown(profile)
    notes: list[str] = []
    if not (profile.get("master_resume_markdown") or "").strip():
        notes.append("Built from your structured profile; no master resume on file.")
        return md, notes + [f"{UNKNOWN} review the layout before exporting."]

    target = job.get("title") or profile.get("target_title") or ""
    lines = md.split("\n")
    out: list[str] = []
    for line in lines:
        new = line
        if re.match(r"^#{1,2}\s", line) and target and re.search(r"\b(engineer|manager|analyst|designer|developer|scientist|specialist|coordinator|director|lead|consultant|account|representative|teacher|nurse|technician)\b", target, re.I):
            new = re.sub(r"\b(senior |lead |principal )?" + r"(software engineer|data analyst|product manager|product designer|project manager|marketing manager)\b", target.lower(), line, flags=re.I)
        out.append(new)
    md = "\n".join(out)

    # Re-order bullets so role-relevant evidence comes first, but only inside one
    # contiguous run of them. Re-ordering a whole section pulls bullets away from the
    # company header above them, which reads as if you did someone else's work -- and
    # silently drops the headers for the other roles.
    def score(line: str) -> int:
        low = line.lower()
        return sum(low.count(k) * (2 if _SKILLISH.match(k) else 1) for k in keywords)

    lines_md = md.split("\n")
    rebuilt: list[str] = []
    moved = 0
    bullet_rx = re.compile(r"^\s*[-*•]\s+.+$")
    i = 0
    while i < len(lines_md):
        if not bullet_rx.match(lines_md[i]):
            rebuilt.append(lines_md[i])
            i += 1
            continue
        j, group = i, []
        while j < len(lines_md):
            if bullet_rx.match(lines_md[j]):
                group.append(lines_md[j])
                j += 1
            elif not lines_md[j].strip() and j + 1 < len(lines_md) and bullet_rx.match(lines_md[j + 1]):
                j += 1  # a blank line inside one run of bullets
            else:
                break
        if len(group) >= 3:
            ranked = sorted(range(len(group)), key=lambda n: (-score(group[n]), n))
            if ranked != list(range(len(group))):
                moved += 1
            rebuilt.extend(group[n] for n in ranked)
        else:
            rebuilt.extend(group)
        i = j
    md = "\n".join(rebuilt).strip()

    hits = [k for k in keywords[:25] if k in md.lower()]
    misses = [k for k in keywords[:25] if k not in md.lower()]
    notes.append(f"Re-ordered bullet groups by relevance to: {', '.join(keywords[:8])}.")
    if hits:
        notes.append(f"Job terms already present in your resume: {', '.join(hits[:12])}.")
    if misses:
        notes.append(f"{UNKNOWN} job terms absent from your resume — only add them if genuinely true: {', '.join(misses[:12])}.")
    notes.append(f"Bullet groups reordered: {moved}.")
    return md, notes


def cover_letter_with_rules(profile: dict, job: dict, keywords: list[str]) -> str:
    name = profile.get("name") or "[YOUR NAME]"
    company = job.get("company") or "[COMPANY]"
    title = job.get("title") or "[ROLE]"
    exp = [e for e in profile.get("experience", []) if isinstance(e, dict) and experience_bullets(e)]
    top_bullets = []
    for e in exp[:3]:
        b, _ = best_bullet(experience_bullets(e), keywords)
        if b:
            top_bullets.append((e.get("title", ""), e.get("company", ""), b))
    # "the X role over 10 years" reads like a broken sentence; state the fact plainly.
    starts = [e.get("start", "") for e in profile.get("experience", []) if isinstance(e, dict) and e.get("start")]
    yrs = [int(m.group(1)) for s in starts for m in [re.search(r"((?:19|20)\d{2})", str(s))] if m]
    since = f" I have worked in the field since {min(yrs)}." if yrs else ""
    opening = (f"I am applying for the {title} role at {company}.{since} "
               + (profile.get("summary") or f"{UNKNOWN} one sentence on why this role at {company} specifically, not just any {title} role."))

    lines = [
        f"Dear {company} hiring team,",
        "",
        opening,
        "",
    ]
    if top_bullets:
        lines.append("Three things I would bring to this team:")
        for role, org, bullet in top_bullets:
            lines.append(f"- {bullet} ({role}, {org})")
        lines.append("")
    skill_hits = [k for k in keywords[:20] if k in profile_plain_text(profile).lower()]
    if skill_hits:
        lines.append(f"Your posting emphasises {', '.join(skill_hits[:6])} — that matches my day-to-day work, and I would be glad to go deeper on any of it.")
        lines.append("")
    lines += [
        f"{UNKNOWN} one specific, true reason you want {company} (their product, market, stage, or a time you used it). Recruiters read this line.",
        "",
        f"Thank you for your time.\n\n{name}",
        f"{profile.get('email','')} | {profile.get('phone','')} | {profile.get('links',{}).get('linkedin','')}",
    ]
    return "\n".join(lines).strip()


# Employer questions are reworded constantly, but the *intent* is one of about a
# dozen shapes. Matching on intent beats string similarity for reusing saved answers.
INTENTS: list[tuple[str, str]] = [
    # Order matters: the specific shapes must be tested before the generic
    # "Why <Company>?" fallback, or that fallback swallows them.
    ("why_leaving", r"\b(leaving|left (your|last|current)|why are you (looking|searching)|reason for (leaving|searching)|why (did you )?(leave|quit)|want to (leave|move on|make a change)|looking for (a |the )?(new|next|different))"),
    ("weakness", r"\b(weakness|area of (improvement|growth)|constructive feedback|thing to improve)"),
    ("challenge", r"\b(challenge|conflict|disagree|disagreement|failure|failed|mistake|setback|obstacle|hardest|difficult situation|toughest)"),
    ("strength", r"\b(greatest strength|superpower|what do you bring|core strength|key strength)"),
    ("compensation", r"\b(salar|compensation|desired pay|expected (pay|compensation)|rate expectation)"),
    ("start_availability", r"\b(start date|when (could|can) you start|available (from|to start)|notice period)"),
    ("work_auth", r"\b(authoriz|sponsor|citizen|visa|work permit|employment eligibility)"),
    ("references", r"\b(reference|referee|recommender)"),
    ("relocation", r"\b(relocat|willing to move|onsite|on-site|travel)"),
    ("prioritization", r"\b(prioriti[sz]|juggl|multitask|manage (your )?time|deadlines|decide what to work on|backlog)"),
    ("goals", r"\b(five years|5 years|career (goal|objective|plan)|where do you (see|want)|long.term|what next)"),
    ("gap", r"\b(employment gap|gap in (your )?(employment|resume)|unemployed|between roles)"),
    ("leadership", r"\b(lead(ing|ership)?|manage|manager|mentor|influence without|direct a team|cross[- ]functional)"),
    ("project", r"\b(project|ship(ped|ping)?|accomplish|proud of|portfolio piece|end.to.end|launch)"),
    ("learn", r"\b(learn(ed|ing)? (a|new)|upskill|feedback you (received|took)|how do you grow)"),
    ("remote_work", r"\b(remote|hybrid|distributed team|async|time ?zone|home office)"),
    ("culture", r"\b(culture|values|work environment|ideal (team|workplace)|work style|collaborat)"),
    ("diversity_story", r"\b(belong(ing)?|identity|background of your|first in family)"),
    ("experience", r"\b(experience with|background in|how (much|familiar)|years of|familiarity|proficien)"),
    ("why_company", r"\b(why (do you )?(want|apply|interested|this company|us\b|our team|join)|what interests you|why should we|why (?!a |an |the |are |do |did |would |you |not |would n)[A-Za-z][A-Za-z0-9&.'-]+)"),
]
_INTENT_COMPILED = [(name, re.compile(p, re.I)) for name, p in INTENTS]


def intent(text: str) -> str:
    for name, rx in _INTENT_COMPILED:
        if rx.search(text or ""):
            return name
    return ""


_BOILER_STOP = set("""a an and are as at be been but by for from had has have how i in into is it its me more most my no not of on or our so than that the their them there these this those to too was we were what when where which who why will with would you your about after before please tell describe share us role position company job work working years year""".split())


def content_words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]{4,}", (text or "").lower()) if w not in _BOILER_STOP}


def match_boilerplate(question: str, profile: dict, job: dict | None = None) -> tuple[dict | None, float]:
    """Pick the saved answer that genuinely belongs to this question.

    String similarity alone is dangerous: "What is your salary expectation?" and
    "Why are you leaving?" are 45% identical characters and completely different
    answers. So a match needs a shared intent, a shared content word, or near-identical
    wording.
    """
    q = (question or "").lower()
    q_intent = intent(question)
    q_words = content_words(question)
    company = ((job or {}).get("company") or "").strip().lower()
    best, score = None, 0.0
    wants_employer = config.employer_specific(question)
    for b in profile.get("boilerplate", []):
        if not isinstance(b, dict) or not (b.get("text") or "").strip():
            continue
        label = (b.get("label") or "").lower()
        text = (b.get("text") or "")

        if wants_employer:
            # Reusing generic prose here is the failure this whole path exists to avoid.
            # It is allowed only when the saved answer was written for this employer: its
            # text names them, or its label is scoped ("Why this company? - Stripe").
            scoped = config.scoped_company(b.get("label") or "")
            if company and scoped and (scoped in company or company in scoped):
                return b, 0.9
            if company and company in text.lower():
                return b, 0.85
            continue

        l_words = content_words(label)
        shared = q_words & l_words
        ratio = difflib.SequenceMatcher(None, q, label).ratio()
        s = 0.0
        # Shared intent carries a match only when the label has a topic word to hang it
        # on. "Why this company?" has none -- why, this and company are all stop words --
        # so intent was the only signal, and it fired at 0.75 for every motivation
        # question in existence.
        if q_intent and q_intent == intent(label) and (l_words or shared or ratio >= 0.55):
            s = 0.75
        if shared:
            s = max(s, min(0.8, 0.4 + 0.15 * len(shared)))
        if ratio >= 0.6:
            s = max(s, ratio)
        if s > score:
            best, score = b, s
    return (best, round(score, 2)) if score >= 0.45 else (None, round(score, 2))


def draft_answer_with_rules(question: str, profile: dict, job: dict, keywords: list[str]) -> dict:
    blocked = sensitive.blocked_reason(question)
    if blocked:
        return {"answer": BLOCKED_ANSWER, "source": "blocked", "confidence": 0.0, "needs_input": True, "blocked": True, **blocked}

    boiler, score = match_boilerplate(question, profile, job)
    review = sensitive.review_reason(question)
    if boiler and score >= 0.45:
        ans = boiler["text"].strip()
        return {
            "answer": ans,
            "source": "boilerplate",
            "confidence": min(0.85, 0.45 + score / 2),
            "needs_input": False,
            "blocked": False,
            "note": f"Matched your saved answer '{boiler.get('label')}' ({int(score*100)}% fit). Read it against this specific employer before sending.",
            **({"review": review} if review else {}),
        }

    if review and review["category"] == "salary" and profile.get("salary_expectation"):
        return {"answer": str(profile["salary_expectation"]), "source": "profile", "confidence": 0.6, "needs_input": True, "blocked": False, "review": review, "note": "From your profile's salary expectation — verify it for this level and market."}

    exp = [e for e in profile.get("experience", []) if isinstance(e, dict) and experience_bullets(e)]
    relevant = []
    for e in exp[:4]:
        b, sc = best_bullet(experience_bullets(e), keywords)
        if b and sc > 0:
            relevant.append((e, b, sc))
    relevant.sort(key=lambda t: -t[2])
    fell_back = False
    if not relevant and exp:
        # No keyword overlap at all: still better to quote your own most substantive
        # line than to hand the user a blank box.
        bullets = sorted(experience_bullets(exp[0]), key=lambda b: -len(b))
        if bullets:
            relevant.append((exp[0], bullets[0], 0))
            fell_back = True

    parts = [f"{UNKNOWN} personalise. Skeleton from your own material:"]
    if relevant:
        e, b, _ = relevant[0]
        parts.append(f"Lead with the {e.get('company')} result: \u201c{b}\u201d")
        if len(relevant) > 1:
            parts.append(f"Second point from {relevant[1][0].get('company')}: \u201c{relevant[1][1]}\u201d")
    else:
        parts.append("Pick one specific project with a measurable outcome.")
    parts.append("Structure: situation (1 sentence) → what you personally did (2) → measurable result (1) → what it means for them (1).")
    if keywords:
        parts.append(f"Tie it to their language where it is true for you: {', '.join(keywords[:6])}.")
    if fell_back:
        parts.append("(Nothing above matched this question by keyword - it is offered as raw material only.)")
    return {
        "answer": " ".join(parts),
        "source": "skeleton",
        "confidence": 0.2,
        "needs_input": True,
        "blocked": False,
        "note": "No saved answer matched, and no model is configured, so this is an outline rather than a draft.",
        **({"review": review} if review else {}),
    }


def build_with_rules(profile: dict, job: dict, questions: list[str]) -> dict:
    keywords = job_keywords(job)
    md, notes = tailor_resume_with_rules(profile, job, keywords)
    letter = cover_letter_with_rules(profile, job, keywords)
    answers = []
    for q in questions:
        a = draft_answer_with_rules(q, profile, job, keywords)
        answers.append({"question": q, **a})
    return {
        "resume_markdown": md,
        "resume_changes": notes,
        "cover_letter": letter,
        "answers": answers,
        "keywords": keywords,
        "method": "rules",
    }


# --------------------------------------------------------------------------- LLM builder

SYSTEM = """You are an expert resume writer and application strategist writing on behalf of a real job seeker.

ABSOLUTE RULES
1. NEVER invent an employer, job title, date, credential, metric, award, technology, or achievement that is not in the candidate profile. A blank beats a fabrication.
2. When something is required but absent from the profile, write the literal token [NEEDS INPUT] where the gap is, and set needs_input true for that answer.
3. You may re-word, re-order, re-emphasise, and re-frame what the profile states. You may not add facts.
4. Never use em-dash-heavy AI phrasing, "I am excited", "leverage", "spearhead", "results-driven", or adjective stacking. Write like a competent human: plain verbs, concrete nouns, numbers where the profile has them.
5. Compliance questions (race, ethnicity, gender, religion, sexual orientation, disability, veteran status, work authorization, citizenship, sponsorship, age/date of birth, arrests or convictions, any attestation or signature) must NOT be drafted. Return blocked=true and an empty answer for those, whatever else the user asks.
6. Cover letter: 180-260 words, addressed to the company by name, opening line specific and true, two evidence points drawn verbatim-in-fact from the profile, no preamble, no "Dear Hiring Manager" unless the company is unknown.
7. Resume: single column, markdown, one page (~450-550 words), headings exactly: # NAME, ## Summary, ## Experience, ## Skills, ## Education. Keep every claim traceable to the profile.
8. Answers to employer questions: 60-140 words each unless the question clearly wants a number or yes/no. Answer the question that was actually asked.
9. Never state or imply the candidate's work authorization, citizenship, visa or sponsorship status, age, date of birth, health, disability, veteran status, race, ethnicity, religion, sex, sexual orientation, marital status, criminal record, or any certification/attestation -- not even if the profile seems to imply it (a home address or a language is NOT evidence of any of these). Those statements belong to the candidate alone. If a document genuinely needs one, write [NEEDS INPUT] there instead.

Return ONLY a JSON object, no prose, matching exactly:
{
  "resume_markdown": string,
  "resume_changes": [string],          // what you changed vs the master resume, and why
  "cover_letter": string,
  "answers": [
    {"question": string, "answer": string, "source": "profile|boilerplate|inferred|blocked|none",
     "confidence": number 0..1, "needs_input": boolean, "blocked": boolean, "note": string}
  ]
}"""


def build_with_llm(profile: dict, job: dict, questions: list[str], settings: dict) -> tuple[dict, dict]:
    cfg = llm.resolve(settings)
    keywords = job_keywords(job)
    blocked_map = {q: sensitive.blocked_reason(q) for q in questions}
    user = "\n\n".join(
        [
            "CANDIDATE PROFILE\n" + profile_brief(profile),
            job_brief(job),
            "EMPLOYER QUESTIONS (answer each, in this order; return the question text unchanged)\n"
            + "\n".join(f"{i+1}. {q}" for i, q in enumerate(questions))
            or "(none found)",
            f"RESUME TARGET: {config.load_settings().get('packets',{}).get('resume_pages',1)} page, ATS-safe single column.",
            f"JOB KEYWORDS WORTH COVERING (only where genuinely true for the candidate): {', '.join(keywords[:30])}",
        ]
    )
    raw = llm.complete(SYSTEM, user, expect_json=True, settings=settings)
    if isinstance(raw, list):
        raw = raw[0] if raw and isinstance(raw[0], dict) else {}
    out = {
        "resume_markdown": str(raw.get("resume_markdown") or "").strip(),
        "resume_changes": [str(x) for x in (raw.get("resume_changes") or [])][:12],
        "cover_letter": str(raw.get("cover_letter") or "").strip(),
        "answers": [],
        "keywords": keywords,
        "method": "llm",
        "llm": {"provider": cfg["provider"], "model": cfg["model"]},
    }
    by_question = {}
    for a in raw.get("answers") or []:
        if isinstance(a, dict) and a.get("question"):
            by_question[sensitive.normalize(a["question"]).lower()] = a
    for q in questions:
        got = by_question.get(sensitive.normalize(q).lower()) or {}
        blocked = blocked_map.get(q)
        if blocked:  # server-side override: the model has no veto here
            out["answers"].append({"question": q, "answer": BLOCKED_ANSWER, "source": "blocked", "confidence": 0.0, "needs_input": True, "blocked": True, **blocked})
            continue
        answer = str(got.get("answer") or "").strip()
        needs = bool(got.get("needs_input")) or not answer or UNKNOWN.lower() in answer.lower()
        confidence = got.get("confidence")
        try:
            confidence = max(0.0, min(1.0, float(confidence)))
        except (TypeError, ValueError):
            confidence = 0.35 if answer else 0.0
        if needs:
            confidence = min(confidence, 0.4)
        review = sensitive.review_reason(q)
        out["answers"].append(
            {
                "question": q,
                "answer": answer or f"{UNKNOWN} not drafted by the model.",
                "source": str(got.get("source") or ("inferred" if answer else "none")),
                "confidence": confidence,
                "needs_input": needs or confidence < 0.55,
                "blocked": False,
                "note": str(got.get("note") or ""),
                **({"review": review} if review else {}),
            }
        )
    if not out["resume_markdown"]:
        out["resume_markdown"], notes = tailor_resume_with_rules(profile, job, keywords)
        out["resume_changes"] = ["Model returned no resume; fell back to rule-based tailoring."] + notes
    if not out["cover_letter"]:
        out["cover_letter"] = cover_letter_with_rules(profile, job, keywords)
        out["resume_changes"] = (out["resume_changes"] or []) + ["Model returned no cover letter; used the template."]
    return out, cfg


COVER_SYSTEM = """You write one cover letter for a real job application.

Rules:
1. Use only facts present in the candidate profile supplied. You may re-word and
   re-order, never add an employer, a date, a tool, or a number that is not there.
2. 180-260 words. Address the company by name. First line specific and true; no
   "I am excited", "leverage", "spearhead", no adjective stacking, no preamble.
3. Two pieces of evidence drawn from the profile, plain verbs, numbers where the
   profile has them.
4. If the profile is too thin to say anything true about this role, write the letter
   anyway and put [NEEDS INPUT] where the missing fact belongs. Never invent it.
5. Never state or imply work authorization, citizenship, visa or sponsorship status,
   age, health, disability, veteran status, race, ethnicity, religion, sex, or an
   attestation. A home town and a language are not evidence of any of them. If the
   letter seems to need one, leave it out entirely.

Return ONLY JSON: {"cover_letter": string, "note": string}
"""


def draft_cover_letter(profile: dict, job: dict, settings: dict | None = None) -> dict:
    """A cover letter for one saved job, on its own, without building a whole packet.

    This is a draft attached to the job record. It is deliberately NOT part of any
    packet, so the autofill engine cannot type it: a packet still has to be built,
    read and approved before anything reaches a form.
    """
    settings = settings or config.load_settings()
    keywords = job_keywords(job)
    cfg = llm.resolve(settings)
    note, method = "", "rules"
    text = ""
    if cfg["provider"] != "none":
        user = ("CANDIDATE PROFILE\n" + profile_brief(profile, 6000) + "\n\n" + job_brief(job, 5000)
                + "\n\nKEYWORDS WORTH COVERING where genuinely true: " + ", ".join(keywords[:20]))
        try:
            raw = llm.complete(COVER_SYSTEM, user, expect_json=True, settings=settings)
            if isinstance(raw, list):
                raw = raw[0] if raw and isinstance(raw[0], dict) else {}
            if isinstance(raw, dict):
                text = str(raw.get("cover_letter") or "").strip()
                note = str(raw.get("note") or "").strip()
                method = "llm"
        except Exception as exc:  # noqa: BLE001 - a failed draft must degrade, not 500
            note = f"model unavailable ({str(exc)[:120]}); used the template instead."
    if not text:
        text = cover_letter_with_rules(profile, job, keywords)
        method = "rules"
        note = note or "Written from your saved profile with no model configured — read it and make it yours."
    own = "\n".join(filter(None, [profile.get("master_resume_markdown", ""), profile.get("summary", "")]))
    scrubbed = sensitive.redact_compliance_claims(text, inherited=own)
    text = scrubbed["text"]
    if scrubbed["redactions"]:
        kinds = ", ".join(sorted({r["category"].replace("_", " ") for r in scrubbed["redactions"]}))
        note = (note + " " if note else "") + (
            f"Removed {len(scrubbed['redactions'])} compliance statement(s) the draft invented "
            f"({kinds}). Only you can make those statements — add them yourself if they are true."
        )
    return {
        "text": text,
        "redactions": scrubbed["redactions"],
        "words": resume_export.word_count(text),
        "method": method,
        "model": cfg.get("model") if method == "llm" else "",
        "note": note,
        "needs_review": True,
        "drafted_at": store.now(),
    }


# --------------------------------------------------------------------------- assemble


def build_packet(job_id: str, extra_questions: list[str] | None = None, provider_override: str = "") -> dict:
    job = store.get_job(job_id)
    if not job:
        raise KeyError(f"no job {job_id}")
    profile = store.load_profile()
    settings = config.load_settings()
    if provider_override:
        settings = config._deep_merge(settings, {"llm": {"provider": provider_override}})

    questions = extract_questions(job, extra_questions)
    cfg = llm.resolve(settings)
    warnings: list[str] = []
    if cfg["provider"] != "none":
        try:
            built, used = build_with_llm(profile, job, questions, settings)
            warnings.append(f"Drafted by {used['provider']}:{used['model']}. Every word still has to pass your eyes.")
        except llm.LLMError as exc:
            built = build_with_rules(profile, job, questions)
            warnings.append(f"Model call failed ({exc}). Used the rule-based builder instead.")
    else:
        built = build_with_rules(profile, job, questions)
        warnings.append("No model configured: rule-based packet (template letter + your boilerplate answers). Add a key in Settings for full drafting.")

    missing_boiler = [b for b in profile.get("boilerplate", []) if isinstance(b, dict) and not (b.get("text") or "").strip()]
    if missing_boiler:
        warnings.append("Empty boilerplate answers in your profile: " + ", ".join(str(b.get("label")) for b in missing_boiler[:6]))

    # A model will infer compliance facts it was never told -- a town and a language
    # became "authorized to work in the United States without sponsorship" in testing.
    # Every drafted field is scrubbed before a human ever sees it; the marker left
    # behind is the one the approval gate and the autofiller both refuse.
    redactions: list[dict] = []
    inherited: list[dict] = []
    own_words = "\n".join(filter(None, [
        profile.get("master_resume_markdown", ""), profile.get("summary", ""),
        " ".join(str(b) for e in profile.get("experience", []) if isinstance(e, dict)
                 for b in (e.get("bullets") or [])),
        " ".join(str(b.get("text", "")) for b in profile.get("boilerplate", []) if isinstance(b, dict)),
    ]))

    def scrub(text: str, where: str) -> str:
        result = sensitive.redact_compliance_claims(text or "", inherited=own_words)
        for item in result.get("inherited", []):
            inherited.append({**item, "where": where})
        for item in result["redactions"]:
            redactions.append({**item, "where": where})
        return result["text"]

    built["resume_markdown"] = scrub(built.get("resume_markdown", ""), "tailored resume")
    built["cover_letter"] = scrub(built.get("cover_letter", ""), "cover letter")
    for a in built["answers"]:
        if a.get("blocked"):
            continue
        before = a.get("answer", "")
        a["answer"] = scrub(before, f"answer to: {a['question'][:60]}")
        if a["answer"] != before:  # the marker is a gap now, and must read as one
            a["needs_input"] = True
            a["confidence"] = min(float(a.get("confidence") or 0.0), 0.4)
            a["note"] = (a.get("note") + " " if a.get("note") else "") + \
                "A compliance statement was taken out of this answer; only you can say it."
    if redactions:
        kinds = ", ".join(sorted({r["category"].replace("_", " ") for r in redactions}))
        warnings.append(
            f"Removed {len(redactions)} compliance statement(s) the drafter invented ({kinds}). "
            "They are yours to state, or to leave out — read the marked spots before approving."
        )

    # Your own documents may state a legal status. That is your call, so it is not
    # removed — it is surfaced, because a statement that is true in one country is
    # irrelevant in another and it should be a decision, not an inheritance.
    status_flags: list[dict] = []
    for where, text in (("tailored resume", built.get("resume_markdown", "")),
                        ("cover letter", built.get("cover_letter", ""))):
        for item in sensitive.status_mentions(text):
            status_flags.append({**item, "where": where})

    md = built["resume_markdown"]
    flags = resume_export.needs_input_flags(md + "\n" + built["cover_letter"] + "\n" + "\n".join(a["answer"] for a in built["answers"]))
    blocked = [a for a in built["answers"] if a.get("blocked")]

    packet = {
        "id": store.new_id("packet"),
        "job_id": job_id,
        "title": job.get("title", ""),
        "company": job.get("company", ""),
        "url": job.get("url", ""),
        "status": "draft",
        "approved": False,
        "resume": {
            "markdown": md,
            "changes": built.get("resume_changes", []),
            "fit": resume_export.fit_note(md, settings.get("packets", {}).get("resume_pages", 1)),
            "ats": resume_export.ats_report(md, job.get("description", "")),
        },
        "cover_letter": {"text": built["cover_letter"], "words": resume_export.word_count(built["cover_letter"])},
        "answers": built["answers"],
        "questions_found": len(questions),
        "keywords": built.get("keywords", [])[:30],
        "blocked_questions": [a["question"] for a in blocked],
        "compliance_redactions": redactions[:20],
        "status_mentions": status_flags[:12],
        "needs_input_flags": flags[:40],
        "warnings": warnings,
        "llm": {"provider": built.get("method", "rules"), "model": (built.get("llm") or {}).get("model", ""), "requested": cfg["provider"]},
        "profile_snapshot": None,
    }
    packet["profile_snapshot"] = build_autofill_snapshot(packet, profile, job)
    store.save_packet(packet)
    store.log_event("packet_built", {"job_id": job_id, "packet_id": packet["id"], "provider": packet["llm"]["provider"], "questions": len(questions), "blocked": len(blocked)})
    return packet


# --------------------------------------------------------------------------- autofill snapshot


def _norm_key(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (text or "").lower()).strip()


SNAPSHOT_VERSION = 3  # bump when the rules for "may be typed" change; see r_autofill_snapshot

def snapshot_fingerprint(packet: dict) -> str:
    """A digest of everything the extension is allowed to type.

    A packet edited after approval used to keep the snapshot taken when it was built, so
    the dashboard showed the corrected answer while the extension typed the old one -
    silently, because "what you approved is what gets typed" had stopped being true the
    moment anybody typed in the review box. Anything that writes a packet can be detected
    by comparing this against the stored snapshot.
    """
    import hashlib
    import json as _json

    typed = [
        {
            "q": a.get("question", ""),
            "a": a.get("answer", ""),
            "u": bool(a.get("needs_input")),
            "b": bool(a.get("blocked")),
        }
        for a in (packet.get("answers") or [])
    ]
    blob = _json.dumps(
        {
            "answers": sorted(typed, key=lambda x: x["q"]),
            "resume": (packet.get("resume") or {}).get("markdown", ""),
            "cover": (packet.get("cover_letter") or {}).get("text", ""),
            "profile_updated": (packet.get("profile_snapshot") or {}).get("profile_updated_at", ""),
        },
        sort_keys=True,
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]
NEEDS_INPUT_MARK = "[needs input]"  # withheld on the flag AND in the text: a ticked box with
                              # placeholder prose inside is still a hole in the review


def polish_evidence(profile: dict, packet: dict | None = None) -> str:
    """Everything the candidate has already put in writing.

    A polish pass may reuse any of it and add nothing outside it, which is what makes
    "rewrite this professionally" safe: the universe of allowed facts is the candidate's
    own record, not the model's imagination of a plausible career.
    """
    parts = [
        profile.get("master_resume_markdown", "") or "",
        profile.get("summary", "") or "",
        ", ".join(str(x) for x in (profile.get("skills") or [])[:400]),
        ", ".join(str(x) for x in (profile.get("certifications") or [])[:60]),
        " ".join(str(b.get("text", "")) for b in (profile.get("boilerplate") or []) if isinstance(b, dict)),
    ]
    if packet:
        parts.append(str((packet.get("resume") or {}).get("markdown", "")))
        parts.append(str((packet.get("cover_letter") or {}).get("text", "")))
        parts.append(" ".join(str(a.get("answer", "")) for a in (packet.get("answers") or [])))
    return "\n".join(part for part in parts if part and part.strip())


def build_autofill_snapshot(packet: dict, profile: dict, job: dict) -> dict:
    """Exactly what the browser extension is allowed to type into a form.

    This is deliberately a *snapshot* taken at approval time, not a live view of
    the profile: what you approved is what gets typed.
    """
    answers = []
    unverified: list[str] = []
    for a in packet.get("answers", []):
        if a.get("blocked"):
            answers.append({"question": a["question"], "key": _norm_key(a["question"]), "answer": "", "blocked": True, "category": a.get("category")})
            continue
        if a.get("needs_input") or NEEDS_INPUT_MARK in (a.get("answer") or "").lower():
            # Never type an answer the human did not confirm. Approving with open items
            # releases the rest of the packet, not this one. The old rule was a search for
            # the literal string [NEEDS INPUT], which broke the moment someone typed their
            # own answer and left the "I have verified this" box ticked-off: real text,
            # never reviewed, headed for a real employer.
            unverified.append(a["question"])
            continue
        answers.append(
            {
                "question": a["question"],
                "key": _norm_key(a["question"]),
                "answer": a.get("answer", ""),
                "confidence": a.get("confidence", 0),
                "needs_input": bool(a.get("needs_input")),
                "review": a.get("review"),
            }
        )
    links = {k: v for k, v in (profile.get("links") or {}).items() if v}
    exp = []
    for e in profile.get("experience", []):
        if isinstance(e, dict) and (e.get("company") or e.get("title")):
            exp.append(
                {
                    "company": e.get("company", ""),
                    "title": e.get("title", ""),
                    "location": e.get("location", ""),
                    "start": e.get("start", ""),
                    "end": e.get("end", "") or ("Present" if e.get("current") else ""),
                    "bullets": experience_bullets(e),
                }
            )
    edu = [e for e in profile.get("education", []) if isinstance(e, dict) and (e.get("school") or e.get("degree"))]
    return {
        "version": SNAPSHOT_VERSION,
        "fingerprint": snapshot_fingerprint(packet),
        "unverified_questions": unverified,
        "packet_id": packet["id"],
        "generated_at": store.now(),
        "job": {"title": job.get("title", ""), "company": job.get("company", ""), "url": job.get("url", ""), "location": job.get("location", "")},
        "identity": {
            "first_name": (profile.get("name") or "").split(" ")[0] if profile.get("name") else "",
            "last_name": " ".join((profile.get("name") or "").split(" ")[1:]) if profile.get("name") else "",
            "full_name": profile.get("name", ""),
            "email": profile.get("email", ""),
            "phone": profile.get("phone", ""),
            "location": profile.get("location", ""),
            "headline": profile.get("headline", ""),
            "pronouns": profile.get("pronouns", ""),
            "timezone": profile.get("timezone", ""),
        },
        "links": links,
        "resume_markdown": packet.get("resume", {}).get("markdown", ""),
        "cover_letter": packet.get("cover_letter", {}).get("text", ""),
        "skills": profile.get("skills", []),
        "languages": profile.get("languages", []),
        "certifications": profile.get("certifications", []),
        "summary": profile.get("summary", ""),
        "experience": exp,
        "education": edu,
        "answers": answers,
        "review_only": {
            "salary_expectation": profile.get("salary_expectation", ""),
            "relocation": profile.get("relocation", ""),
            "start_date": profile.get("start_date", ""),
            "notice_period": profile.get("notice_period", ""),
        },
        "never_autofill": sorted(set(config.BLOCKED_CATEGORIES)),
        "docs": {
            "resume_docx": f"/api/packets/{packet['id']}/file?fmt=docx&type=resume",
            "resume_html": f"/api/packets/{packet['id']}/file?fmt=html&type=resume",
            "cover_letter_docx": f"/api/packets/{packet['id']}/file?fmt=docx&type=cover",
            "cover_letter_txt": f"/api/packets/{packet['id']}/file?fmt=txt&type=cover",
        },
        "doc_names": {
            "resume": f"{store.slug(packet.get('company') or 'resume')}-{store.slug(packet.get('title') or 'application')}.docx",
            "cover_letter": f"{store.slug(packet.get('company') or 'resume')}-cover-letter.docx",
        },
    }


def refresh_snapshot(packet_id: str) -> dict | None:
    """After the user edits/approves, re-snapshot so autofill uses the approved text."""
    packet = store.get_packet(packet_id)
    if not packet:
        return None
    job = store.get_job(packet.get("job_id") or "") or {}
    packet["profile_snapshot"] = build_autofill_snapshot(packet, store.load_profile(), job)
    return store.save_packet(packet)
