"""Markdown -> ATS-safe output.

Two exporters:
  * HTML with print CSS  -> "Print to PDF" in the browser gives a clean one-pager.
  * DOCX                 -> a minimal, dependency-free OOXML writer. Single column,
                            real headings, no tables/text boxes: what ATS parsers read best.
"""
from __future__ import annotations

import datetime as _dt
import html as _html
import io
import re
import zipfile
from typing import Any

_STOPWORDS = set(
    """a an and are as at be been being but by for from had has have he her hers him his how i if in into is it its me more most my no nor not of off on our ours out she so than that the their them then there these they this those to too us was we were what when where which who whom why will with would you your yours about above after again all also am any because before below between both each few further here himself herself himself into itself myself once only other other our over own same some such through too under until up very via while d ll m o re s t ve""".split()
)


# --------------------------------------------------------------------------- markdown model


def parse_markdown(md: str) -> list[dict]:
    """Very small markdown subset -> [{type, text|items, level}]"""
    blocks: list[dict] = []
    for raw in (md or "").replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            blocks.append({"type": "heading", "level": len(m.group(1)), "text": m.group(2)})
            continue
        if re.match(r"^[-*_]{3,}$", stripped):
            blocks.append({"type": "rule"})
            continue
        if re.match(r"^([-*•]|\d+[.)])\s+", stripped):
            item = re.sub(r"^([-*•]|\d+[.)])\s+", "", stripped)
            if blocks and blocks[-1]["type"] == "list":
                blocks[-1]["items"].append(item)
            else:
                blocks.append({"type": "list", "items": [item]})
            continue
        if blocks and blocks[-1]["type"] == "para":
            blocks[-1]["text"] += " " + stripped
        else:
            blocks.append({"type": "para", "text": stripped})
    return blocks


INLINE = re.compile(r"(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|`[^`]+`)")


def _inline_html(text: str) -> str:
    out = []
    for part in INLINE.split(_html.escape(text)):
        if not part:
            continue
        if part.startswith("**") or part.startswith("__"):
            out.append(f"<strong>{part[2:-2]}</strong>")
        elif part.startswith("`"):
            out.append(f"<code>{part[1:-1]}</code>")
        elif part.startswith("*"):
            out.append(f"<em>{part[1:-1]}</em>")
        else:
            out.append(part)
    return "".join(out)


# --------------------------------------------------------------------------- HTML


PRINT_CSS = """
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.42 "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif;
       color: #111; margin: 0; padding: 0; background: #f2f2f2; }
.page { background: #fff; max-width: 780px; margin: 24px auto; padding: 34px 42px; box-shadow: 0 2px 14px rgba(0,0,0,.12); }
h1 { font-size: 19pt; margin: 0 0 2px; letter-spacing: .2px; }
h2 { font-size: 11pt; margin: 15px 0 5px; text-transform: uppercase; letter-spacing: .8px;
     border-bottom: 1px solid #ccc; padding-bottom: 3px; }
h3 { font-size: 10.5pt; margin: 10px 0 3px; }
p { margin: 0 0 7px; }
ul { margin: 0 0 8px; padding-left: 17px; }
li { margin: 0 0 3px; }
hr { border: 0; border-top: 1px solid #ddd; margin: 11px 0; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9.5pt; }
.needs { background: #fff3cd; border: 1px solid #f0c36d; padding: 0 3px; border-radius: 3px; }
@media print {
  body { background: #fff; }
  .page { box-shadow: none; margin: 0; max-width: none; padding: 0; }
  .toolbar { display: none !important; }
  h2 { break-after: avoid; }
}
.toolbar { position: sticky; top: 0; background: #111; color: #fff; padding: 9px 16px; display: flex;
           gap: 12px; align-items: center; font: 12px system-ui, sans-serif; max-width: 780px; margin: 0 auto; }
.toolbar button { background: #fff; color: #111; border: 0; border-radius: 5px; padding: 6px 12px; cursor: pointer; font-weight: 600; }
"""

_TOOLBAR = """<div class="toolbar"><strong>FillDesk</strong>
<span>Print to PDF for a clean, ATS-safe one-page file.</span>
<button onclick="window.print()">Print / Save as PDF</button></div>"""


def to_html(md: str, title: str = "Resume", toolbar: bool = True) -> str:
    body: list[str] = []
    for block in parse_markdown(md):
        t = block["type"]
        if t == "heading":
            lvl = block["level"]
            body.append(f"<h{min(lvl,3)}>{_inline_html(block['text'])}</h{min(lvl,3)}>")
        elif t == "list":
            body.append("<ul>" + "".join(f"<li>{_inline_html(i)}</li>" for i in block["items"]) + "</ul>")
        elif t == "rule":
            body.append("<hr/>")
        else:
            txt = _inline_html(block["text"])
            txt = re.sub(r"\[(?:NEEDS INPUT|NEEDS REVIEW|TODO)[^\]]*\]", r'<span class="needs">\g<0></span>', txt)
            body.append(f"<p>{txt}</p>")
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{_html.escape(title)}</title><style>{PRINT_CSS}</style></head>"
        f"<body>{_TOOLBAR if toolbar else ''}<div class='page'>{''.join(body)}</div></body></html>"
    )


# --------------------------------------------------------------------------- DOCX


_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""

_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

_DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="21"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="60"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="999999"/></w:pBdr></w:pPr>
<w:rPr><w:b/><w:sz w:val="23"/><w:spacing w:val="12"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:spacing w:before="120" w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Bullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:left="340" w:hanging="170"/><w:spacing w:after="40"/></w:pPr></w:style>
</w:styles>"""


def _runs(text: str) -> str:
    out = []
    for part in INLINE.split(text or ""):
        if not part:
            continue
        bold = italic = mono = False
        body = part
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            bold, body = True, part[2:-2]
        elif part.startswith("__") and part.endswith("__") and len(part) > 4:
            bold, body = True, part[2:-2]
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            italic, body = True, part[1:-1]
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            mono, body = True, part[1:-1]
        safe = _html.escape(body, quote=False)
        props = []
        if bold:
            props.append("<w:b/>")
        if italic:
            props.append("<w:i/>")
        if mono:
            props.append('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/>')
        rpr = f"<w:rPr>{''.join(props)}</w:rPr>" if props else ""
        out.append(f'<w:r>{rpr}<w:t xml:space="preserve">{safe}</w:t></w:r>')
    return "".join(out) or '<w:r><w:t xml:space="preserve"></w:t></w:r>'


def _para(text: str, style: str | None = None) -> str:
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{ppr}{_runs(text)}</w:p>"


def to_docx(md: str, title: str = "Resume") -> bytes:
    parts = []
    for block in parse_markdown(md):
        t = block["type"]
        if t == "heading":
            style = "Title" if block["level"] == 1 else ("Heading1" if block["level"] == 2 else "Heading2")
            parts.append(_para(block["text"], style))
        elif t == "list":
            for item in block["items"]:
                parts.append(_para("\u2022 " + item, "Bullet"))
        elif t == "rule":
            parts.append('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr></w:pPr></w:p>')
        else:
            parts.append(_para(block["text"]))
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        + "".join(parts)
        + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="720" w:right="792" w:bottom="720" w:left="792" w:header="432" w:footer="432" w:gutter="0"/>'
        "</w:sectPr></w:body></w:document>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES)
        zf.writestr("_rels/.rels", _RELS)
        zf.writestr("word/_rels/document.xml.rels", _DOC_RELS)
        zf.writestr("word/styles.xml", _STYLES)
        zf.writestr("word/document.xml", document)
        core = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f"<dc:title>{_html.escape(title)}</dc:title><dc:creator>FillDesk</dc:creator>"
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{_dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}</dcterms:created>'
            "</cp:coreProperties>"
        )
        zf.writestr("docProps/core.xml", core)
    return buf.getvalue()


# --------------------------------------------------------------------------- ATS keyword report

_KEYWORD = re.compile(r"[A-Za-z][A-Za-z+#./-]{2,}")


def ats_report(resume_md: str, job_description: str, profile_text: str = "") -> dict:
    """Honest keyword coverage. 'ATS score' products invent a number; this only
    tells you which words from the job description appear in your document."""
    jd_text = job_description or ""
    resume_text = (resume_md or "").lower()

    def tokens(text: str) -> dict[str, int]:
        counts: dict[str, int] = {}
        for raw in _KEYWORD.findall(text or ""):
            w = raw.strip(".-/").lower()
            if len(w) < 3 or w in _STOPWORDS:
                continue
            counts[w] = counts.get(w, 0) + 1
        return counts

    jd_counts = tokens(jd_text)
    multi: dict[str, int] = {}
    for phrase in re.findall(r"\b([A-Za-z+#]+(?:\s+[A-Za-z+#]+){1,2})\b", jd_text):
        words = phrase.lower().split()
        if all(len(w) > 3 and w not in _STOPWORDS for w in words) and len(words) == 2:
            if " " + phrase.lower() + " " in (" " + jd_text.lower() + " "):
                multi[phrase.lower()] = multi.get(phrase.lower(), 0) + 1

    present, missing = [], []
    for word, freq in sorted(jd_counts.items(), key=lambda kv: -kv[1]):
        entry = {"term": word, "in_job": freq}
        if word in resume_text:
            entry["in_resume"] = resume_text.count(word)
            present.append(entry)
        elif freq >= 2:
            missing.append(entry)
    phrases = [
        {"term": p, "in_job": f}
        for p, f in sorted(multi.items(), key=lambda kv: -kv[1])[:40]
        if p not in resume_text and f >= 2
    ]
    total_jd = len(jd_counts) or 1
    coverage = round(100 * sum(1 for w in jd_counts if w in resume_text) / total_jd)
    return {
        "coverage_percent": coverage,
        "matched": present[:60],
        "missing_frequent": missing[:40],
        "missing_phrases": phrases[:20],
        "note": "Coverage is a word-presence check, not a real ATS score. No vendor can tell you an ATS score; they are per-tenant and undocumented.",
    }


def needs_input_flags(text: str) -> list[str]:
    flags = []
    for line in (text or "").splitlines():
        line = line.strip().lstrip("-*# ").strip()
        if not line:
            continue
        for m in re.finditer(r"\[[^\]]*(?:NEEDS INPUT|NEEDS REVIEW|TODO|VERIFY)[^\]]*\]", line, re.I):
            matched = m.group(0)
            inner = matched.strip("[]").strip()
            if inner.upper() in ("NEEDS INPUT", "NEEDS REVIEW", "TODO", "VERIFY"):
                pre = line[:m.start()].strip()
                words = re.findall(r"[\w.-]+", pre)
                if words:
                    flags.append(f"{words[-1]} {matched}")
                    continue
            flags.append(matched)
    return flags


def word_count(text: str) -> int:
    return len((text or "").split())


def fit_note(md: str, pages: int = 1) -> dict:
    words = len((md or "").split())
    per_page = 520 if pages == 1 else 480 * pages
    return {
        "words": words,
        "budget": per_page,
        "over": words > per_page * 1.12,
        "under": words < per_page * 0.45,
        "note": f"~{words} words; {pages}-page target is roughly {per_page} words with 10.5pt type.",
    }
