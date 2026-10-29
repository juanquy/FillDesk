"""FillDesk local server: dashboard + JSON API for the browser extension.

Standard library only. Binds to 127.0.0.1 by default.

Auth model
----------
The API serves your name, address, work history, phone number and resume, so it
is not open. The dashboard (same origin) is trusted. The browser extension must
send `X-FillDesk-Token`, which you copy from the dashboard's Settings page once.
A random web page cannot read the token (cross-origin) and cannot set the header
without a preflight we decline. Run with FILLDESK_OPEN_API=1 only on a machine
you trust completely.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import socket
import sys
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from . import config, llm, packet as packet_mod, resume_export, resume_parse, sensitive, store

Handler = Callable[["Api"], dict]


class Api:
    """Parsed request handed to each route."""

    def __init__(self, method: str, path: str, query: dict, headers, body: bytes, origin: str):
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.body = body
        self.origin = origin
        self._json: Any = None

    def json(self) -> Any:
        if self._json is None:
            if not self.body:
                self._json = {}
            else:
                try:
                    self._json = json.loads(self.body.decode("utf-8"))
                except ValueError:
                    self._json = {}
        return self._json

    def q(self, key: str, default: str = "") -> str:
        return self.query.get(key, [default])[0] if key in self.query else default

    @property
    def is_dashboard(self) -> bool:
        o = (self.origin or "").lower()
        if not o:
            return True  # curl, same-page XHR without Origin (GET), health checks
        return o.startswith("http://127.0.0.1") or o.startswith("http://localhost") or o.startswith("file://")

    @property
    def is_extension(self) -> bool:
        o = (self.origin or "").lower()
        return o.startswith("chrome-extension://") or o.startswith("moz-extension://") or o.startswith("chrome-extension://")


# --------------------------------------------------------------------------- multipart


def parse_multipart(body: bytes, content_type: str) -> dict[str, dict]:
    m = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not m:
        return {}
    boundary = ("--" + m.group(1)).encode()
    parts: dict[str, dict] = {}
    for chunk in body.split(boundary):
        if chunk in (b"", b"--", b"--\r\n", b"\r\n"):
            continue
        chunk = chunk.lstrip(b"\r\n")
        if chunk.startswith(b"--"):
            continue
        head, _, payload = chunk.partition(b"\r\n\r\n")
        if not _:
            continue
        payload = payload[:-2] if payload.endswith(b"\r\n") else payload
        name = re.search(rb'name="([^"]*)"', head)
        filename = re.search(rb'filename="([^"]*)"', head)
        ctype = re.search(rb"Content-Type:\s*([^\r\n]+)", head, re.I)
        if not name:
            continue
        key = name.group(1).decode()
        parts[key] = {
            "filename": filename.group(1).decode() if filename else "",
            "content_type": ctype.group(1).decode() if ctype else "text/plain",
            "data": payload,
            "text": payload.decode("utf-8", "ignore") if not filename else "",
        }
    return parts


# --------------------------------------------------------------------------- routes

ROUTES: dict[tuple[str, re.Pattern], Handler] = {}


def route(method: str, pattern: str):
    rx = re.compile("^" + re.sub(r"<(\w+)>", r"(?P<\1>[^/]+)", pattern) + "$")

    def deco(fn: Handler) -> Handler:
        ROUTES[(method, rx)] = fn
        return fn

    return deco


def ok(payload: Any = None, **extra) -> tuple[int, dict]:
    return 200, {**(payload or {}), **extra}


def fail(message: str, code: int = 400, **extra) -> tuple[int, dict]:
    return code, {"error": message, **extra}


# -- status / config ---------------------------------------------------------

@route("GET", "/api/status")
def r_status(api: Api):
    profile = store.load_profile()
    return ok(
        {
            "app": config.APP_NAME,
            "version": config.VERSION,
            "llm": llm.status(),
            "profile": store.profile_completeness(profile),
            "profile_name": profile.get("name", ""),
            "jobs": len(store.list_jobs()),
            "packets": len(store.list_packets()),
            "stats": store.event_stats(),
            "blocked_categories": config.BLOCKED_CATEGORIES,
            "review_categories": config.REVIEW_CATEGORIES,
        }
    )


@route("GET", "/api/token")
def r_token(api: Api):
    if not api.is_dashboard:
        return fail("dashboard origin only", 403)
    return ok({"token": config.api_token(), "required": config.api_required()})


@route("GET", "/api/settings")
def r_settings_get(api: Api):
    if not api.is_dashboard:
        return fail("dashboard origin only", 403)
    s = config.load_settings()
    s["llm"]["api_key"] = "***" if s["llm"].get("api_key") else ""
    return ok(s)


@route("PUT", "/api/settings")
def r_settings_put(api: Api):
    if not api.is_dashboard:
        return fail("dashboard origin only", 403)
    patch = api.json() or {}
    if not (patch.get("llm") or {}).get("api_key"):
        patch.get("llm", {}).pop("api_key", None)  # never blank a stored key with the *** mask
    return ok(config.save_settings(patch))


@route("POST", "/api/llm/test")
def r_llm_test(api: Api):
    if not api.is_dashboard:
        return fail("dashboard origin only", 403)
    try:
        out = llm.complete("Reply with JSON only.", 'Say hello. Return {"ok": true, "greeting": "hi"}', True)
        return ok({"ok": True, "echo": out, "llm": llm.status()})
    except llm.LLMError as exc:
        return ok({"ok": False, "error": str(exc), "llm": llm.status()})


# -- profile -----------------------------------------------------------------

@route("GET", "/api/profile")
def r_profile_get(api: Api):
    profile = store.load_profile()
    return ok({**profile, "warnings": store.validate_profile(profile)})


@route("PUT", "/api/profile")
def r_profile_put(api: Api):
    patch = store.sanitize_profile(api.json() or {})
    profile = store.save_profile(patch)
    return ok({**profile, "warnings": store.validate_profile(profile)})


@route("POST", "/api/profile/resume")
def r_profile_resume(api: Api):
    parts = parse_multipart(api.body, api.headers.get("content-type", ""))
    upload = parts.get("resume") or parts.get("file")
    text_field = (parts.get("text") or {}).get("text", "")
    if not upload and not text_field:
        return fail("no file or text supplied")
    if upload and upload["data"]:
        res = resume_parse.extract(upload["filename"], upload["data"])
        if res["text"]:
            store.save_profile({"master_resume_markdown": res["text"]})
            return ok({"ok": True, **{k: v for k, v in res.items() if k != "text"}, "chars": res["chars"], "saved": True})
        return ok({"ok": False, "method": res["method"], "warning": res["warning"] or "Nothing extracted; paste the text instead."})
    store.save_profile({"master_resume_markdown": resume_parse.clean(text_field)})
    return ok({"ok": True, "method": "pasted", "saved": True})


@route("POST", "/api/parse")
def r_parse(api: Api):
    """Preview extraction without saving: {filename, base64} or {text}."""
    import base64

    payload = api.json() or {}
    if payload.get("base64"):
        data = base64.b64decode(payload["base64"])
        return ok(resume_parse.extract(payload.get("filename", "resume.pdf"), data))
    return ok(resume_parse.extract("pasted.txt", (payload.get("text") or "").encode("utf-8")))


# -- jobs --------------------------------------------------------------------

@route("GET", "/api/jobs")
def r_jobs(api: Api):
    return ok({"jobs": store.list_jobs()})


@route("POST", "/api/jobs")
def r_job_create(api: Api):
    job = store.save_job(api.json() or {})
    store.log_event("job_saved", {"job_id": job["id"], "source": job.get("source"), "host": job.get("host", "")})
    return ok(job)


@route("GET", "/api/jobs/<job_id>")
def r_job_get(api: Api, job_id: str):
    job = store.get_job(job_id)
    return ok(job) if job else fail("not found", 404)


@route("PUT", "/api/jobs/<job_id>")
def r_job_put(api: Api, job_id: str):
    existing = store.get_job(job_id)
    if not existing:
        return fail("not found", 404)
    merged = {**existing, **(api.json() or {}), "id": job_id}
    return ok(store.save_job(merged))


@route("DELETE", "/api/jobs/<job_id>")
def r_job_del(api: Api, job_id: str):
    return ok({"deleted": store.delete_job(job_id)})


@route("POST", "/api/jobs/capture")
def r_job_capture(api: Api):
    """Called by the extension's 'Save this job' button."""
    payload = api.json() or {}
    desc = payload.get("description") or ""
    job = store.save_job(
        {
            "source": "extension",
            "host": urllib.parse.urlparse(payload.get("url", "")).netloc,
            "url": payload.get("url", ""),
            "title": payload.get("title", ""),
            "company": payload.get("company", ""),
            "location": payload.get("location", ""),
            "salary": payload.get("salary", ""),
            "employment_type": payload.get("employment_type", ""),
            "posted": payload.get("posted", ""),
            "description": desc[:20000],
            "questions": payload.get("questions", [])[:40],
        }
    )
    store.log_event("job_captured", {"job_id": job["id"], "host": job.get("host"), "chars": len(desc), "questions": len(job.get("questions", []))})
    return ok({**{k: v for k, v in job.items() if k != "description"}, "description_chars": len(desc)})


