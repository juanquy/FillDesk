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


# ------------------------------------------------------- generated prose
#
# The field matcher refuses the *work authorization* box. That is not enough: a
# model writing a cover letter will happily infer one. Given a town and a native
# language, a real model produced "I am authorized to work in the United States
# without sponsorship" -- a legal representation, invented, in a document that
# gets uploaded to an employer. So generated prose is scanned sentence by sentence
# and any such statement is replaced with a marker the reviewer has to resolve.
#
# Tier A fires anywhere. Tier B only where the sentence is about the candidate,
# so "disabled features in the legacy console" survives and "I am a veteran" does not.
_PROSE_CLAIMS: list[tuple[str, str, str, bool]] = [
    ("work_authorization",
     r"(authoriz\w*|authoris\w*|eligib\w*|entitled) to work|without (a )?sponsorship|"
     r"no need for sponsorship|sponsorship (is not|required|isn.t needed|not needed)|require(s)? sponsorship|"
     r"\bu\.?s\.? citizen(ship)??|united states citizen(ship)??|permanent resident|green card|"
     r"work (permit|authorisation|authorization)|employment authorization document|\bead\b|"
     r"\b(h-?1b|tn|e-?3|o-?1|opt|cpt|stem opt|l-?1|f-?1) (visa|status)|visa (status|sponsorship)|"
     r"legally (allowed|permitted) to work",
     "work authorization, citizenship and sponsorship are statements only you can make", True),
    ("legal_declaration",
     r"i certify|i attest|i hereby (certify|declare|state|acknowledge)|declare under penalty|"
     r"i affirm that|this is a true and complete (statement|declaration)",
     "attestations and declarations must be your own words, chosen by you", False),
    ("criminal",
     r"no criminal record|clean criminal record|no felony|not been arrested|no convictions?|"
     r"never been (arrested|charged|convicted)|will (pass|clear) a background check",
     "criminal-history and background-check claims are never drafted", False),
    ("age",
     r"born in (19|20)\d{2}|my date of birth|i was born|\bi am \d{2} years old|\bage of \d{2}\b",
     "age and date of birth are never drafted", False),
    ("protected_class",
     r"my (race|ethnicity|religion|gender|nationality|creed|pronouns|sexual orientation)|"
     r"i am (a |an )?(man|woman|male|female|christian|muslim|jewish|hindu|buddhist|atheist|catholic|sikh)|"
     r"i am (gay|lesbian|bisexual|transgender|non-?binary)|i am (married|single|divorced)|my marital status",
     "protected-class identity is never stated on your behalf", False),
    ("disability",
     r"my (disability|medical condition|diagnosis)|i (have|live with) (a )?(disability|condition|autism|adhd|dyslexia)|"
     r"need(s)? (a )?reasonable accommodation|i am (blind|deaf|wheelchair)",
     "disability and accommodation requests are yours to make", False),
    ("veteran",
     r"i am a (protected )?veteran|my veteran status|honourabl(y|e) discharged|my discharge (status|type)",
     "veteran status is self-declared, never drafted", False),
    ("health",
     r"my (health|medical history)|i (take|use) (daily )?(medication|insulin)|workers[- ]?comp|"
     r"i am a non-?smoker|clean drug (test|screen)",
     "health information is never drafted", False),
]

_FIRST_PERSON = re.compile(r"\b(i|my|me|myself|as a candidate|as your candidate)\b", re.I)
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?:])[\s\n]+")
_WHY = {c: why for c, _p, why, _a in _PROSE_CLAIMS}
_PROSE_COMPILED = [(c, re.compile(p, re.I), why, tier_a) for c, p, why, tier_a in _PROSE_CLAIMS]


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_SPLIT.split(text or "") if s.strip()]


def compliance_claims(text: str) -> list[dict]:
    """Sentences in drafted prose that state something this tool must never state."""
    out: list[dict] = []
    for sentence in split_sentences(text):
        probe = normalize(sentence)
        if _SAFE_CONTEXT.search(probe):
            continue
        first_person = bool(_FIRST_PERSON.search(probe))
        for category, pattern, why, tier_a in _PROSE_COMPILED:
            if not tier_a and not first_person:
                continue
            if pattern.search(probe):
                out.append({"category": category, "sentence": sentence, "why": why})
                break
    return out


def redact_compliance_claims(text: str) -> dict:
    """Swap each compliance assertion for a [NEEDS INPUT] marker.

    The marker is the same token the rest of the product already refuses to autofill
    and refuses to approve without force, so a drafted compliance claim cannot reach a
    form on any path -- it has to be read and resolved by a person first.
    """
    claims = compliance_claims(text)
    if not claims:
        return {"text": text, "redactions": []}
    clean = text
    for c in claims:
        marker = f"[NEEDS INPUT] {c['category'].replace('_', ' ')}: {c['why']}."
        clean = clean.replace(c["sentence"], marker)
    return {"text": clean.strip(), "redactions": claims}
