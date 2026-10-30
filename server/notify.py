"""Tell the operating system, not the browser, that FillDesk is waiting.

The case this exists for: ask-per-field is on, the extension stopped at "First name", and
the user has alt-tabbed into a terminal. A Chrome notification cannot help — the browser
is exactly the thing they walked away from, and it needs a permission prompt to try. So
this goes straight to the desktop notification service instead: no manifest permission,
nothing for the user to accept during install, and it lands on whatever workspace they
are on.

Everything here is best-effort. A missing notifier, a locked session, Do Not Disturb on
KDE — none of it may interrupt an application run, so every path returns a result
instead of raising.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
import time
from typing import Any

APP_NAME = "FillDesk"
DEFAULT_COOLDOWN = 60  # seconds between the same kind of alert

# The client may say *which* field is waiting; it may not decide what reaches the screen.
# Keeping the sentences here means a buggy or hostile page cannot put arbitrary text on
# somebody's desktop, and cannot leak an answer into a lock-screen preview.
_TITLES = {
    "waiting": "FillDesk is waiting on you",
    "done": "FillDesk finished a run",
    "test": "FillDesk can reach your desktop",
}


def _clean(text: str, limit: int = 70) -> str:
    """Whitespace-flatten, strip control characters, and drop anything that looks
    personal. A notification body sits in the desktop's history and on the lock screen."""
    text = re.sub(r"[\x00-\x1f\x7f]", " ", str(text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"[\w.+-]+@[\w.-]+\.\w{2,}", "[email]", text)          # emails
    text = re.sub(r"\b\d{3}-\d{2}-\d{4}\b", "[ssn]", text)               # SSN-shaped
    text = re.sub(r"(?:\b|\+)\d[\d()+.\s-]{7,}\d\b", "[phone]", text)    # phone-shaped
    return text[:limit].rstrip()


def _backends() -> list[list[str]]:
    """Available notification commands, best first.

    Linux first tries libnotify, then KDE's own passive popup (this desktop), then Zenity.
    macOS and Windows get their native call. An empty list means this machine has no way
    to be told, which is a normal state, not an error.
    """
    have = shutil.which
    if sys.platform == "darwin":
        script = 'on run argv\n  display notification (item 2 of argv) with title (item 1 of argv)\nend run'
        return [["osascript", "-e", script]] if have("osascript") else []
    if sys.platform.startswith("win"):
        if have("powershell"):
            script = (
                "$ErrorActionPreference = 'SilentlyContinue';"
                "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');"
                "$n = New-Object System.Windows.Forms.NotifyIcon;"
                "$n.Icon = [System.Drawing.SystemIcons]::Information;"
                "$n.BalloonTipTitle = $args[0];"
                "$n.BalloonTipText = $args[1];"
                "$n.Visible = $true;"
                "$n.ShowBalloonTip(6000);"
                "Start-Sleep -Milliseconds 600;"
                "$n.Dispose()"
            )
            return [["powershell", "-NoProfile", "-Command", script]]
        return []
    out: list[list[str]] = []
    if have("notify-send"):
        out.append(["notify-send", "-a", APP_NAME])           # urgency, title, body appended
    if have("kdialog"):
        out.append(["kdialog", "--passivepopup"])             # title, body handled in notify()
    if have("zenity"):
        out.append(["zenity", "--notification", "--text"])    # body appended
    return out


_last: dict[str, float] = {}


def notify(title_key: str, body: str = "", urgency: str = "normal",
           cooldown: int = DEFAULT_COOLDOWN, force: bool = False) -> dict[str, Any]:
    """Send one desktop notification. Returns {"sent", "via", "reason"} and never raises.

    `cooldown` collapses repeats of the same kind: ask-per-field stops at every field, and
    thirty popups per application would make this feature worse than silence.
    """
    title = _TITLES.get(title_key, _TITLES["waiting"])
    kind = title_key if title_key in _TITLES else "waiting"
    if not force and cooldown > 0:
        since = time.time() - _last.get(kind, 0)
        if since < cooldown:
            return {"sent": False, "via": "", "reason": f"cooldown ({int(cooldown - since)}s left)"}

    text = _clean(body)
    full = f"{title} — {text}" if text else title

    problem = ""
    for cmd in _backends():
        name = cmd[0]
        if name == "notify-send":
            argv = cmd + ["-u", urgency, title] + ([text] if text else [])
        elif name == "kdialog":
            argv = ["kdialog", "--title", title, "--passivepopup", text or title, "10"]
        elif name == "zenity":
            argv = ["zenity", "--notification", "--text", full]
        elif name == "osascript":
            argv = cmd + [title, text or ""]
        elif name == "powershell":
            argv = cmd + [title, text or title]
        else:
            argv = list(cmd)
        try:
            done = subprocess.run(argv, capture_output=True, text=True, timeout=5, check=False)
        except Exception as exc:  # noqa: BLE001 - no D-Bus, no session, timeout: stay silent
            problem = str(exc)[:120]
            continue
        if done.returncode == 0:
            _last[kind] = time.time()
            return {"sent": True, "via": name, "reason": ""}
        problem = (done.stderr or done.stdout or "").strip()[:120] or f"exit {done.returncode}"
    return {"sent": False, "via": "", "reason": problem or "no desktop notifier available"}


def status() -> dict[str, Any]:
    """What the Settings page should say about this machine's ability to alert."""
    backends = [c[0] for c in _backends()]
    return {"possible": bool(backends), "backends": backends or ["none found"]}
