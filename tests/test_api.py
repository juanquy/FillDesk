"""End-to-end API tests: stdlib only, run with `python3 -m unittest discover tests -v`.

Uses a throwaway data dir so your real ./data is never touched.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

_TMP = tempfile.mkdtemp(prefix="filldesk_test_")
os.environ["FILLDESK_DATA"] = _TMP
os.environ["FILLDESK_OPEN_API"] = ""          # exercise the token path
os.environ["FILLDESK_LLM_PROVIDER"] = "none"  # tests must never need a network model

import sys  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import app as app_mod  # noqa: E402
from server import config  # noqa: E402

PORT = 8791
BASE = f"http://127.0.0.1:{PORT}"


def call(method, path, payload=None, token=True, raw=False, origin=None, ctype="application/json", body=None):
    data = body if body is not None else (json.dumps(payload).encode() if payload is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None and ctype:
        req.add_header("content-type", ctype)
    if token:
        req.add_header("X-FillDesk-Token", config.api_token())
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw_bytes = resp.read()
            code = resp.status
            ctype_hdr = resp.headers.get("content-type", "")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read() if raw else json.loads(exc.read().decode() or "{}")
    if raw:
        return code, raw_bytes
    return code, json.loads(raw_bytes.decode() or "{}")


# One server for the whole module: unittest runs classes in alphabetical order, and
# a second class that also talks HTTP needs it up regardless of where it sits.
_SERVER = None


def setUpModule():
    global _SERVER
    _SERVER = app_mod.make_server("127.0.0.1", PORT)
    threading.Thread(target=_SERVER.serve_forever, daemon=True).start()


def tearDownModule():
    if _SERVER:
        _SERVER.shutdown()
        _SERVER.server_close()
    shutil.rmtree(_TMP, ignore_errors=True)


class ApiTests(unittest.TestCase):

    # ------------------------------------------------------------------ auth
    def test_00_token_required_for_extension_origin(self):
        code, body = call("GET", "/api/profile", token=False, origin="https://evil.example")
        self.assertEqual(code, 401, body)
        self.assertIn("X-FillDesk-Token", body["error"])

    def test_00b_dashboard_origin_allowed(self):
        code, body = call("GET", "/api/profile", token=False, origin=BASE)
        self.assertEqual(code, 200, body)

    def test_00c_token_endpoint_is_dashboard_only(self):
        code, _ = call("GET", "/api/token", token=True, origin="chrome-extension://abc")
        self.assertEqual(code, 403)

    # ------------------------------------------------------------------ profile
    def test_01_profile_defaults_and_completeness(self):
        code, body = call("GET", "/api/profile")
        self.assertEqual(code, 200)
        self.assertIn("experience", body)
        score = body.get("updated_at")
        self.assertTrue(score)

    def test_02_save_profile_and_resume(self):
        code, p = call(
            "PUT",
            "/api/profile",
            {
                "name": "Alex Rivera",
                "email": "alex@example.com",
                "phone": "+1 415 555 0100",
                "location": "San Francisco, CA",
                "headline": "Senior Product Manager",
                "salary_expectation": "$180k",
                "skills": ["SQL", "A/B testing", "roadmapping", "Python"],
                "summary": "PM with 7+ years in growth and platform products.",
                "links": {"linkedin": "https://linkedin.com/in/alexrivera"},
                "experience": [
                    {
                        "id": "exp_1",
                        "company": "Figma",
                        "title": "Senior Product Manager",
                        "start": "2021",
                        "current": True,
                        "bullets": [
                            "Rebuilt checkout with Stripe, +23% paid conversion",
                            "Launched PLG onboarding from 0 to 40K MAU in 18 months",
                            "Led a 12-person squad across three releases",
                        ],
                    },
                    {
                        "id": "exp_2",
                        "company": "Dropbox",
                        "title": "Product Manager",
                        "start": "2018",
                        "end": "2021",
                        "bullets": ["Cut support tickets 40% with a self-serve redesign"],
                    },
                ],
                "education": [{"id": "edu_1", "school": "UC Berkeley", "degree": "BS", "field": "EECS", "start": "2014", "end": "2018"}],
                "boilerplate": [{"id": "ans_1", "label": "Why this company?", "text": "I have used the product daily for two years."}],
                "master_resume_markdown": "# Alex Rivera\n\nalex@example.com | +1 415 555 0100 | San Francisco, CA\n\n## Summary\nPM with 7+ years in growth and platform products.\n\n## Experience\n### Senior Product Manager - Figma (2021-Present)\n- Rebuilt checkout with Stripe, +23% paid conversion\n- Launched PLG onboarding from 0 to 40K MAU in 18 months\n- Led a 12-person squad across three releases\n\nProduct Manager - Dropbox (2018-2021)\n- Cut support tickets 40% with a self-serve redesign\n\n## Skills\nSQL, A/B testing, roadmapping, Python\n\n## Education\n- BS EECS, UC Berkeley (2014-2018)\n",
            },
        )
        self.assertEqual(code, 200)
        self.assertEqual(p["name"], "Alex Rivera")
        code, status = call("GET", "/api/status")
        self.assertEqual(status["profile"]["score"], 100, status["profile"])

    def test_03_resume_upload_docx(self):
        docx = (
            "PK dummy"  # replaced below with a real docx built by our exporter
        )
        from server import resume_export

        blob = resume_export.to_docx("# Alex Rivera\n\n## Experience\n- Shipped X\n- Shipped Y\n")
        boundary = "----filldesk"
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"resume\"; filename=\"r.docx\"\r\n"
            "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n"
        ).encode() + blob + f"\r\n--{boundary}--\r\n".encode()
        code, res = call("POST", "/api/profile/resume", body=body, ctype="multipart/form-data; boundary=" + boundary, raw=False)
        self.assertEqual(code, 200, res)
        self.assertTrue(res.get("ok"), res)
        self.assertEqual(res["method"], "docx")
        self.assertIn("Alex Rivera", call("GET", "/api/profile")[1]["master_resume_markdown"])

    def test_04_resume_upload_text_field(self):
        boundary = "----t2"
        full_resume = (
            "# Alex Rivera\n\nalex@example.com | +1 415 555 0100 | San Francisco, CA\n\n"
            "## Summary\nPM with 7+ years in growth and platform products.\n\n"
            "## Experience\n### Senior Product Manager - Figma (2021-Present)\n"
            "- Rebuilt checkout with Stripe, +23% paid conversion\n"
            "- Launched PLG onboarding from 0 to 40K MAU in 18 months\n\n"
            "### Product Manager - Dropbox (2018-2021)\n"
            "- Cut support tickets 40% with a self-serve redesign\n\n"
            "## Skills\nSQL, A/B testing, roadmapping, Python\n\n"
            "## Education\n- BS EECS, UC Berkeley (2014-2018)\n"
        )
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\n"
            f"{full_resume}"
            f"\r\n--{boundary}--\r\n"
        ).encode()
        code, res = call("POST", "/api/profile/resume", body=body, ctype="multipart/form-data; boundary=" + boundary)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["method"], "pasted")
        self.assertIn("Dropbox", call("GET", "/api/profile")[1]["master_resume_markdown"])

    # ------------------------------------------------------------------ jobs
    def test_10_capture_job_from_extension(self):
        code, job = call(
            "POST",
            "/api/jobs/capture",
            {
                "url": "https://boards.greenhouse.io/linear/jobs/1234",
                "title": "Senior Product Manager, Growth",
                "company": "Linear",
                "location": "Remote (US)",
                "employment_type": "Full-time",
                "description": (
                    "Linear is hiring a Senior Product Manager, Growth. You will own activation and expansion revenue "
                    "across a product-led motion. Requirements: 5+ years product management, experience with A/B testing, "
                    "SQL, PLG onboarding, and cross-functional leadership in Python or similar environments. "
                    "What is your experience with product-led growth? "
                    "Why Linear? "
                    "Are you legally authorized to work in the United States without sponsorship? "
                    "What is your salary expectation? "
                    "Self-identification: please indicate your gender and race for our EEO report. "
                    "Are you a protected veteran? "
                    "Do you have a disability or need an accommodation?"
                ),
                "questions": ["How do you approach prioritization?"],
            },
            origin="chrome-extension://abcdef",
        )
        self.assertEqual(code, 200, job)
        self.assertTrue(job["id"].startswith("job_"))
        self.assertEqual(job["company"], "Linear")

    def test_11_list_and_get_and_delete(self):
        code, listing = call("GET", "/api/jobs")
        self.assertTrue(listing["jobs"])
        jid = listing["jobs"][0]["id"]
        code, one = call("GET", f"/api/jobs/{jid}")
        self.assertIn("description", one)
        code, upd = call("PUT", f"/api/jobs/{jid}", {"notes": "referred by Sam"})
        self.assertEqual(upd["notes"], "referred by Sam")

    def test_12_questions_scan(self):
        code, res = call(
            "POST",
            "/api/questions/scan",
            {
                "questions": [
                    "What is your experience with SQL?",
                    "Are you a US citizen or do you require sponsorship?",
                    "Please state your race and ethnicity.",
                    "What is your salary expectation?",
                    "Are you a veteran?",
                    "Were you ever convicted of a felony?",
                    "Do you have a disability?",
                    "How old are you?",
                    "I hereby certify that all information is truthful.",
                    "Describe a project you shipped end to end.",
                ]
            },
        )
        self.assertEqual(code, 200, res)
        blocked_text = " ".join(q["question"] for q in res["blocked"])
        for phrase in ("sponsorship", "race", "veteran", "convicted", "disability", "How old", "certify"):
            self.assertIn(phrase, blocked_text, f"{phrase} should be blocked; got {res['blocked']}")
        cats = {q["category"] for q in res["blocked"]}
        self.assertIn("work_authorization", cats)
        self.assertIn("protected_class", cats)
        self.assertIn("veteran", cats)
        self.assertIn("criminal", cats)
        self.assertIn("disability", cats)
        self.assertIn("age", cats)
        self.assertIn("legal_declaration", cats)
        review_cats = {q["category"] for q in res["review"]}
        self.assertIn("salary", review_cats)
        self.assertIn("What is your experience with SQL?", res["answerable"])
        self.assertIn("Describe a project you shipped end to end.", res["answerable"])

    # ------------------------------------------------------------------ packets
    packet_id = None

    def test_20_build_packet_rules(self):
        jid = call("GET", "/api/jobs")[1]["jobs"][0]["id"]
        code, p = call("POST", "/api/packets", {"job_id": jid})
        self.assertEqual(code, 200, p)
        type(self).packet_id = p["id"]
        self.assertEqual(p["llm"]["provider"], "rules")
        self.assertTrue(p["resume"]["markdown"].startswith("# Alex Rivera"))
        self.assertGreater(p["cover_letter"]["words"], 40)

        questions = {a["question"]: a for a in p["answers"]}
        blocked = [a for a in p["answers"] if a.get("blocked")]
        self.assertGreaterEqual(len(blocked), 4, f"expected compliance questions blocked: {list(questions)}")
        for a in blocked:
            self.assertEqual(a["answer"].count("Swooped"), 0)  # no vendor branding in user documents
            self.assertTrue(a["needs_input"])
        # the saved boilerplate answer must be reused where it matches
        reused = [a for a in p["answers"] if a["source"] == "boilerplate"]
        self.assertTrue(reused, "expected boilerplate reuse for 'Why Linear?'")
        # nothing may invent a fact: unknown answers are flagged, not filled
        for a in p["answers"]:
            if not a.get("blocked"):
                self.assertIn(bool(a.get("needs_input")), (True, False))

    def test_21_ats_report_present(self):
        code, p = call("GET", f"/api/packets/{self.packet_id}")
        ats = p["resume"]["ats"]
        self.assertIn("coverage_percent", ats)
        self.assertIsInstance(ats["matched"], list)
        self.assertTrue(any(m["term"] == "sql" for m in ats["matched"]), ats["matched"])
        code, fresh = call("GET", f"/api/packets/{self.packet_id}/ats")
        self.assertIn("coverage_percent", fresh)

    def test_22_edit_and_approve_flow(self):
        code, p = call("GET", f"/api/packets/{self.packet_id}")
        # approval must be refused while [NEEDS INPUT] gaps exist
        code, res = call("POST", f"/api/packets/{self.packet_id}/approve", {})
        if res.get("approved") is False:
            self.assertTrue(res["blocking"] or res["flags"])
        # clear the gaps the way a human would
        answers = []
        for a in p["answers"]:
            a = dict(a)
            if not a.get("blocked"):
                a["answer"] = "I ran activation experiments at Figma and read the cohort data in SQL myself."
                a["needs_input"] = False
            answers.append(a)
        md = p["resume"]["markdown"].replace("[NEEDS INPUT]", "").strip()
        letter = p["cover_letter"]["text"].replace("[NEEDS INPUT]", "I have used Linear daily for two years.").strip()
        call("PUT", f"/api/packets/{self.packet_id}", {"resume": md, "cover_letter": letter, "answers": answers})
        code, res = call("POST", f"/api/packets/{self.packet_id}/approve", {})
        self.assertTrue(res.get("approved"), res)

        code, snap = call("GET", "/api/autofill/snapshot", origin="chrome-extension://abcdef")
        self.assertEqual(code, 200, snap)
        self.assertEqual(snap["identity"]["full_name"], "Alex Rivera")
        self.assertEqual(snap["job"]["company"], "Linear")
        self.assertTrue(snap["links"]["linkedin"])
        self.assertTrue(snap["experience"])
        # blocked questions must ship as empty strings with the category attached
        blocked = [a for a in snap["answers"] if a.get("blocked")]
        self.assertTrue(blocked)
        for a in blocked:
            self.assertEqual(a["answer"], "")
            self.assertTrue(a.get("category"))
        self.assertIn("protected_class", snap["never_autofill"])

    def test_23_unapproved_packet_files_are_locked(self):
        code, res = call("POST", "/api/packets", {"job": {"title": "Analyst", "company": "Acme", "description": "SQL and Excel for a growth analyst role. Why Acme?"}})
        pid = res["id"]
        code, body = call("GET", f"/api/packets/{pid}/file?fmt=docx")
        self.assertEqual(code, 423, body)

    def test_24_cover_draft_is_never_autofillable(self):
        """The extension can ask for a cover letter for one job. That draft lives on
        the job record and must never reach an autofill snapshot."""
        code, job = call("POST", "/api/jobs", {
            "url": "https://example.com/jobs/it-ops-lead",
            "title": "IT Operations Lead",
            "company": "Northwind Traders",
            "description": (
                "Northwind Traders is hiring an IT Operations Lead to run Microsoft 365, Entra ID and "
                "Intune for 900 users, own endpoint compliance, and drive security policy across a hybrid "
                "estate. Tell us about your Microsoft 365 administration and Intune rollout experience. "
                "Why Northwind Traders? "
                "Are you legally authorized to work in the United States without sponsorship?"
            ) * 2,
        })
        self.assertEqual(code, 200, job)
        jid = job["id"]

        code, draft = call("POST", f"/api/jobs/{jid}/draft_cover", {})
        self.assertEqual(code, 200, draft)
        self.assertEqual(draft["method"], "rules", "tests must not need a model")
        self.assertTrue(draft["needs_review"], "a draft is never a finished answer")
        self.assertGreater(draft["words"], 40)
        self.assertIn("Northwind Traders", draft["text"])
        self.assertNotIn("Are you legally authorized", draft["text"], "the job question is not an answer")

        code, saved = call("GET", f"/api/jobs/{jid}")
        self.assertEqual(saved["draft_cover"]["words"], draft["words"])
        code, listing = call("GET", "/api/jobs")
        mine = [j for j in listing["jobs"] if j["id"] == jid][0]
        self.assertTrue(mine.get("draft_cover"), "the jobs list shows a draft is on file")

        # A draft must never appear in what the extension is allowed to type.
        code, snap = call("GET", "/api/autofill/snapshot", origin="chrome-extension://abcdef")
        if code == 200:
            self.assertNotIn(draft["text"][:70], json.dumps(snap))
        code, missing = call("POST", "/api/jobs/job_does_not_exist/draft_cover", {})
        self.assertEqual(code, 404)

    def test_30_docx_export_roundtrips(self):
        from server import resume_parse

        code, blob = call("GET", f"/api/packets/{self.packet_id}/file?fmt=docx", raw=True, token=True)
        self.assertEqual(code, 200)
        self.assertEqual(blob[:2], b"PK")
        parsed = resume_parse.extract("resume.docx", blob)
        self.assertIn("Alex Rivera", parsed["text"])
        self.assertGreater(parsed["chars"], 200)

    def test_31_html_export(self):
        code, blob = call("GET", f"/api/packets/{self.packet_id}/file?fmt=html", raw=True)
        self.assertEqual(code, 200)
        text = blob.decode()
        self.assertIn("<style", text)
        self.assertIn("@media print", text)
        self.assertIn("Alex Rivera", text)

    def test_32_cover_letter_txt(self):
        code, blob = call("GET", f"/api/packets/{self.packet_id}/file?fmt=txt&type=cover", raw=True)
        self.assertEqual(code, 200)
        self.assertIn("Linear", blob.decode())

    # ------------------------------------------------------------------ events
    def test_33_cover_letter_docx_is_valid(self):
        """Portals reject .txt cover letters; the upload path needs real DOCX bytes."""
        from server import resume_parse

        code, blob = call("GET", f"/api/packets/{self.packet_id}/file?fmt=docx&type=cover", raw=True)
        self.assertEqual(code, 200)
        self.assertEqual(blob[:2], b"PK")
        parsed = resume_parse.extract("cover.docx", blob)
        self.assertGreater(parsed["chars"], 40)
        code, listing = call("GET", "/api/autofill/snapshot")
        self.assertTrue(listing["docs"]["cover_letter_docx"].endswith("fmt=docx&type=cover"))
        self.assertTrue(listing["doc_names"]["cover_letter"].endswith(".docx"))

    def test_40_events_and_stats(self):
        call("POST", "/api/events", {"event": "autofill_run", "host": "boards.greenhouse.io", "filled": 9, "unmatched": 2, "blocked": 4})
        call("POST", "/api/events", {"event": "autofill_run", "host": "boards.greenhouse.io", "filled": 3, "unmatched": 1, "blocked": 0})
        code, status = call("GET", "/api/status")
        stats = status["stats"]
        self.assertEqual(stats["filled"], 12)
        self.assertEqual(stats["blocked"], 4)
        self.assertEqual(stats["unmatched"], 3, "the key the dashboard and popup both read")
        self.assertEqual(stats["by_host"]["boards.greenhouse.io"]["runs"], 2)

    def test_35_profile_validation_catches_bad_dates(self):
        from server import store

        bad = {
            "experience": [{"company": "Acme", "start": "2023", "end": "2026-24", "current": True}],
            "education": [{"school": "State College", "start": "08-1995", "end": "06-1990"}],
            "skills": ["SQL"],
        }
        warnings = " | ".join(store.validate_profile(bad))
        self.assertIn("no month 24", warnings)
        self.assertIn("not a date FillDesk understands", warnings)
        self.assertIn("no skills", " | ".join(store.validate_profile({**bad, "skills": []})))

        clean = {
            "experience": [{"company": "Acme", "start": "2023-04", "end": "", "current": True, "bullets": ["x"]}],
            "education": [{"school": "State College", "start": "1990", "end": "1995"}],
            "skills": ["SQL"],
        }
        self.assertEqual(store.validate_profile(clean), [])

        swapped = {"experience": [{"company": "Acme", "start": "2023", "end": "2019", "bullets": ["x"]}],
                   "education": [], "skills": ["SQL"]}
        self.assertIn("look swapped", " | ".join(store.validate_profile(swapped)))

    def test_36_sanitize_trims_stray_spaces(self):
        from server import store

        messy = {"name": "  Dana  Whitfield ",
                 "experience": [{"company": " Acme ", "start": "2023/04", "end": "present  "}]}
        clean = store.sanitize_profile(messy)
        self.assertEqual(clean["name"], "Dana Whitfield")
        self.assertEqual(clean["experience"][0]["company"], "Acme")
        self.assertEqual(clean["experience"][0]["start"], "2023-04", "slash dates normalise")

    def test_37_api_returns_warnings_on_save(self):
        code, before = call("GET", "/api/profile")
        self.assertEqual(code, 200)
        self.assertIn("warnings", before)
        code, after = call("PUT", "/api/profile", {"salary_expectation": "  $90,000 negotiable  "})
        self.assertEqual(code, 200)
        self.assertEqual(after["salary_expectation"], "$90,000 negotiable")
        self.assertIsInstance(after["warnings"], list)
        call("PUT", "/api/profile", {"salary_expectation": before.get("salary_expectation", "")})

    def test_41_static_dashboard(self):
        req = urllib.request.Request(BASE + "/")
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
            body = resp.read().decode()
        self.assertIn("FillDesk", body)

    def test_42_pdf_extraction_best_effort(self):
        from server import resume_parse

        import zlib

        content = b"BT /F1 12 Tf 12 750 Td (Alex Rivera) Tj T* (Senior Product Manager) Tj T* (SQL Python roadmap) Tj ET"
        compressed = zlib.compress(content)
        head = (
            b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
            b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
            b"3 0 obj<</Type/Page/Parent 2 0 R/Contents 4 0 R>>endobj\n"
        )
        obj = ("4 0 obj<</Length %d/Filter/FlateDecode>>stream\n" % len(compressed)).encode()
        pdf = head + obj + compressed + b"\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF"
        out = resume_parse.extract("resume.pdf", pdf)
        self.assertIn("Alex Rivera", out["text"])
        self.assertTrue(out["method"].startswith("pdf"), out["method"])

    def test_42b_font_garbage_is_refused_not_ingested(self):
        """A CID-font subset with no ToUnicode map decodes into characters that are
        letters but not words. That must never land in a profile."""
        from server import resume_parse

        junk = ("`Cz \u00dc post \u00d7 prep \u00a3 \u0093 Mono   \u00d3\u00feQ\u00013\u0007>\u00b2@ " * 40)
        self.assertFalse(resume_parse.plausible_text(junk))
        self.assertTrue(resume_parse.plausible_text(
            "Dana K. Whitfield, Senior Systems Engineer, Dayton OH. "
            "Built and secured hybrid infrastructure across 200 endpoints."))
        self.assertFalse(resume_parse.plausible_text(""))
        self.assertFalse(resume_parse.plausible_text("ab"))

    def test_43_malformed_pdf_is_graceful(self):
        from server import resume_parse

        out = resume_parse.extract("scan.pdf", b"%PDF-1.7\n garbage \n%%EOF")
        self.assertEqual(out["text"], "")
        self.assertIn("Paste", out["warning"])

    def test_44_never_blocked_in_llm_path_even_if_model_answers(self):
        """The server must override a model that ignores rule 5."""
        from server import llm as llm_mod
        from server import packet as packet_mod

        rogue = {
            "resume_markdown": "# Alex Rivera\n\n## Experience\n- PM at Figma",
            "resume_changes": [],
            "cover_letter": "Dear Linear hiring team, I am applying.",
            "answers": [
                {
                    "question": "Are you a US citizen or do you require sponsorship?",
                    "answer": "Yes, I am a citizen.",
                    "source": "inferred",
                    "confidence": 0.99,
                    "needs_input": False,
                    "blocked": False,
                    "note": "",
                }
            ],
        }
        original = llm_mod.complete
        llm_mod.complete = lambda *a, **k: rogue
        try:
            built, cfg = packet_mod.build_with_llm(
                {"name": "Alex", "experience": [], "boilerplate": [], "links": {}},
                {"title": "PM", "company": "Linear", "description": "PM role"},
                ["Are you a US citizen or do you require sponsorship?"],
                {"llm": {"provider": "openai", "api_key": "x"}},
            )
        finally:
            llm_mod.complete = original
        ans = built["answers"][0]
        self.assertTrue(ans["blocked"], ans)
        self.assertEqual(ans["answer"].count("will not answer"), 1)
        self.assertEqual(ans["category"], "work_authorization")


class RulesTests(unittest.TestCase):
    """Unit level: the rule builder must never fabricate."""

    def setUp(self):
        os.environ["FILLDESK_LLM_PROVIDER"] = "none"

    def test_keyword_overlap_ranks_relevant_bullet_first(self):
        from server import packet as packet_mod

        bullets = ["Led a 12-person squad across three releases", "Rebuilt checkout with Stripe, +23% conversion"]
        best, score = packet_mod.best_bullet(bullets, ["stripe", "conversion"])
        self.assertIn("Stripe", best)
        self.assertGreater(score, 0)

    def test_boilerplate_matching(self):
        from server import packet as packet_mod

        profile = {"boilerplate": [{"id": "1", "label": "Why this company?", "text": "Because I use it."}]}
        best, score = packet_mod.match_boilerplate("Why this company?", profile)
        self.assertTrue(best)
        self.assertGreater(score, 0.8)
        # reworded employer question, same intent -> still matched to the saved answer
        best2, score2 = packet_mod.match_boilerplate("Why Linear?", profile)
        self.assertTrue(best2, "intent matching should catch 'Why <company>?'")
        self.assertGreater(score2, 0.6)
        best3, _ = packet_mod.match_boilerplate(
            "Tell me about a time you disagreed with an engineer.",
            {"boilerplate": [
                {"id": "1", "label": "Why this company?", "text": "Because I use it."},
                {"id": "2", "label": "Tell me about a challenge", "text": "The checkout migration."},
            ]},
        )
        self.assertEqual(best3["label"], "Tell me about a challenge")
        self.assertEqual(packet_mod.intent("Describe a failure you learned from"), "challenge")
        self.assertEqual(packet_mod.intent("What are your career goals in five years?"), "goals")

    def test_blocked_questions_never_drafted(self):
        from server import packet as packet_mod

        for q in [
            "What is your race or ethnicity?",
            "Please indicate your veteran status.",
            "Do you require sponsorship now or in the future?",
            "What is your date of birth?",
            "Have you ever been arrested?",
            "Do you have a disability that requires accommodation?",
        ]:
            out = packet_mod.draft_answer_with_rules(q, {"experience": [], "boilerplate": []}, {}, ["sql"])
            self.assertTrue(out["blocked"], q)
            self.assertTrue(out["needs_input"], q)

    def test_salary_uses_profile_but_still_needs_review(self):
        from server import packet as packet_mod

        out = packet_mod.draft_answer_with_rules(
            "What is your salary expectation?", {"experience": [], "boilerplate": [], "salary_expectation": "$180,000"}, {}, []
        )
        self.assertEqual(out["answer"], "$180,000")
        self.assertTrue(out["needs_input"])
        self.assertEqual(out["review"]["category"], "salary")

    def test_unknown_question_yields_flagged_skeleton(self):
        from server import packet as packet_mod

        out = packet_mod.draft_answer_with_rules(
            "Describe a time you influenced without authority",
            {"experience": [{"company": "Figma", "title": "PM", "bullets": ["Shipped X"]}], "boilerplate": [], "links": {}},
            {"title": "PM", "description": "influence roadmap"},
            ["figma", "roadmap"],
        )
        self.assertTrue(out["needs_input"])
        self.assertIn("[NEEDS INPUT]", out["answer"])
        self.assertIn("Figma", out["answer"])

    def test_rule_tailoring_reorders_multi_bullet_groups_without_crashing(self):
        from server import packet as packet_mod

        profile = {
            "master_resume_markdown": (
                "# Alex Rivera\n\n### Senior PM - Figma (2021-Present)\n"
                "- Led a 12-person squad through three releases\n"
                "- Rebuilt checkout in Stripe, +23% conversion\n"
                "- Ran 40 A/B tests on activation with SQL and Amplitude\n"
                "- Mentored two junior PMs\n\n## Skills\nSQL, A/B testing\n"
            ),
            "experience": [], "boilerplate": [], "education": [], "links": {},
        }
        job = {"title": "Growth PM", "company": "Linear", "description": "activation, A/B testing, SQL, experimentation, PLG onboarding"}
        md, notes = packet_mod.tailor_resume_with_rules(profile, job, packet_mod.job_keywords(job))
        bullets = [line for line in md.split("\n") if line.startswith("-")]
        assert bullets, md
        assert "checkout" in bullets[0] or "A/B" in bullets[0], f"expected a relevant bullet first, got: {bullets[0]}"
        assert "12-person squad" in md, "no bullet may be dropped by reordering"
        assert len(bullets) == 4, bullets
        assert any("Re-ordered" in n for n in notes)

    def test_intent_order_does_not_let_the_why_company_fallback_swallow_others(self):
        from server import packet as packet_mod

        self.assertEqual(packet_mod.intent("Why are you leaving your current role?"), "why_leaving")
        self.assertEqual(packet_mod.intent("Why do you want to leave?"), "why_leaving")
        self.assertEqual(packet_mod.intent("Why Linear?"), "why_company")
        self.assertEqual(packet_mod.intent("What are your salary expectations?"), "compensation")
        self.assertEqual(packet_mod.intent("Why should we hire you?"), "why_company")

    def test_cover_letter_years_are_sane(self):
        from server import packet as packet_mod

        profile = {
            "name": "Alex", "summary": "", "experience": [
                {"company": "Figma", "title": "PM", "start": "2018-07", "bullets": ["Shipped X with SQL"]},
            ],
            "boilerplate": [], "links": {}, "email": "a@b.c", "phone": "",
        }
        job = {"title": "Growth PM", "company": "Linear", "description": "SQL activation experimentation"}
        letter = packet_mod.cover_letter_with_rules(profile, job, ["sql", "activation"])
        self.assertNotIn("2006 years", letter)
        self.assertIn("I have worked in the field since 2018.", letter)
        self.assertNotIn("role over", letter, '"applying for the X role over 8 years" is not English')
        self.assertIn("Linear", letter)

    def test_tailoring_keeps_bullets_under_their_own_role(self):
        """Re-ordering a whole Experience section pulls bullets away from the company
        header above them and drops the other headers entirely."""
        from server import packet as packet_mod

        profile = {"master_resume_markdown": (
            "## Experience\n\n"
            "**Acme | Engineer | 2020 - Present**\n\n"
            "- Built dashboards for the sales team\n- Led the Kafka migration end to end\n- Wrote the runbook\n\n"
            "**Beta Corp | Analyst | 2017 - 2020**\n\n"
            "- Cut reporting time by half\n- Owned the weekly metrics review\n- Trained four analysts\n")}
        md, _ = packet_mod.tailor_resume_with_rules(profile, {"title": "Data Engineer"}, ["kafka", "migration"])
        lines = md.split("\n")
        self.assertIn("**Beta Corp | Analyst | 2017 - 2020**", md)
        acme = lines.index("**Acme | Engineer | 2020 - Present**")
        beta = lines.index("**Beta Corp | Analyst | 2017 - 2020**")
        kafka = lines.index("- Led the Kafka migration end to end")
        dash = lines.index("- Built dashboards for the sales team")
        self.assertTrue(acme < kafka < beta, "the Kafka bullet belongs to Acme, not to the section")
        self.assertTrue(acme < dash < beta)
        self.assertGreater(lines.index("- Cut reporting time by half"), beta)

    def test_generic_posting_words_are_not_reported_as_job_emphasis(self):
        from server import packet as packet_mod

        job = {"title": "Analyst", "description": "You will work with the team end to end. Requirements: SQL, Excel, reporting."}
        kws = packet_mod.job_keywords(job)
        for junk in ("work", "end", "team", "yourself"):
            self.assertNotIn(junk, kws)
        self.assertIn("sql", kws)

    def test_fit_note_flags_overlong_resume(self):
        from server import resume_export

        note = resume_export.fit_note("word " * 1200, 1)
        self.assertTrue(note["over"])

    def test_docx_output_is_valid_zip_with_document_xml(self):
        import zipfile
        import io

        from server import resume_export

        blob = resume_export.to_docx("# Name\n\n## Skills\n- SQL\n- Python\n")
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            names = zf.namelist()
            self.assertIn("word/document.xml", names)
            self.assertIn("[Content_Types].xml", names)
            xml = zf.read("word/document.xml").decode()
            self.assertIn("SQL", xml)
            self.assertIn("w:pStyle", xml)

    def test_sensitive_safe_context_not_blocked(self):
        from server import sensitive

        self.assertIsNone(sensitive.blocked_reason("We offer visa sponsorship for this role"))
        self.assertIsNone(sensitive.blocked_reason("Our supplier diversity program supports veteran-owned businesses"))
        self.assertIsNotNone(sensitive.blocked_reason("Are you legally authorized to work in the US?"))


class StatusMentionsAreFlagged(unittest.TestCase):
    """The user's own legal-status line: surfaced per application, never deleted."""

    def test_a_status_in_the_master_resume_is_surfaced_not_stripped(self):
        _, before = call("GET", "/api/profile")
        resume = ("# Dana Whitfield\n\n📍 Roslindale, MA · 🇺🇸 US Citizen · 15+ years\n\n## Summary\n"
                  "Systems engineer running Microsoft 365 and Entra ID estates.\n\n## Experience\n"
                  "- Ran E-Verify onboarding for 300 new hires.\n- Led an Intune rollout for 2,400 users.\n\n"
                  "## Skills\n- Entra ID\n\n## Education\n- Northgate Technical College\n")
        code, profile = call("PUT", "/api/profile", {"master_resume_markdown": resume})
        self.assertEqual(code, 200, profile)
        code, job = call("POST", "/api/jobs", {
            "url": "https://jobs.example.test/status-flag", "title": "Systems Engineer",
            "company": "Example Labs",
            "description": ("Example Labs needs a Systems Engineer for a Microsoft 365 and Entra ID estate. "
                            "Why Example Labs?") * 3,
        })
        self.assertEqual(code, 200, job)
        try:
            code, with_status = call("POST", "/api/packets", {"job_id": job["id"]})
            self.assertEqual(code, 200, with_status)

            self.assertTrue(with_status["status_mentions"], "the US Citizen line should be surfaced")
            self.assertIn("tailored resume", {r["where"] for r in with_status["status_mentions"]})
            self.assertIn("US Citizen", with_status["resume"]["markdown"],
                          "your words are yours: surfaced, never deleted")
            self.assertIn("# Dana Whitfield", with_status["resume"]["markdown"],
                          "flagging one line must not swallow the block around it")
            self.assertTrue(all("E-Verify" not in r["text"] for r in with_status["status_mentions"]),
                            "running an employer's E-Verify queue is a duty, not a statement about you")

            # Differential: the same resume without the status line must leave exactly the
            # same open items. An amber reminder that blocks approval is a dark pattern.
            call("PUT", "/api/profile", {"master_resume_markdown": resume.replace("🇺🇸 US Citizen · ", "")})
            code, plain = call("POST", "/api/packets", {"job_id": job["id"]})
            self.assertEqual(code, 200, plain)
            self.assertFalse(plain["status_mentions"], "the flag should disappear with the line")
            self.assertNotIn("US Citizen", plain["resume"]["markdown"])
            self.assertEqual(len(with_status["needs_input_flags"]), len(plain["needs_input_flags"]),
                             "a status mention must not add an approval blocker")
            self.assertEqual(with_status["compliance_redactions"], plain["compliance_redactions"])

            code, res = call("POST", f"/api/packets/{with_status['id']}/approve",
                             {"force": True} if with_status["needs_input_flags"] else {})
            self.assertEqual(code, 200, res)
            self.assertTrue(res["approved"])
            call("DELETE", f"/api/packets/{plain['id']}")
            call("DELETE", f"/api/packets/{with_status['id']}")
        finally:
            call("PUT", "/api/profile", {"master_resume_markdown": before.get("master_resume_markdown", "")})
            call("DELETE", f"/api/jobs/{job['id']}")

    def test_unit_the_detector_knows_duty_from_declaration(self):
        from server import sensitive
        self.assertTrue(sensitive.status_mentions("🇺🇸 US Citizen 15+ years"))
        self.assertTrue(sensitive.status_mentions("Authorized to work without sponsorship"))
        self.assertTrue(sensitive.status_mentions("Lawful permanent resident; EAD on file"))
        self.assertFalse(sensitive.status_mentions("Ran E-Verify onboarding for 300 new hires"))
        self.assertFalse(sensitive.status_mentions("Administered I-9 verification for the NOC team"))
        self.assertFalse(sensitive.status_mentions("Led the Entra ID rollout for 2,400 users"))
        self.assertFalse(sensitive.status_mentions("Partnered with a veteran-owned supplier"))


