"""The compliance gate.

Anything that is a protected-class self-identification, a work-authorization
declaration, or a legal attestation is *never* answered by this tool -- not by
the LLM and not by the autofiller. That is a deliberate product decision: an
incorrect auto-filled EEO/veteran/disability answer is the single most damaging
failure mode in this category, and the user loses either way.

Mirrored in extension/matcher.js. Keep both in sync.
"""
from __future__ import annotations

import re

# (category, pattern) -- matched against a normalized question/label string.
_PATTERNS: list[tuple[str, str]] = [
    ("protected_class", r"\b(race|ethnic(ity| group)|gender identity|sex(ual orientation)?|religion|creed|national origin|indigenous|aboriginal|minority group|LGBTQ|self[- ]identif\w*)\b"),
    ("disability", r"\b(disabilit\w+|accommodat\w+|ADA|physical or mental (impairment|condition)|mobility|hearing loss|vision impairment)\b"),
    ("veteran", r"\b(veteran|veteran status|protected veteran|armed forces|active[- ]duty|military service member|discharged)\b"),
    ("work_authorization", r"\b(work (authorization|authorised|authorized)|legally authorized|citizen(ship)?|national(ity)?|permanent resident|green card|visa|sponsor(ship)?|H-?1B|OPT|CPT|STEM OPT|require sponsorship|employment eligibility|I-?9)\b"),
    ("age", r"\b(age|date of birth|birth ?date|born|how old|year you (were )?graduated)\b"),
    ("criminal", r"\b(arrest\w*|convict\w*|felon\w*|criminal (history|record|background)|incarcerat\w*|court[- ]ordered|dishonorable discharge)\b"),
    ("legal_declaration", r"\b(attest|affirm|declaration|certif\w* that|i hereby|under penalty of|electronic signature|e-?signature|sworn|notari\w+|truthful and complete)\b"),
    ("health", r"\b(health condition|medical (history|leave|record)|FMLA|workers[- ]?comp|drug (test|screen)|tobacco|smok\w+)\b"),
]

# Questions that are answerable but always flagged for human review.
_REVIEW_PATTERNS: list[tuple[str, str]] = [
    ("salary", r"\b(salar\w+|compensation|pay expectation|desired (pay|rate)|rate expectation|CTC|notice period pay)\b"),
    ("relocation", r"\b(relocat\w+|willing to (move|relocate)|work ?(model|location)|hybrid|onsite|on-site|travel (requirement|percent)|remote)\b"),
    ("start_date", r"\b(start date|available (to start|from)|notice period|when (could|can) you start)\b"),
    ("notice", r"\b(non[- ]?compete|non[- ]?disclosure|garden leave|restrictive covenant)\b"),
    ("clearance", r"\b(clearance|clearance level|background check|security screening|conduct a (background|credit))\b"),
    ("references", r"\b(reference|referee|recommender)\b"),
]

_COMPILED = [(c, re.compile(p, re.I)) for c, p in _PATTERNS]
_REVIEW_COMPILED = [(c, re.compile(p, re.I)) for c, p in _REVIEW_PATTERNS]

# Words that make a *seemingly* sensitive string harmless, e.g. "veteran-owned
# business" inside a job description, or "visa sponsorship available" typed by
# the user into their own profile notes. Checked before blocking.
_SAFE_CONTEXT = re.compile(
    r"\b(veteran-owned|service[- ]disabled|diverse supplier|supplier diversity|"
    r"our company|we (offer|provide|sponsor)|benefits|paid leave|equal opportunity employer\b)",
    re.I,
)


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("\u200b", " ").strip())


def blocked_reason(text: str) -> dict | None:
    """Return {category, why} when the tool must not answer this question."""
    t = normalize(text)
    if not t or len(t) < 4:
        return None
    if _SAFE_CONTEXT.search(t) and not re.search(r"\byou\b|\byour\b|\bare you\b|\bdo you\b|\bwere you\b", t, re.I):
        return None
    for category, rx in _COMPILED:
        m = rx.search(t)
        if m:
            from .config import BLOCKED_CATEGORIES

            return {"category": category, "match": m.group(0), "why": BLOCKED_CATEGORIES.get(category, category)}
    return None


def review_reason(text: str) -> dict | None:
    """Return {category, why} when an answer is allowed but must be re-read."""
    t = normalize(text)
    if not t or len(t) < 4:
        return None
    for category, rx in _REVIEW_COMPILED:
        m = rx.search(t)
        if m:
            from .config import REVIEW_CATEGORIES

            return {"category": category, "match": m.group(0), "why": REVIEW_CATEGORIES.get(category, category)}
    return None


_QUESTION_START = re.compile(
    r"^(what|how|why|when|where|who|which|whether|describe|explain|provide|tell|list|outline|give|share|state|indicate|identify|confirm|select|choose|rate|rank|upload|attach|"
    r"are you|do you|have you|had you|can you|could you|would you|will you|is your|was your|your (ability|salary|notice|start)|"
    r"please (describe|explain|share|list|state|indicate|identify|confirm|provide|tell|upload|attach)|"
    r"self[- ]identif\w*|optional|best answer to this|a few words|if hired|in your own words)",
    re.I,
)

def is_question_like(text: str) -> bool:
    """Heuristic: does this look like an employer application question (vs a form label)?

    Deliberately strict. A misclassified bullet point from the job description turns
    into a phantom question that wastes the user's attention, and it is much cheaper
    to miss one question than to invent five.
    """
    t = normalize(text)
    if not t:
        return False
    if re.match(r"^([-*\u2022]|\d+[.)])\s", t):
        return False
    if re.match(r"^(nice to have|requirements?|responsibilities|qualifications|about (you|us)|benefits|what you.ll|you.ll|we.ll|perks|what we offer|must have)\b", t, re.I):
        return False
    if t.endswith("?"):
        return True
    words = len(t.split())
    if words >= 4 and _QUESTION_START.match(t):
        return True
    if re.match(r"^(self[- ]identif|a few words about|in your own words|optional:)", t, re.I):
        return True
    return False


def scan_questions(questions: list[str]) -> dict:
    """Classify a batch of extracted employer questions."""
    out = {"answerable": [], "review": [], "blocked": []}
    for q in questions:
        b = blocked_reason(q)
        if b:
            out["blocked"].append({"question": normalize(q), **b})
            continue
        r = review_reason(q)
        if r:
            out["review"].append({"question": normalize(q), **r})
            continue
        out["answerable"].append(normalize(q))
    return out