@route("POST", "/api/questions/scan")
def r_questions_scan(api: Api):
    """Classify questions the extension found on a live form."""
    questions = (api.json() or {}).get("questions") or []
    return ok(sensitive.scan_questions(questions))


# -- packets -----------------------------------------------------------------

@route("GET", "/api/packets")
def r_packets(api: Api):
    return ok({"packets": store.list_packets()})


@route("POST", "/api/packets")
def r_packet_build(api: Api):
    payload = api.json() or {}
    job_id = payload.get("job_id")
    if not job_id and payload.get("job"):  # one-shot: save the job, then build from it
        job = store.save_job({**payload["job"], "source": payload["job"].get("source", "quick")})
        job_id = job["id"]
    if not job_id:
        return fail("job_id (or job) required")
    try:
        built = packet_mod.build_packet(job_id, payload.get("questions"), payload.get("provider") or "")
    except KeyError as exc:
        return fail(str(exc), 404)
    except Exception as exc:  # noqa: BLE001
        store.log_event("packet_failed", {"job_id": job_id, "error": str(exc)[:300]})
        return fail(f"packet build failed: {exc}", 500)
    return ok(built)


@route("GET", "/api/packets/<packet_id>")
def r_packet_get(api: Api, packet_id: str):
    p = store.get_packet(packet_id)
    return ok(p) if p else fail("not found", 404)


