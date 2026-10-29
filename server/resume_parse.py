"""Resume extraction with the standard library only.

Order of trust: pasted text > DOCX > PDF. PDF text extraction without a real
parser is best-effort by nature (PDF has no semantic layer), so if this returns
garbage the dashboard always lets you paste the text instead.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import zipfile
from pathlib import Path

MAX_CHARS = 200_000


def clean(text: str) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u00a0", " ").replace("\u2028", "\n").replace("\u2029", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:MAX_CHARS]


# --------------------------------------------------------------------------- docx

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx_text(data: bytes) -> str:
    import xml.etree.ElementTree as ET

    with zipfile.ZipFile(__import__("io").BytesIO(data)) as zf:
        parts = ["word/document.xml"] + [n for n in zf.namelist() if re.match(r"word/(header|footer)\d*\.xml$", n)]
        chunks: list[str] = []
        for name in parts:
            if name not in zf.namelist():
                continue
            root = ET.fromstring(zf.read(name))
            for para in root.iter(f"{_W}p"):
                buf: list[str] = []
                for node in para.iter():
                    tag = node.tag.split("}")[-1]
                    if tag == "t" and node.text:
                        buf.append(node.text)
                    elif tag == "tab":
                        buf.append("\t")
                    elif tag in ("br", "cr"):
                        buf.append("\n")
                line = "".join(buf).strip()
                if line:
                    chunks.append(line)
        # blank line between sections keeps headings readable
        return clean("\n".join(chunks))


# --------------------------------------------------------------------------- pdf

_ESCAPES = {
    b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f",
    b"(": b"(", b")": b")", b"\\": b"\\",
}


def _unquote(raw: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(raw):
        ch = raw[i : i + 1]
        if ch == b"\\" and i + 1 < len(raw):
            nxt = raw[i + 1 : i + 2]
            if nxt in _ESCAPES:
                out += _ESCAPES[nxt]
                i += 2
                continue
            if nxt.isdigit():
                oct_digits = raw[i + 1 : i + 4]
                take = 0
                val = 0
                for d in oct_digits:
                    if 0x30 <= d <= 0x37 and take < 3:
                        val = val * 8 + (d - 0x30)
                        take += 1
                    else:
                        break
                if take:
                    out.append(val & 0xFF)
                    i += 1 + take
                    continue
            out += nxt
            i += 2
            continue
        out += ch
        i += 1
    return bytes(out)


def _decode_string(raw: bytes) -> str:
    data = _unquote(raw)
    if data[:2] in (b"\xfe\xff",):
        return data[2:].decode("utf-16-be", "ignore")
    if data[:3] == b"\xef\xbb\xbf":
        return data[3:].decode("utf-8", "ignore")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1252", "ignore")


def _stream_bytes(obj: bytes) -> bytes | None:
    import zlib

    m = re.search(rb"stream\r?\n", obj)
    if not m:
        return None
    end = obj.find(b"endstream", m.end())
    if end < 0:
        return None
    raw = obj[m.end() : end]
    if b"FlateDecode" in obj[: m.start()] or b"/Fl" in obj[: m.start()]:
        candidates = [raw, raw.strip(b"\r\n")]
        for cand in candidates:
            try:
                return zlib.decompress(cand)
            except zlib.error:
                try:
                    d = zlib.decompressobj()
                    return d.decompress(cand)
                except zlib.error:
                    continue
    return raw


def _text_from_content(content: bytes) -> str:
    """Pull Tj / TJ / ' / " operands out of a PDF content stream."""
    out: list[str] = []
    i = 0
    n = len(content)
    last_move = False
    while i < n:
        c = content[i : i + 1]
        if c == b"(":
            depth = 1
            j = i + 1
            while j < n and depth:
                ch = content[j : j + 1]
                if ch == b"\\":
                    j += 2
                    continue
                if ch == b"(":
                    depth += 1
                elif ch == b")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            out.append(_decode_string(content[i + 1 : j]))
            i = j + 1
            continue
        if c == b"[":  # array of strings for TJ
            j = content.find(b"]", i)
            if j < 0:
                break
            for piece in re.finditer(rb"\((?:\\.|[^\\()])*\)", content[i:j]):
                out.append(_decode_string(piece.group(0)[1:-1]))
            out.append(" ")
            i = j + 1
            continue
        if c in b"Td TD T* TM".replace(b" ", b"") and content[i : i + 3] in (b"Td ", b"TD ", b"Td\n", b"TD\n", b"T*\n", b"T* "):
            out.append("\n")
        if c in (b"T", b"'", b'"') and content[i : i + 2] in (b"Tj", b"TJ", b"T*"):
            if content[i : i + 2] == b"T*":
                out.append("\n")
        if c in (b"'", b'"') :
            out.append("\n")
        i += 1
    text = "".join(out)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def plausible_text(text: str) -> bool:
    """Is this actually readable text, or font-encoding garbage?

    A resume using a CID-font subset with no ToUnicode map decodes into thousands of
    characters that are 'letters' but not words. Feeding that into a profile is far
    worse than admitting the file could not be read.
    """
    if not text or len(text) < 20:
        return False
    printable = sum(1 for ch in text if ch.isprintable() or ch in "\n\t ")
    if printable / len(text) < 0.94:
        return False
    words = re.findall(r"[A-Za-z]{2,}", text)
    if len(words) < 3:
        return False
    if len(words) * 4 > len(text):  # nothing real reads at under ~4 characters a word
        return False
    odd = sum(1 for ch in text if not (ch.isalnum() or ch.isspace()
                                       or ch in ".,;:()-/'’\"&$%#@*+_+=/\\|~`“”‘’…–—\u2022"))
    return odd / len(text) < 0.05