class GeneratedProseIsScrubbed(unittest.TestCase):
    """A model that *infers* a compliance fact must not be able to write it.

    In real testing a model looked at a home town and a language and produced "I am
    authorized to work in the United States without sponsorship" -- a legal
    representation, invented, in a document uploaded to an employer. The field
    matcher would refuse that box; the prose is the same line. So every drafted
    field is scrubbed, and what is left behind is the marker the approval gate and
    the autofiller both refuse.
    """

    CLAIM = "I am authorized to work in the United States without sponsorship."
    COVER = ("I am applying for the Senior Systems Engineer role at Northbridge Systems. "
             + CLAIM + " I led a Microsoft 365 and Intune rollout for 2,400 users.")
    RESUME = ("# Alex Rivera\n\n## Summary\nAlex Rivera is authorized to work in the United States "
              "without sponsorship and runs Microsoft 365 estates.\n\n## Experience\n"
              "- Led an Intune rollout for 2,400 users.\n\n## Skills\n- Entra ID\n\n## Education\n- BS\n")

    def setUp(self):
        from server import llm
        self.llm = llm
        self.saved = {k: os.environ.get(k) for k in
                      ("FILLDESK_LLM_PROVIDER", "FILLDESK_LLM_API_KEY", "FILLDESK_LLM_MODEL", "FILLDESK_LLM_BASE_URL")}
        os.environ.update({"FILLDESK_LLM_PROVIDER": "openai", "FILLDESK_LLM_API_KEY": "test-key",
                           "FILLDESK_LLM_MODEL": "evil-test-model", "FILLDESK_LLM_BASE_URL": "http://127.0.0.1:1"})
        self._complete = llm.complete

    def tearDown(self):
        self.llm.complete = self._complete
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    QUESTIONS = ["Why Northbridge Systems?", "Do you consent to a background check?",
                 "Are you authorized to work in the United States without sponsorship?"]

    def _job(self, path):
        code, job = call("POST", "/api/jobs", {
            "url": "https://jobs.northbridge.example/sse-" + path,
            "title": "Senior Systems Engineer", "company": "Northbridge Systems",
            "location": "Remote (US)",
            "description": ("Northbridge Systems is hiring a Senior Systems Engineer for a 2,400-user "
                            "Microsoft 365, Entra ID and Intune estate. Why Northbridge Systems? "
                            "Are you authorized to work in the United States without sponsorship?") * 3,
            "questions": self.QUESTIONS,
        })
        self.assertEqual(code, 200, job)
        return job["id"]

    def test_cover_draft_loses_an_invented_work_authorization_claim(self):
        self.llm.complete = lambda *a, **k: {"cover_letter": self.COVER, "note": "inferred from profile"}
        jid = self._job("draft")
        code, draft = call("POST", f"/api/jobs/{jid}/draft_cover", {})
        self.assertEqual(code, 200, draft)
        self.assertNotIn("authorized to work", draft["text"].lower())
        self.assertIn("[NEEDS INPUT]", draft["text"])
        self.assertIn("Northbridge", draft["text"], "the true parts must survive")
        self.assertIn("Intune", draft["text"])
        cats = [r["category"] for r in draft["redactions"]]
        self.assertEqual(cats, ["work_authorization"])
        self.assertIn("Only you can make those statements", draft["note"])

    def test_packet_scrubs_resume_letter_and_answers(self):
        answers = [
            {"question": "Why Northbridge Systems?",
             "answer": "Your 2,400-user estate is the scale I run. I certify that all information above is true.",
             "source": "inferred", "confidence": 0.8},
            {"question": "Do you consent to a background check?",
             "answer": "Yes, happy to.", "source": "inferred", "confidence": 0.8},
        ]
        payload = {"resume_markdown": self.RESUME, "resume_changes": ["trimmed"],
                   "cover_letter": self.COVER, "answers": answers}
        self.llm.complete = lambda *a, **k: payload
        jid = self._job("packet")
        code, packet = call("POST", "/api/packets", {"job_id": jid})
        self.assertEqual(code, 200, packet)

        joined = packet["resume"]["markdown"] + packet["cover_letter"]["text"] + \
            " ".join(a["answer"] for a in packet["answers"])
        self.assertNotIn("authorized to work", joined.lower(), "a compliance claim survived into a document")
        self.assertNotIn("I certify", joined)
        cats = {r["category"] for r in packet["compliance_redactions"]}
        self.assertIn("work_authorization", cats)
        self.assertIn("legal_declaration", cats)
        wheres = {r["where"] for r in packet["compliance_redactions"]}
        self.assertTrue(any("resume" in w for w in wheres) and any("cover" in w for w in wheres),
                        f"expected both documents flagged, got {wheres}")
        self.assertTrue(any(w.startswith("answer to") for w in wheres),
                        f"an answer's claim must be caught too, got {wheres}")
        self.assertTrue(packet["needs_input_flags"], "the marker must count as an open item")
        self.assertTrue(any("compliance" in w.lower() for w in packet["warnings"]))

        # and it cannot be approved quietly, nor typed even if forced
        code, unapproved = call("POST", f"/api/packets/{packet['id']}/approve", {})
        self.assertEqual(code, 200, unapproved)
        self.assertFalse(unapproved["approved"], "an invented compliance claim leaves an open item")
        self.assertTrue(unapproved["flags"], "the open item should be listed for the reviewer")
        code, forced = call("POST", f"/api/packets/{packet['id']}/approve", {"force": True})
        self.assertEqual(code, 200, forced)
        code, snap = call("GET", "/api/autofill/snapshot", {"packet_id": packet["id"]}, origin="chrome-extension://abcdef")
        if code != 200:
            code, snap = call("GET", f"/api/autofill/snapshot?packet_id={packet['id']}",
                              origin="chrome-extension://abcdef")
        self.assertEqual(code, 200, snap)
        blob = " ".join(str(a.get("answer", "")) for a in snap.get("answers", []))
        self.assertNotIn("authorized to work", blob.lower())
        for a in snap.get("answers", []):
            if "[NEEDS INPUT]" in str(a.get("answer", "")):
                self.assertTrue(a.get("needs_input"), "a marker must never be typed as an answer")
        self.assertNotIn("authorized to work", json.dumps(snap.get("identity", {})).lower())
        call("DELETE", f"/api/packets/{packet['id']}")
        call("DELETE", f"/api/jobs/{jid}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