@route("PUT", "/api/packets/<packet_id>")
def r_packet_put(api: Api, packet_id: str):
    p = store.get_packet(packet_id)
    if not p:
        return fail("not found", 404)
    patch = api.json() or {}
    for key in ("resume", "cover_letter", "answers", "status", "notes"):
        if key in patch:
            if key == "resume" and isinstance(patch[key], str):
                p["resume"]["markdown"] = patch[key]
            elif key == "cover_letter" and isinstance(patch[key], str):
                p["cover_letter"] = {"text": patch[key], "words": resume_export.word_count(patch[key])}
            else:
                p[key] = patch[key]
    p["approved"] = bool(p.get("approved")) and p.get("status", "approved") == "approved"
    if p.get("resume", {}).get("markdown"):
        p["resume"]["fit"] = resume_export.fit_note(p["resume"]["markdown"])
    p["needs_input_flags"] = resume_export.needs_input_flags(
        (p.get("resume", {}).get("markdown", "") + "\n" + p.get("cover_letter", {}).get("text", "") + "\n" + "\n".join(a.get("answer", "") for a in p.get("answers", [])))
    )[:40]
    store.save_packet(p)
    return ok(p)


@route("POST", "/api/packets/<packet_id>/approve")
def r_packet_approve(api: Api, packet_id: str):
    p = store.get_packet(packet_id)
    if not p:
        return fail("not found", 404)
    blocking = [a for a in p.get("answers", []) if a.get("needs_input") and not a.get("blocked")]
    flags = p.get("needs_input_flags", [])
    force = bool((api.json() or {}).get("force"))
    if (blocking or flags) and not force:
        return ok(
            {
                "approved": False,
                "blocking": [{"question": a["question"], "note": a.get("note", "")} for a in blocking],
                "flags": flags,
                "hint": "Fill every [NEEDS INPUT] gap, or approve with force=true. Blocked compliance questions do not block approval.",
            }
        )
    p["status"] = "approved"
    p["approved"] = True
    p["approved_at"] = store.now()
    store.save_packet(p)
    refreshed = packet_mod.refresh_snapshot(packet_id) or p
    job = store.get_job(p.get("job_id") or "")
    if job:
        store.save_job({**job, "status": "packet"})
    store.log_event("packet_approved", {"packet_id": packet_id, "job_id": p.get("job_id"), "answers": len(p.get("answers", []))})
    return ok({"approved": True, "packet": refreshed})