def pdftotext_text(data: bytes) -> str:
    """Poppler's extractor when it is installed: it handles embedded font subsets that
    no hand-rolled parser can. Optional by design, never required."""
    exe = shutil.which("pdftotext")
    if not exe:
        return ""
    try:
        proc = subprocess.run([exe, "-layout", "-q", "-", "-"], input=data,
                              capture_output=True, timeout=60)
    except Exception:  # noqa: BLE001 - a missing or broken poppler just means we fall back
        return ""
    if proc.returncode != 0:
        return ""
    return proc.stdout.decode("utf-8", "ignore")


def pdf_text(data: bytes) -> str:
    if data[:5] != b"%PDF-":
        return ""
    pieces: list[str] = []
    for m in re.finditer(rb"<<[^<>]{0,4000}?>>\s*stream", data):
        header_start = m.start()
        stream_start = data.find(b"stream", header_start)
        obj_end = data.find(b"endstream", stream_start)
        if obj_end < 0:
            continue
        obj = data[header_start : obj_end + 9]
        if b"/Filter" in obj[: obj.find(b"stream")] and b"Flate" not in obj and b"/Fl" not in obj:
            continue
        body = _stream_bytes(obj)
        if not body:
            continue
        chunk = _text_from_content(body)
        if chunk and sum(ch.isalpha() for ch in chunk) > 20:
            pieces.append(chunk)
        if len(pieces) > 400:
            break
    text = "\n\n".join(pieces)
    letters = sum(ch.isalpha() for ch in text)
    if letters < 40:  # image-only scan, or a CID-font subset with no ToUnicode map
        return ""
    text = clean(text)
    return text if plausible_text(text) else ""


# --------------------------------------------------------------------------- entry


def extract(filename: str, data: bytes) -> dict:
    """Return {text, method, warning}."""
    name = (filename or "").lower()
    text = ""
    method = ""
    warning = ""
    try:
        if name.endswith(".docx") or data[:2] == b"PK":
            text = docx_text(data)
            method = "docx"
        elif name.endswith(".pdf") or data[:5] == b"%PDF-":
            method = "pdf"
            for reader in (pdftotext_text, pdf_text):
                candidate = reader(data)
                if candidate and plausible_text(candidate):
                    text = candidate
                    method = "pdf:" + reader.__name__.replace("_text", "")
                    break
            if not text:
                warning = (
                    "This PDF has no text layer a reader could use (scanned image, or embedded "
                    "subset fonts). Paste the resume text instead, or export it as .docx / .txt. "
                    "Guessing from garbage is worse than saying so."
                )
        elif name.endswith((".txt", ".md", ".markdown", ".rtf")):
            text = data.decode("utf-8", "ignore")
            if name.endswith(".rtf"):
                text = re.sub(r"\\[a-z]+-?\d* ?", " ", text)
                text = re.sub(r"[{}]", "", text)
            method = "text"
        else:
            text = data.decode("utf-8", "ignore")
            method = "text"
            warning = "Unknown file type; read as plain text."
    except Exception as exc:  # noqa: BLE001 - a bad upload must never take down the server
        return {"text": "", "method": "error", "warning": f"Could not read file: {exc}"}

    text = clean(text)
    if text and not warning and len(text) < 120:
        warning = "Very little text came out of that file -- check it below before generating a packet."
    return {"text": text, "method": method, "warning": warning, "chars": len(text)}


def extract_path(path: str | Path) -> dict:
    p = Path(path)
    return extract(p.name, p.read_bytes())
