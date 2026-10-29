"""Static checks on the extension and dashboard.

No browser is available in CI, so these assert the things that break silently:
syntax, manifest references, service-worker purity, and the two-language parity of
the compliance rules (Python side and JS side must refuse the same categories).

Run: python3 tests/test_extension.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import unittest
import urllib.request
import time
import tempfile
import shutil
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # images are checked only when Pillow is present
    Image = None

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import config  # noqa: E402

EXT = ROOT / "extension"
WEB = ROOT / "web"


def node_available() -> bool:
    try:
        subprocess.run(["node", "--version"], capture_output=True, timeout=10, check=True)
        return True
    except Exception:  # noqa: BLE001
        return False


def find_browser():
    for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
        found = shutil.which(name)
        if found:
            return found
    return None


def render_dom(profile_payload, suffix="", port=8795, wait_ms=6000):
    """Serve a throwaway profile and return the DOM a real Chromium builds for it.

    Layout and binding bugs are invisible to grep: a marker that lands outside its tag,
    or a label column that a third-party stylesheet raggies, both look fine in source.
    Returns None when no browser is installed so callers can skip rather than fail.
    """
    browser = find_browser()
    if not browser:
        return None
    tmp = Path(tempfile.mkdtemp(prefix="filldesk_render_"))
    env = {**os.environ, "FILLDESK_DATA": str(tmp / "data"),
           "FILLDESK_LLM_PROVIDER": "none", "DISPLAY": ""}
    server = subprocess.Popen([sys.executable, "-m", "server", "--port", str(port)],
                              cwd=str(ROOT), env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        base = f"http://127.0.0.1:{port}"
        token = tmp / "data" / "api_token"
        for _ in range(80):
            try:
                token.read_text()
                urllib.request.urlopen(base + "/api/status", timeout=1).read()
                break
            except Exception:  # noqa: BLE001 - wait for boot
                time.sleep(0.1)
        else:
            raise AssertionError("throwaway server never came up")
        if profile_payload:
            req = urllib.request.Request(
                base + "/api/profile", method="PUT",
                headers={"content-type": "application/json",
                         "x-filldesk-token": token.read_text().strip()},
                data=json.dumps(profile_payload).encode())
            urllib.request.urlopen(req, timeout=5).read()
        return subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--no-first-run",
             "--user-data-dir=" + str(tmp / "profile"), "--window-size=1440,1400",
             f"--virtual-time-budget={wait_ms}", "--dump-dom", base + "/" + suffix],
            capture_output=True, text=True, timeout=120, env=env).stdout
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except Exception:  # noqa: BLE001
            server.kill()
        shutil.rmtree(tmp, ignore_errors=True)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((EXT / "manifest.json").read_text())

    def test_required_keys(self):
        self.assertEqual(self.manifest["manifest_version"], 3)
        for key in ("name", "version", "description", "background", "action", "icons", "content_scripts"):
            self.assertIn(key, self.manifest)

    def test_referenced_files_exist(self):
        paths = set()
        paths.add(self.manifest["background"]["service_worker"])
        paths.add(self.manifest["action"]["default_popup"])
        for sizes in (self.manifest["icons"], self.manifest["action"]["default_icon"]):
            paths.update(sizes.values())
        for cs in self.manifest["content_scripts"]:
            paths.update(cs["js"])
        for p in sorted(paths):
            self.assertTrue((EXT / p).is_file(), f"manifest references missing file {p}")

    def test_host_permissions_are_loopback_only(self):
        hosts = self.manifest["host_permissions"]
        self.assertTrue(all("127.0.0.1" in h or "localhost" in h or "::1" in h for h in hosts), hosts)

    def test_content_scripts_are_web_pages_only(self):
        for cs in self.manifest["content_scripts"]:
            for pattern in cs["matches"]:
                self.assertTrue(pattern.startswith("http"), pattern)
                self.assertNotIn("<all_urls>", pattern)

    def test_no_submit_anywhere_in_extension(self):
        """Nothing in the extension may submit a form. Not as a fallback, not ever."""
        for js in EXT.glob("*.js"):
            src = js.read_text()
            for forbidden in (".submit(", "requestSubmit(", "dispatchEvent(new Event('submit'", "HTMLFormElement"):
                self.assertNotIn(forbidden, src, f"{js.name} must not contain {forbidden}")

    def test_every_click_is_guarded(self):
        """A click must be guarded: Next/Continue only, or a checkbox/radio the user asked for."""
        src = (EXT / "content.js").read_text()
        lines = src.splitlines()
        for i, line in enumerate(lines):
            if ".click(" not in line or line.strip().startswith("//"):
                continue
            blob = "\n".join(lines[max(0, i - 14) : i + 2])
            guarded = any(marker in blob for marker in ("isNextText", "booleanFor", "checked"))
            self.assertTrue(guarded, f"unguarded click near line {i}: {line.strip()}")

    def test_content_script_avoids_unavailable_apis(self):
        src = (EXT / "content.js").read_text()
        self.assertNotIn("chrome.tabs.", src, "chrome.tabs is not available in a content script")
        self.assertNotIn("chrome.notifications", src)

    def test_service_worker_has_no_dom(self):
        src = (EXT / "background.js").read_text()
        for token in ("document.", "window.", "localStorage"):
            self.assertNotIn(token, src, f"service worker cannot use {token}")


class SyntaxTests(unittest.TestCase):
    @unittest.skipUnless(node_available(), "node not installed")
    def test_js_syntax(self):
        for js in sorted(list(EXT.glob("*.js")) + list(WEB.glob("*.js"))):
            proc = subprocess.run(["node", "--check", str(js)], capture_output=True, text=True, timeout=60)
            self.assertEqual(proc.returncode, 0, f"{js.name}: {proc.stderr[:600]}")


class ParityTests(unittest.TestCase):
    """The Python packet builder and the JS filler must refuse the same things."""

    def _js_categories(self) -> set[str]:
        src = (EXT / "matcher.js").read_text()
        block = src[src.index("const BLOCKED = ["):src.index("].map(([category, rx])")]
        return set(re.findall(r"\['([a-z_]+)',", block))

    def test_blocked_categories_match(self):
        py = set(config.BLOCKED_CATEGORIES)
        js = self._js_categories()
        self.assertTrue(py.issubset(js), f"JS filler is missing categories: {sorted(py - js)}")

    def test_server_refuses_the_same_categories(self):
        from server import sensitive

        samples = {
            "protected_class": "What is your gender identity?",
            "disability": "Do you need a reasonable accommodation?",
            "veteran": "Are you a protected veteran?",
            "work_authorization": "Do you require visa sponsorship?",
            "age": "What is your date of birth?",
            "criminal": "Have you ever been convicted of a crime?",
            "legal_declaration": "I hereby certify this information is accurate.",
            "health": "Do you have a health condition we should know about?",
        }
        for category, question in samples.items():
            self.assertIsNotNone(sensitive.blocked_reason(question), question)
            self.assertEqual(sensitive.blocked_reason(question)["category"], category)


class DashboardTests(unittest.TestCase):
    def test_assets_referenced_exist(self):
        html = (WEB / "index.html").read_text()
        for src in re.findall(r'(?:src|href)="(/[\w.\-/]+)"', html):
            if src.startswith("/shared/"):
                # Served from extension/ by exact name (one file, two consumers), so
                # the file check happens there and the route has to name it.
                name = src[len("/shared/"):]
                self.assertTrue((EXT / name).is_file(), f"shared asset {src} has no source file")
                self.assertIn(f'"{name}"', (ROOT / "server" / "app.py").read_text(),
                              f"{src} is not served by a named route")
                continue
            self.assertTrue((WEB / src.lstrip("/")).is_file(), f"dashboard references missing {src}")
        js = (WEB / "app.js").read_text()
        for endpoint in set(re.findall(r"api\(['\"`]/([\w/<>\-.]+)", js)):
            self.assertTrue(any(token in endpoint for token in ("status", "token", "settings", "llm", "profile", "jobs", "packets", "parse")), endpoint)

    def test_id_bindings_line_up(self):
        html = (WEB / "index.html").read_text()
        js = (WEB / "app.js").read_text()
        ids_in_js = set(re.findall(r"\$\('#([\w-]+)'\)", js))
        ids_in_html = set(re.findall(r'id="([\w-]+)"', html))
        # Some ids only exist inside a modal that app.js builds itself. An id is
        # exempt only when app.js literally writes it, so a typo still fails here.
        ids_written_by_js = set(re.findall(r'id="([\w-]+)"', js))
        missing = sorted(ids_in_js - ids_in_html - ids_written_by_js)
        self.assertFalse(missing, f"app.js binds ids that the dashboard does not define: {missing}")


class DatePickers(unittest.TestCase):
    """Dates are where an autofiller quietly lies, so picking one beats typing one.

    One widget file serves both surfaces: the dashboard loads it over the loopback
    API, the extension loads it as a content script. These check the wiring on both
    sides and that nothing that used to be typed is now impossible to enter.
    """

    def setUp(self):
        self.cal = (EXT / "datepicker.js").read_text()
        self.content = (EXT / "content.js").read_text()
        self.manifest = json.loads((EXT / "manifest.json").read_text())
        self.index = (WEB / "index.html").read_text()
        self.dash = (WEB / "app.js").read_text()
        self.server = (ROOT / "server" / "app.py").read_text()

    def has(self, haystack, needle, why):
        self.assertTrue(needle in haystack, why)

    def test_one_widget_file_serves_both_callers(self):
        js = self.manifest["content_scripts"][0]["js"]
        self.assertIn("datepicker.js", js, "the extension never loads the calendar")
        self.assertLess(js.index("datepicker.js"), js.index("content.js"),
                        "content.js needs the widget before it runs")
        self.has(self.index, 'src="/shared/datepicker.js"', "the dashboard never loads the calendar")
        self.has(self.server, '"/shared/"', "the route for it is missing")
        self.has(self.server, 'if name != "datepicker.js"',
                 "the shared-script route must list files by name, not by path")

    def test_profile_date_fields_are_pickers(self):
        for needle in ("cal: 'ym'", "cal: 'y'"):
            self.has(self.dash, needle, "start/end years still want typing")
        self.has(self.dash, 'data-cal="${f.cal}"', "the field renderer drops the picker marker")
        self.has(self.dash, "function bindCalendars", "no binding helper")
        self.has(self.dash, "bindCalendars(host)", "renders do not bind pickers")
        self.has(self.index, 'id="p-start" placeholder="4 weeks after offer" data-cal="mdy"',
                 "earliest start keeps its prose answer and gains a picker")

    def test_the_extension_panel_can_pick_a_date_too(self):
        for el in ("fd-revd", "fd-rdate", "fd-rdatehint"):
            self.has(self.content, f'id="{el}"', f"{el} missing from the review card")
        self.has(self.content, "function openDatePicker", "no picker in the panel")
        self.has(self.content, "M.formatDate(chosen, desc)",
                 "a picked date must be re-shaped into what this field asked for")
        self.has(self.content, "root: mountRoot", "the picker must mount inside the panel's shadow root")
        self.has(self.content, "date cleared", "clearing a date hands the field back to the user")

    def test_the_widget_refuses_to_invent_a_day(self):
        self.has(self.cal, "no invented day, ever" if "no invented day, ever" in self.cal
                 else "A bare year is a valid answer", "the widget must say a year is a fine answer")
        self.has(self.cal, "if (parts.month != null && (parts.month < 1 || parts.month > 12)) return false;",
                 "month 13 has to be refused in code")
        self.has(self.cal, "composedPath", "outside-click handling must survive shadow DOM retargeting")

    @staticmethod
    def _browser():
        return find_browser()

    @unittest.skipUnless(True, "runs only when a Chromium browser is installed")
    def test_dashboard_renders_every_picker(self):
        """A static grep cannot see a marker that lands outside its tag — that exact
        mistake shipped once and left 14 date fields without a button. So render the
        page with a throwaway profile and count what the browser actually built.
        """
        browser = self._browser()
        if not browser:
            self.skipTest("no Chromium browser available")
        tmp = Path(tempfile.mkdtemp(prefix="filldesk_render_"))
        port = 8793
        env = {**os.environ, "FILLDESK_DATA": str(tmp / "data"), "FILLDESK_LLM_PROVIDER": "none", "DISPLAY": ""}
        server = subprocess.Popen([sys.executable, "-m", "server", "--port", str(port)],
                                  cwd=str(ROOT), env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            base = f"http://127.0.0.1:{port}"
            token = (tmp / "data" / "api_token")
            for _ in range(80):
                try:
                    token.read_text()
                    urllib.request.urlopen(base + "/api/status", timeout=1).read()
                    break
                except Exception:  # noqa: BLE001 - keep waiting for boot
                    time.sleep(0.1)
            else:
                self.fail("throwaway server never came up")

            # Two jobs and one degree: the fields under test are rendered from the
            # profile, not written in the HTML.
            req = urllib.request.Request(base + "/api/profile", method="PUT",
                                        headers={"content-type": "application/json",
                                                 "x-filldesk-token": token.read_text().strip()},
                                        data=json.dumps({"experience": [
                                            {"company": "A", "title": "B", "start": "2021-06", "end": "2023"},
                                            {"company": "C", "title": "D", "start": "2018", "end": "Present"}],
                                            "education": [{"school": "S", "start": "1990", "end": "1995"}]}).encode())
            urllib.request.urlopen(req, timeout=5).read()

            dom = subprocess.run([browser, "--headless=new", "--disable-gpu", "--no-first-run",
                                  "--user-data-dir=" + str(tmp / "profile"),
                                  "--virtual-time-budget=6000", "--dump-dom", base + "/"],
                                 capture_output=True, text=True, timeout=120, env=env).stdout
            marked = len(re.findall(r'<(?:input|textarea)[^>]*data-cal=', dom))
            buttons = dom.count('class="calbtn"')
            self.assertGreaterEqual(marked, 5, f"expected date fields to be marked, saw {marked}")
            self.assertEqual(marked, buttons,
                             f"{marked} date fields rendered but {buttons} calendar buttons")
            self.assertEqual(dom.count('data-cal="ym"'), 4, "each job has a start and an end month")
            self.assertEqual(dom.count('data-cal="y"'), 2, "schooling is year-only")
            self.assertIn('data-cal="mdy"', dom, "earliest start keeps a full-date picker")
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except Exception:  # noqa: BLE001
                server.kill()
            shutil.rmtree(tmp, ignore_errors=True)

    def test_review_toggle_off_state_is_not_the_disabled_look(self):
        off = self.content[self.content.index(".btn.off{"):][:120]
        self.assertTrue("opacity" not in off,
                        "a dimmed button reads as disabled; use a dashed outline instead")
        self.has(self.content, "Ask per field ✓", "the button should show which state it is in")


class RefusedQuestionGuidance(unittest.TestCase):
    """Answering a work-authorization question should cost one click, not a search for
    the legal vocabulary. FillDesk still never answers it for you."""

    def test_the_panel_names_the_honest_options(self):
        content = (EXT / "content.js").read_text()
        self.assertIn("BLOCK_HINTS", content, "refused fields carry no guidance")
        for phrase in ("US citizen", "permanent resident", "H-1B", "EAD", "prefer not to say"):
            self.assertIn(phrase, content, f"the work-authorization hint should name {phrase}")
        self.assertIn("voluntary — blank is a fine answer", content,
                      "self-identification should say that skipping is legitimate")
        self.assertIn("white-space:pre-line", content, "the hint needs to wrap onto its own line")

    def test_a_status_inherited_from_the_resume_is_surfaced_in_review(self):
        packet = (ROOT / "server" / "packet.py").read_text()
        self.assertIn('sensitive.status_mentions(', packet, "packets do not look for status lines")
        self.assertIn('"status_mentions":', packet, "the finding is not recorded on the packet")
        body = packet[packet.index("def build_packet"):packet.index("def build_autofill_snapshot")]
        self.assertTrue("status_mentions" in body and "redact_compliance_claims" in body,
                        "status mentions must be surfaced separately from invented claims")
        self.assertIn('id="pd-status"', (WEB / "index.html").read_text())
        dash = (WEB / "app.js").read_text()
        self.assertIn("function renderStatusMentions", dash, "the dashboard never shows it")
        self.assertIn("Confirm you want it on this application", dash,
                      "the reminder must say what the decision is")
        self.assertIn("the extension will never answer those for you", dash.lower(),
                      "the amber block must repeat the hard refusal")


class OwnOriginIsExcluded(unittest.TestCase):
    """The dashboard is a page full of inputs. Letting the autofiller run there means
    clicking Fill types an approved packet into the profile form that produced it."""

    def test_the_extension_stands_down_on_its_own_dashboard(self):
        content = (EXT / "content.js").read_text()
        self.assertRegex(content, r"(function|const) isOwnDashboard", "no origin check")
        guard = content[content.index("isOwnDashboard"):]
        self.assertIn("state.server", guard[:400], "the check must compare against the configured server")
        body = content[content.index("function looksLikeApplication"):]
        self.assertIn("if (isOwnDashboard()) return false", body[:300], "the panel must not mount there")
        boot = content[content.index("async function boot"):]
        self.assertIn("own-origin", boot[:900], "boot must stop on our own origin")
        # The guard must be scoped to the dashboard's paths, not the whole origin:
        # /preview.html is the sample form, served from that same origin on purpose.
        block = content[content.index("DASHBOARD_PATHS = new Set"):]
        block = block[:block.index(")") + 1]
        listed = set(re.findall(r"'([^']+)'", block))
        self.assertIn("/", listed, "the dashboard root must be excluded")
        self.assertIn("/index.html", listed, "the dashboard must be excluded")
        self.assertNotIn("/preview.html", listed,
                         "the sample form shares the origin and must keep the panel")
        handler = content[content.index("chrome.runtime.onMessage.addListener"):]
        self.assertIn("does not run on its own dashboard", handler[:900],
                      "a fill driven from the popup must be refused on our own origin")


class LabelledFieldsAlign(unittest.TestCase):
    """A form whose boxes start at a different x on every row reads as broken, and the
    cause here was weak CSS: bare `label` selectors lose to any browser extension that
    styles labels, which is exactly what happened on a reviewer's machine. So the rule is
    scoped to our own container, and the alignment is measured in a real browser render
    rather than argued about from a screenshot."""

    def test_the_rule_is_scoped_and_fixed_width(self):
        css = (WEB / "styles.css").read_text()
        self.assertIn(".sub .fields .row > label", css, "label column is not scoped to our container")
        rule = ".sub .fields .row > label {"
        self.assertIn(rule, css, "the label column rule is missing")
        block = css[css.index(rule):]
        block = block[:block.index("}")]
        self.assertRegex(block, r"flex:\s*0 0 \d+px", "the label column must be a fixed width")
        self.assertIn(".sub .fields .row > input", css, "the controls are not told to fill the column")

    def test_the_card_marks_its_labelled_rows(self):
        js = (WEB / "app.js").read_text()
        self.assertIn("'fields'", js, "labelled cards must carry the .fields container")
        self.assertIn("? 'fields' : 'grid3'", js,
                      "single-line cards must keep the compact grid, not the label column")

    def test_every_box_starts_at_the_same_x(self):
        render = render_dom({"experience": [
            {"company": "A", "title": "B", "location": "C", "start": "2021-06", "end": "2023",
             "context": "one line", "bullets": ["did a thing"], "tech": ["python"]},
            {"company": "D", "title": "E", "location": "F", "start": "2018", "end": "Present",
             "context": "another", "bullets": ["did another"], "tech": ["bash"]},
        ], "boilerplate": [{"label": "Why this company?", "text": "Because."},
                           {"label": "Why leaving?", "text": "Grew."}]}, "#selftest-align")
        if render is None:
            self.skipTest("no browser available for the render check")
        import json as _json
        m = re.search(r'id="selftest-align">([^<]+)<', render)
        self.assertTrue(m, "the render never reported its own alignment")
        edges = _json.loads(m.group(1))
        controls, labels = edges["controls"], edges["labels"]
        self.assertGreater(len(controls), 5, "the sample profile rendered no labelled cards")
        for key, vals in controls.items():
            self.assertEqual(len(set(vals)), 1, f"the {key} box sits at {sorted(set(vals))} in different entries")
        for key, vals in labels.items():
            self.assertEqual(len(set(vals)), 1, f"the {key} label sits at {sorted(set(vals))}")
        control_x = sorted({v[0] for v in controls.values()})
        label_x = sorted({v[0] for v in labels.values()})
        self.assertEqual(len(control_x), 1, f"boxes start at several x positions: {control_x}")
        self.assertEqual(len(label_x), 1, f"labels start at several x positions: {label_x}")
        # Equal lefts would also be true with the label stacked on top of the box, which
        # is the layout this replaced. Side by side is the thing under test.
        self.assertLess(label_x[0], control_x[0], "labels are not in a column beside the boxes")
        self.assertGreaterEqual(control_x[0] - label_x[0], 120, "the label column is too narrow to hold a label")


class WaitingIsObvious(unittest.TestCase):
    """Ask-per-field pauses with nothing moving. In a dark panel whose primary button has
    turned red and says "click to stop", one reviewer pressed it, halted the run at field
    one, and reported that the extension fills nothing."""

    def test_the_waiting_state_is_marked_said_and_focused(self):
        content = (EXT / "content.js").read_text()
        self.assertIn("waiting on you", content, "the log never says it is waiting for input")
        self.assertIn("classList.add('waiting')", content, "the card has no waiting state")
        self.assertIn(".rev.waiting", (WEB / "content.css").read_text() if (WEB / "content.css").exists() else content,
                      "the waiting card looks like every other card")
        self.assertRegex(content, r"#fd-ry'\)\.focus", "keyboard control needs focus on the fill button")
        self.assertIn("'Stop run'", content, "the run button keeps its long 'click to stop' label")
        block = content[content.index("answerReview(choice)"):]
        self.assertIn("classList.remove('waiting')", block[:420], "the waiting style outlives the decision")

    def test_a_stopped_run_says_so_instead_of_reading_as_zero(self):
        content = (EXT / "content.js").read_text()
        self.assertIn("Stopped after", content, "a stopped run reports the same zeros as an empty one")
        self.assertIn("never touched", content, "the user is not told the rest was not evaluated")
        self.assertIn("state.reached = i", content, "the run does not track how far it got")


class UnverifiedAnswersExplained(unittest.TestCase):
    """The server withholds answers the human never confirmed. If the extension then says
    "unrecognised", the user hunts for a matching bug instead of ticking the box."""

    def test_the_panel_says_why_the_field_is_empty(self):
        content = (EXT / "content.js").read_text()
        self.assertIn("unverified_questions", content, "the panel never reads the withheld list")
        self.assertIn("function flagUnverified", content, "no link between a withheld answer and its field")
        self.assertIn("did not verify", content, "the user is not told what to do about it")
        self.assertIn("answer unverified", content, "the fill run does not count them separately")
        guard = content[content.index("function flagUnverified"):]
        guard = guard[:guard.index("\n  }")]
        self.assertIn("!== 'skip'", guard, "only untouched fields should be checked")
        self.assertRegex(guard, r"q\.length < \d+", "a short label would match every question")


class ErrorsReachTheUser(unittest.TestCase):
    """chrome://extensions is the wrong place to discover a failure: it is a page you
    have to navigate to, and it keeps old entries, so a fixed build can still look
    broken there. Anything that fails inside our own script must appear in the panel."""

    def test_the_panel_reports_its_own_failures(self):
        content = (EXT / "content.js").read_text()
        self.assertIn("function reportError", content, "no error funnel")
        self.assertIn("ui.line({ kind: 'bad'", content[content.index("function reportError"):],
                      "a failure must be written into the log the user can see")
        self.assertIn("window.addEventListener('error'", content, "no window error trap")
        self.assertIn("window.addEventListener('unhandledrejection'", content, "no rejection trap")
        self.assertIn("isOurs", content, "the trap must ignore the host page's own errors")
        trap = content[content.index("window.addEventListener('error'"):]
        self.assertIn("isOurs", trap[:260], "the error trap reports errors it did not cause")
        handler = content[content.index("chrome.runtime.onMessage.addListener"):]
        self.assertIn("reportError('message handler'", handler, "a rejected fill reports nowhere")
        self.assertIn("reported < 3", content, "a throwing page must not flood the log")


class BuildStamp(unittest.TestCase):
    """A stale content script and a fixed one look identical, and Chrome's error list
    keeps old entries. The build number has to be visible where the user looks."""

    def test_extension_and_server_agree_on_the_version(self):
        manifest = json.loads((EXT / "manifest.json").read_text())
        self.assertEqual(manifest["version"], config.VERSION,
                         "the panel would report a version the server disagrees with")

    def test_the_version_is_visible_in_the_panel_and_the_popup(self):
        content = (EXT / "content.js").read_text()
        popup = (EXT / "popup.js").read_text()
        self.assertIn('id="fd-ver"', content, "the panel header should carry the build")
        self.assertIn("getManifest()", content, "nothing reads the manifest version")
        self.assertIn("content script v", content, "the console should say which build loaded")
        self.assertIn("calendar", content, "boot logging should report whether the calendar loaded")
        self.assertIn("matcher", content, "boot logging should report whether the matcher loaded")
        self.assertIn("${text} · v${BUILD}", popup, "the popup status should carry the build")

    def test_content_scripts_are_listed_in_load_order(self):
        js = json.loads((EXT / "manifest.json").read_text())["content_scripts"][0]["js"]
        self.assertEqual(js[:2], ["matcher.js", "datepicker.js"],
                         "content.js expects both helpers to exist before it runs")


class StrictModeSafety(unittest.TestCase):
    """Every browser file runs under 'use strict', so assigning to a name that was never
    declared is a ReferenceError that kills the whole action — and nothing in a headless
    test would ever see it.

    `running = on` inside setRunning() did exactly that: the Fill button threw before it
    typed a single field, and the error only appeared in chrome://extensions. This audit
    is the cheapest net that catches that class of bug without a browser.
    """

    GLOBALS = {"window", "document", "location", "chrome", "navigator", "localStorage",
               "console", "module", "exports", "self", "globalThis", "history",
               "performance", "status", "name", "length"}

    def _declared(self, src):
        names = set()
        for m in re.finditer(r"\b(?:let|var|const)\s+([^;\n]*)", src):
            for part in m.group(1).split(","):
                part = part.split("=")[0].strip().strip("{}[]")
                if re.match(r"^[A-Za-z_$][\w$]*$", part):
                    names.add(part)
        for m in re.finditer(r"function\s*[\w$]*\s*\(([^)]*)\)", src):
            for part in re.split(r"[,{]", m.group(1)):
                part = part.split("=")[0].strip()
                if re.match(r"^[A-Za-z_$][\w$]*$", part):
                    names.add(part)
        for m in re.finditer(r"=>\s*([\w$]+)\b", src):
            names.add(m.group(1))
        for m in re.finditer(r"\bcatch\s*\(\s*([\w$]+)", src):
            names.add(m.group(1))
        for m in re.finditer(r"\bfunction\s+([\w$]+)", src):
            names.add(m.group(1))
        for m in re.finditer(r"\bconst\s*\{([^}]*)\}", src):
            for part in m.group(1).split(","):
                part = part.split(":")[0].strip()
                if re.match(r"^[A-Za-z_$][\w$]*$", part):
                    names.add(part)
        return names

    def test_no_undeclared_assignments_in_browser_code(self):
        assign = re.compile(r"^\s*([a-zA-Z_$][\w$]*)\s*=(?!=)", re.M)
        offenders = []
        for path in sorted(EXT.glob("*.js")) + [WEB / "app.js"]:
            src = path.read_text()
            if path.parent == EXT:
                self.assertIn("'use strict'", src,
                              f"{path.name} lost its strict-mode marker (which would hide "
                              "undeclared assignments instead of failing loudly)")
            declared = self._declared(src)
            for name in sorted(set(assign.findall(src))):
                if name not in declared and name not in self.GLOBALS:
                    offenders.append(f"{path.name}: {name}")
        self.assertFalse(offenders,
                         "assigned without declaring (ReferenceError in strict mode): " + ", ".join(offenders))

    def test_the_fill_button_state_variable_is_declared(self):
        content = (EXT / "content.js").read_text()
        self.assertIn("let running", content, "setRunning() needs a declared flag")
        self.assertLess(content.index("let running"), content.index("function setRunning")
                        if "function setRunning" in content else content.index("setRunning(on)"),
                        "declared before use")


class DocsImages(unittest.TestCase):
    """Docs that link to a missing image are worse than docs with no images."""

    def test_referenced_images_exist(self):
        missing = []
        for doc in ("README.md", "QUICKSTART.md"):
            text = (ROOT / doc).read_text()
            for rel in re.findall(r"!\[[^\]]*\]\(([^)\s]+)\)", text):
                if rel.startswith(("http://", "https://", "data:")):
                    continue
                if not (ROOT / doc).resolve().parent.joinpath(rel).resolve().exists():
                    missing.append(f"{doc}: {rel}")
        self.assertFalse(missing, "broken image links: " + ", ".join(missing))

    def test_no_full_screenshots_in_the_repo(self):
        """A full desktop screenshot carries tabs, bookmarks and a taskbar. Crop it."""
        for path in (ROOT / "docs" / "img").glob("*"):
            self.assertLess(path.stat().st_size, 400 * 1024,
                            f"{path.name} is large enough to be an uncropped desktop shot")
            self.assertLess(max(Image.open(path).size) if path.suffix == ".png" else 0, 3000,
                            f"{path.name} looks like an uncropped screenshot")


class HumanInTheLoopTests(unittest.TestCase):
    """The features that exist purely to keep a person deciding: per-field review,
    undo, the live cover-letter draft, and the responsibility line at the gate.

    Assertions use assertTrue so a failure prints one line instead of a whole file.
    """

    def setUp(self):
        self.content = (EXT / "content.js").read_text()
        self.index = (WEB / "index.html").read_text()
        self.dash = (WEB / "app.js").read_text()

    def has(self, haystack, needle, why):
        self.assertTrue(needle in haystack, why)

    def test_review_mode_controls_exist(self):
        for el in ("fd-review", "fd-rev", "fd-ry", "fd-rn", "fd-ra", "fd-rs"):
            self.has(self.content, f'id="{el}"', f"{el} missing from the panel")
            self.assertTrue(f"$('{el}')" in self.content or f"'#{el}'" in self.content,
                            f"{el} is never wired up")

    def test_review_mode_can_only_fill_skip_fillrest_stop(self):
        gate = self.content[self.content.index("if (state.reviewEach && !state.reviewAll)"):]
        for choice in ("'skip'", "'stop'", "'all'"):
            self.has(gate[:900], choice, f"no handling for {choice}")
        self.has(gate[:900], "state.cancelled = true", "Stop must cancel the run")

    def test_review_shortcuts_ignore_fields_being_typed_in(self):
        handler = self.content[self.content.index("addEventListener('keydown'"):]
        self.has(handler[:600], "isContentEditable", "shortcuts must not eat keystrokes in a form field")
        for key in ("y: 'fill'", "n: 'skip'", "a: 'all'", "escape: 'stop'"):
            self.has(handler[:700], key, f"missing shortcut {key}")

    def test_typed_values_can_be_taken_back(self):
        self.has(self.content, "state.changes.push", "no log of what was typed")
        self.has(self.content, "function undoChanges", "no undo")
        self.has(self.content, "fd-undo", "undo is not offered in the summary")

    def test_responsibility_is_stated_where_the_decisions_are_made(self):
        self.has(self.content, "responsible for everything you submit",
                 "the extension panel must say who is answerable")
        self.has(self.index, "responsible for everything you submit",
                 "the dashboard approval bar must say who is answerable")

    def test_cover_letter_draft_is_offered_but_gated(self):
        self.has(self.content, "/draft_cover", "the panel cannot draft a cover letter")
        for el in ("fd-cover", "fd-draft", "fd-dcopy", "fd-dopen"):
            self.has(self.content, f'id="{el}"', f"{el} missing")
        self.has(self.dash, "A draft is not an answer",
                 "the dashboard must say a draft is not usable yet")
        self.has(self.dash, "function showCoverDraft", "no draft viewer in the dashboard")

    def test_draft_endpoint_exists_and_a_draft_is_not_a_packet(self):
        server = (ROOT / "server" / "app.py").read_text()
        self.has(server, '@route("POST", "/api/jobs/<job_id>/draft_cover")', "no draft endpoint")
        packet = (ROOT / "server" / "packet.py").read_text()
        body = packet[packet.index("def draft_cover_letter"):]
        self.assertTrue("snapshot" not in body.split("def ")[0],
                        "a draft must never be written into an autofill snapshot")

    def test_extension_links_resolve_in_the_dashboard(self):
        self.has(self.content, "#packet=", "panel should deep-link to a packet")
        self.has(self.content, "#job=", "panel should deep-link to a job draft")
        self.has(self.dash, "async function followHash", "dashboard ignores those links")
        self.has(self.dash, "addEventListener('hashchange'", "no hashchange handling")


if __name__ == "__main__":
    unittest.main(verbosity=2)