@route("DELETE", "/api/packets/<packet_id>")
def r_packet_del(api: Api, packet_id: str):
    return ok({"deleted": store.delete_packet(packet_id)})


@route("GET", "/api/packets/<packet_id>/ats")
def r_packet_ats(api: Api, packet_id: str):
    p = store.get_packet(packet_id)
    if not p:
        return fail("not found", 404)
    job = store.get_job(p.get("job_id") or "") or {}
    return ok(resume_export.ats_report(p.get("resume", {}).get("markdown", ""), job.get("description", "")))


@route("GET", "/api/packets/<packet_id>/file")
def r_packet_file(api: Api, packet_id: str):
    """The generated documents, as bytes -- used by the dashboard and by upload injection."""
    p = store.get_packet(packet_id)
    if not p:
        return fail("not found", 404)
    if not p.get("approved"):
        return fail("packet not approved yet -- review it before the extension may use the documents", 423)
    kind = api.q("type", "resume")
    fmt = api.q("fmt", "docx").lower()
    if kind == "cover":
        text = p.get("cover_letter", {}).get("text", "")
        cover_name = f"{store.slug(p.get('company') or 'application')}-cover-letter"
        if fmt == "txt":
            return 200, {"__raw__": text.encode(), "__type__": "text/plain; charset=utf-8", "__name__": cover_name + ".txt"}
        if fmt == "docx":
            # Most portals reject a .txt cover letter, so the upload path uses DOCX.
            return 200, {"__raw__": resume_export.to_docx(text, "Cover letter"), "__type__": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "__name__": cover_name + ".docx"}
        return 200, {"__raw__": resume_export.to_html(text, "Cover letter").encode(), "__type__": "text/html; charset=utf-8"}
    md = p.get("resume", {}).get("markdown", "")
    title = f"{p.get('company') or ''} {p.get('title') or 'Resume'}".strip()
    if fmt == "txt":
        return 200, {"__raw__": md.encode(), "__type__": "text/plain; charset=utf-8"}
    if fmt == "html":
        toolbar = api.q("toolbar", "1") != "0"
        return 200, {"__raw__": resume_export.to_html(md, title or "Resume", toolbar).encode(), "__type__": "text/html; charset=utf-8"}
    name = f"{store.slug(p.get('company') or 'resume')}-{store.slug(p.get('title') or 'application')}.docx"
    return 200, {"__raw__": resume_export.to_docx(md, title or "Resume"), "__type__": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "__name__": name}


# -- autofill ----------------------------------------------------------------

@route("GET", "/api/autofill/snapshot")
def r_autofill_snapshot(api: Api):
    """What the extension is allowed to type. Approved packets only."""
    packet_id = api.q("packet_id")
    p = store.get_packet(packet_id) if packet_id else store.latest_approved_packet()
    if not p:
        return fail("no approved packet yet -- build and approve one in the dashboard", 404)
    if not p.get("approved"):
        return fail(f"packet {p['id']} is not approved", 423)
    snap = dict(p.get("profile_snapshot") or {})
    snap["approved"] = True
    snap["ats_hint"] = api.q("host", "")
    return ok(snap)


@route("GET", "/api/autofill/latest")
def r_autofill_latest(api: Api):
    packets = [p for p in store.list_packets() if p.get("approved")]
    packets.sort(key=lambda p: p.get("created_at", ""), reverse=True)
    return ok({"packets": packets[:20]})


@route("POST", "/api/events")
def r_event(api: Api):
    payload = api.json() or {}
    store.log_event(str(payload.get("event", "event"))[:40], {k: v for k, v in payload.items() if k != "event"})
    return ok({"logged": True})


# --------------------------------------------------------------------------- HTTP layer


