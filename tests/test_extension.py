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
from pathlib import Path

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
            self.assertTrue((WEB / src.lstrip("/")).is_file(), f"dashboard references missing {src}")
        js = (WEB / "app.js").read_text()
        for endpoint in set(re.findall(r"api\(['\"`]/([\w/<>\-.]+)", js)):
            self.assertTrue(any(token in endpoint for token in ("status", "token", "settings", "llm", "profile", "jobs", "packets", "parse")), endpoint)

    def test_id_bindings_line_up(self):
        html = (WEB / "index.html").read_text()
        js = (WEB / "app.js").read_text()
        ids_in_js = set(re.findall(r"\$\('#([\w-]+)'\)", js))
        ids_in_html = set(re.findall(r'id="([\w-]+)"', html))
        missing = sorted(ids_in_js - ids_in_html)
        self.assertFalse(missing, f"app.js binds ids that the dashboard does not define: {missing}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
