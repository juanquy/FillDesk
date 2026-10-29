"""Rewrite the candidate's own words professionally, without adding facts.

Drafting and polishing are different jobs. Drafting starts from nothing and therefore
invents; polishing starts from the candidate's honest, clumsy sentence and needs only
register. This module does the second one, and the whole file exists for one rule:

    the rewrite may change prose, never facts.

Without that, "cut cart abandonment a lot" comes back as "reduced cart abandonment by
31%", the sentence around the invention is the candidate's own, and they approve a number
they never had. So the output is diffed against the input and the candidate's evidence,
and a rewrite that introduces a figure or a name is refused rather than flagged.
"""
from __future__ import annotations

import re
from typing import Any

from . import llm, sensitive

SYSTEM = (
    "You rewrite one answer on a job application so it reads calmly and professionally.\n"
    "You may change word choice, sentence order, grammar and register.\n"
    "You may NOT add anything: no numbers, percentages, dates, durations, employers, job "
    "titles, tools, products, locations, credentials, or claims about legal status, age, "
    "health, disability, veteran status or criminal history.\n"
    "If the input is vague, stay equally vague. A weaker sentence that is true beats a "
    "stronger one that is not.\n"
    'Return JSON: {"text": "the rewrite only"}'
)

# Words that look like proper nouns but are not evidence of anything.
_COMMON = {
    # ordinary english, and the words that open sentences for reasons other than being a
    # name. a capital at the start of a sentence is weak evidence, so these are dropped;
    # dictionary words are NOT dropped in general, because stripe, apple, rust and shell
    # are all dictionary words and all employers someone could be given.
    "i", "we", "you", "they", "it", "he", "she", "this", "that", "these", "those", "there",
    "here", "the", "and", "or", "but", "so", "if", "then", "than", "when", "while",
    "whereas", "although", "though", "because", "since", "unless", "until", "as", "at",
    "by", "for", "from", "in", "into", "of", "on", "onto", "out", "over", "under", "up",
    "with", "without", "within", "about", "after", "before", "during", "across", "among",
    "against", "around", "per", "via", "my", "our", "his", "her", "its", "their", "your",
    "what", "why", "how", "who", "whom", "whose", "which",
    "also", "however", "therefore", "moreover", "furthermore", "additionally", "instead",
    "otherwise", "meanwhile", "eventually", "ultimately", "overall", "specifically",
    "particularly", "especially", "notably", "importantly", "personally", "honestly",
    "typically", "usually", "generally", "normally", "often", "sometimes", "rarely",
    "always", "never", "recently", "lately", "currently", "previously", "initially",
    "first", "firstly", "second", "secondly", "third", "next", "last", "finally",
    "again", "together", "instead", "yes", "no", "both", "each", "every", "all", "any",
    "some", "many", "most", "more", "much", "few", "less", "least", "other", "others",
    "another", "such", "one", "two", "three", "four", "five", "ten",
    "team", "teams", "role", "roles", "job", "company", "employer", "organisation",
    "organization", "product", "products", "customer", "customers", "client", "clients",
    "user", "users", "year", "years", "month", "months", "week", "weeks", "day", "days",
    "time", "times", "work", "working", "project", "projects", "system", "systems",
    "responsibility", "responsibilities", "goal", "goals", "result", "results",
    "challenge", "challenges", "strength", "weakness", "reason", "reasons", "example",
    "examples", "note", "notes", "thing", "things", "way", "ways", "part", "parts",
    "better", "best", "good", "great", "key", "main", "biggest", "important", "similar",
    "everything", "nothing", "something", "anything", "somebody", "nobody", "everybody",
    "definitely", "certainly", "probably", "perhaps", "maybe", "really", "very", "quite",
    "rather", "enough", "too", "just", "even", "only", "simply", "literally", "actually",
}


def numbers(text: str) -> set[str]:
    """Every figure in the text, normalised so '1,200' and '1200' compare equal."""
    return {n.replace(",", "").rstrip(".") for n in re.findall(r"\d[\d,]*\.?\d*", text or "")}


