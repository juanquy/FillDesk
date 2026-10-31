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
    ("work_authorization", r"\b(work (authorization|authorised|authorized)|(legally )?authorized to work|legally authorized|citizen(ship)?|national(ity)?|permanent resident|green card|visa|sponsor(ship)?|H-?1B|OPT|CPT|STEM OPT|require sponsorship|employment eligibility|I-?9)\b"),
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


_FILE_UPLOAD_PATTERN = re.compile(
    r"\b(upload|attach)\b.*\b(resume|cv|curriculum vitae|cover letter|document|file|pdf|docx?|portfolio|transcript)\b"
    r"|\b(max file size|allowed file types|accepted formats)\b",
    re.I,
)

def is_file_upload_prompt(text: str) -> bool:
    """True if text is an instruction for a file-attachment input, not an essay/text question."""
    t = normalize(text)
    return bool(_FILE_UPLOAD_PATTERN.search(t))

_QUESTION_START = re.compile(
    r"^(what|how|why|when|where|who|which|whether|describe|explain|provide|tell|list|outline|give|share|state|indicate|identify|confirm|select|choose|rate|rank|"
    r"are you|do you|have you|had you|can you|could you|would you|will you|is your|was your|your (ability|salary|notice|start)|"
    r"please (describe|explain|share|list|state|indicate|identify|confirm|provide|tell)|"
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
    if is_file_upload_prompt(t):
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
# Split on terminal punctuation and on paragraph or markdown-line breaks, but NOT on a
# single newline: a wrapped sentence must stay one sentence or a claim split across the
# wrap would slip through.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])[\s\n]+|\n{2,}|\n(?=\s*(?:[-#*\u2022]|\d+[.)]))")
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
            hit = pattern.search(probe)
            if hit:
                out.append({"category": category, "sentence": sentence, "why": why,
                            "matched": normalize(hit.group(0))})
                break
    return out


# ---------------------------------------------------------------- status mentions
#
# These are the questions every US application asks: "Are you legally authorized to
# work?", "Do you now or in the future require sponsorship (H-1B, TN, O-1)?", and the
# dropdown of statuses — US citizen, lawful permanent resident, non-immigrant visa
# holder, EAD (work permit) holder. FillDesk refuses to answer them because the I-9
# attestation is signed under penalty of perjury by the employee. But a document the
# user wrote may legitimately state the status, and that is their call — so it is
# surfaced for confirmation, never stripped.
_STATUS_MENTIONS = re.compile(
    r"(\bu\.?s\.?\b|united states)?\s?(citizen(ship)?|lawful permanent resident|permanent resident card?|"
    r"green card|(employment )?authorization (document|to work)|work permit|\bead\b|"
    r"sponsorship|sponsor me|require sponsorship|without sponsorship|"
    r"\b(h-?1b|tn|o-?1|opt|stem opt|cpt|l-?1|f-?1|j-?1|eb-?\d|i-?485|i-?9|e-?verify)\b|"
    r"asylee|refugee|non-?immigrant visa|naturalized|born in the united states)",
    re.I,
)


# Running a company's E-Verify queue is a job duty, not a statement about you. Only
# the process-and-system words get this exemption; "I am a US Citizen" never does.
_STATUS_DUTY = re.compile(
    r"\b(configur\w*|administ\w*|manag\w*|ran|run|implement\w*|support\w*|audit\w*|"
    r"onboard\w*|train\w*|process\w*|integrat\w*|troubleshoot\w*)\b.*?"
    r"\b(e-?verify|i-?9|employment eligibility|work permit|green card|visa)\b",
    re.I | re.S,
)


def status_mentions(text: str) -> list[dict]:
    """Lines in a document that state an immigration or work-authorization status."""
    out: list[dict] = []
    for line in re.split(r"\n|(?<=[.!?])\s+", text or ""):
        probe = normalize(line)
        if not probe or _SAFE_CONTEXT.search(probe) or _STATUS_DUTY.search(probe):
            continue
        if _STATUS_MENTIONS.search(probe):
            out.append({"text": line.strip()[:200], "why": "a legal status stated in your document"})
    return out


def redact_compliance_claims(text: str, inherited: str = "") -> dict:
    """Swap each compliance assertion for a [NEEDS INPUT] marker.

    The marker is the same token the rest of the product already refuses to autofill
    and refuses to approve without force, so a drafted compliance claim cannot reach a
    form on any path -- it has to be read and resolved by a person first.

    `inherited` is the person's own source text (master resume, summary, saved
    answers). A claim whose wording already appears there is *their* statement travelling
    through the pipeline, not a model's invention, so it is reported separately and left
    in place: the rule is never invent, inherit knowingly. Deleting somebody's own true
    sentence from their own resume would be its own kind of lie.
    """
    source = normalize(inherited or "")
    claims = compliance_claims(text)
    if not claims:
        return {"text": text, "redactions": [], "inherited": []}
    invented, inherited_claims = [], []
    for c in claims:
        if c.get("matched") and len(c["matched"]) > 6 and c["matched"] in source:
            inherited_claims.append(c)
        else:
            invented.append(c)
    clean = text
    for c in invented:
        marker = f"[NEEDS INPUT] {c['category'].replace('_', ' ')}: {c['why']}."
        clean = clean.replace(c["sentence"], marker)
    return {"text": clean.strip() if invented else text, "redactions": invented,
            "inherited": inherited_claims}