class RequestHandler(BaseHTTPRequestHandler):
    server_version = f"FillDesk/{config.VERSION}"
    protocol_version = "HTTP/1.1"

    # ---- plumbing
    def log_message(self, fmt: str, *args: Any) -> None:  # quieter default logging
        if os.environ.get("FILLDESK_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self, origin: str) -> None:
        allowed = not origin or origin.startswith(("http://127.0.0.1", "http://localhost", "file://", "chrome-extension://", "moz-extension://"))
        if allowed and origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "content-type, x-filldesk-token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")

    def _send(self, code: int, payload: Any, extra: dict | None = None) -> None:
        extra = extra or {}
        if "__raw__" in extra:
            body = extra["__raw__"]
            ctype = extra.get("__type__", "application/octet-stream")
            self.send_response(code)
            self._cors(self.headers.get("origin", ""))
            self.send_header("Content-Type", ctype)
            if extra.get("__name__"):
                self.send_header("Content-Disposition", f'attachment; filename="{extra["__name__"]}"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors(self.headers.get("origin", ""))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_body(self) -> bytes:
        length = int(self.headers.get("content-length") or 0)
        if not length:
            return b""
        if length > 25 * 1024 * 1024:
            raise ValueError("body too large")
        return self.rfile.read(length)

    # ---- dispatch
    def _handle(self, method: str) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        origin = self.headers.get("origin", "")

        try:
            body = self._read_body()
        except ValueError as exc:
            self._send(413, {"error": str(exc)})
            return

        if path.startswith("/api/"):
            api = Api(method, path, query, self.headers, body, origin)
            token_ok = (not config.api_required()) or api.is_dashboard or (self.headers.get("x-filldesk-token") or "") == config.api_token()
            if not token_ok:
                self._send(
                    401,
                    {
                        "error": "missing or wrong X-FillDesk-Token",
                        "hint": "Open the FillDesk dashboard, Settings -> Browser extension, copy the token into the extension.",
                    },
                )
                return
            for (m, rx), handler in ROUTES.items():
                if m != method:
                    continue
                match = rx.match(path)
                if not match:
                    continue
                try:
                    code, payload = handler(api, **match.groupdict())
                except Exception as exc:  # noqa: BLE001
                    store.log_event("server_error", {"path": path, "error": str(exc)[:400]})
                    self._send(500, {"error": f"{type(exc).__name__}: {exc}"})
                    return
                if isinstance(payload, dict) and "__raw__" in payload:
                    self._send(code, {}, payload)
                else:
                    self._send(code, payload if payload is not None else {})
                return
            self._send(404, {"error": f"no route for {method} {path}"})
            return

        if method != "GET":
            self._send(405, {"error": "method not allowed"})
            return
        self._static(path)

    def _static(self, path: str) -> None:
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        candidate = (config.WEB_DIR / rel).resolve()
        if not str(candidate).startswith(str(config.WEB_DIR.resolve())) or not candidate.is_file():
            self._send(404, {"error": "not found"})
            return
        ctype = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        body = candidate.read_bytes()
        self.send_response(200)
        self._cors(origin="")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors(self.headers.get("origin", ""))
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")


def make_server(host: str = config.DEFAULT_HOST, port: int = config.DEFAULT_PORT) -> ThreadingHTTPServer:
    config.ensure_dirs()
    ThreadingHTTPServer.allow_reuse_address = True
    return ThreadingHTTPServer((host, port), RequestHandler)


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="filldesk", description="FillDesk local server (dashboard + extension API)")
    ap.add_argument("--host", default=config.DEFAULT_HOST, help="default 127.0.0.1 (keep it loopback)")
    ap.add_argument("--port", type=int, default=config.DEFAULT_PORT)
    ap.add_argument("--open", action="store_true", help="open the dashboard in your browser")
    ap.add_argument("--print-token", action="store_true")
    args = ap.parse_args(argv)

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"! binding to {args.host} exposes this API to your network. The token is your only gate.", file=sys.stderr)

    server = make_server(args.host, args.port)
    url = f"http://{'127.0.0.1' if args.host == '0.0.0.0' else args.host}:{args.port}"
    token = config.api_token()
    print(f"\n  {config.APP_NAME} {config.VERSION}  --  dashboard {url}")
    print(f"  extension token: {token}")
    print(f"  llm: {llm.status()['provider']}" + (f" ({llm.status()['model']})" if llm.status()["provider"] != "none" else " (no key: rule-based packets)"))
    print(f"  data: {config.DATA_DIR}\n  Ctrl-C to stop\n")
    if args.print_token:
        print(token)
    if args.open:
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