def names(text: str) -> set[str]:
    """Capitalised tokens that read as employers, tools, products or places.

    A capital at the start of a sentence proves nothing about whether the word is a name,
    so sentence-openers are dropped only when they are ordinary English (the _COMMON set).
    The bias is deliberate: a false refusal tells the user "the rewrite added a name" and
    keeps their own words, while a false accept silently files an employer they never had.
    """
    out: set[str] = set()
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", text or ""):
        lowered = {w.lower() for w in re.findall(r"[a-z][A-Za-z0-9&'.\-]+", sentence)}
        for match in re.finditer(r"[A-Z][A-Za-z0-9&'.\-]+", sentence):
            low = match.group(0).lower().strip(".")
            if len(low) < 2 or low in _COMMON or low in lowered:
                continue
            if low.endswith("ly") and len(low) > 4:
                continue  # "Significantly, ..." opens a sentence without naming anything
            out.add(low)
    return out


def polish(text: str, evidence: str = "", context: str = "", settings: dict | None = None) -> dict[str, Any]:
    """Return {"ok", "text", "refused", "added_numbers", "added_names", ...}.

    `evidence` is everything the candidate has already stated (their answer plus their
    profile), and is the only universe a rewrite may draw names from. `context` is the
    employer and role, which the packet already knows and may therefore mention.
    """
    text = (text or "").strip()
    if len(text) < 24:
        return {"ok": False, "text": text, "refused": "too short to rewrite — a sentence or two, please."}

    user = "\n\n".join(
        part for part in (
            ("EMPLOYER AND ROLE (already known, may be named): " + context.strip()) if context.strip() else "",
            "THE CANDIDATE'S OWN WORDS (rewrite this):\n" + text,
            "EVERYTHING ELSE THIS CANDIDATE HAS ALREADY STATED (facts you may keep, not add):\n"
            + (evidence.strip()[:4000] or "(nothing else given)"),
        ) if part
    )

    try:
        raw = llm.complete(SYSTEM, user, expect_json=True, settings=settings)
    except Exception as exc:  # noqa: BLE001 - a failed polish must never eat the input
        return {"ok": False, "text": text, "refused": f"model unavailable ({str(exc)[:140]})"}

    if isinstance(raw, list):
        raw = raw[0] if raw and isinstance(raw[0], dict) else {}
    if not isinstance(raw, dict):
        return {"ok": False, "text": text, "refused": "the model did not return a rewrite"}
    out = str(raw.get("text") or "").strip()
    if not out:
        return {"ok": False, "text": text, "refused": "the model returned an empty rewrite"}

    # 1. a polish pass can smooth in a compliance claim exactly as a drafting pass can
    scrubbed = sensitive.redact_compliance_claims(out, inherited=(evidence or "") + " " + text)
    if scrubbed.get("redactions"):
        return {
            "ok": False, "text": text,
            "refused": "the rewrite stated something only you may state: "
                       + "; ".join(sorted({str(r.get("category", "compliance")) for r in scrubbed["redactions"]})),
            "claims": scrubbed["redactions"],
        }

    # 2. no new figures, ever. This is the failure that ends trust in the product.
    allowed_numbers = numbers(text) | numbers(evidence)
    new_numbers = sorted(n for n in numbers(out) if n not in allowed_numbers)
    allowed_names = names(text) | names(evidence) | {w.lower() for w in re.findall(r"[A-Za-z][A-Za-z0-9&'.\-]+", context)}
    new_names = sorted(n for n in names(out) if n not in allowed_names)

    if new_numbers or new_names:
        bits = []
        if new_numbers:
            bits.append("numbers nobody gave it (" + ", ".join(new_numbers[:6]) + ")")
        if new_names:
            bits.append("names nobody gave it (" + ", ".join(new_names[:6]) + ")")
        return {
            "ok": False, "text": text,
            "refused": "the rewrite added facts: " + " and ".join(bits),
            "added_numbers": new_numbers, "added_names": new_names,
            "attempt": out,
        }

    # 3. a rewrite that dropped most of the content is not a rewrite
    before, after = len(text.split()), len(out.split())
    note = ""
    if after < before * 0.45:
        note = f"shorter than what you wrote ({before} words became {after}) — make sure nothing you meant was cut."

    return {
        "ok": True,
        "text": out,
        "words_before": before,
        "words_after": after,
        "note": note,
        "refused": None,
    }
