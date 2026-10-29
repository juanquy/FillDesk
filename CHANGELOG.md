# Changelog

## 0.1.7 — jobs and packets are recoverable
Replacing or deleting a job or packet now writes a timestamped copy to
`data/backups/` first, capped at 40 per record, and `tools/recover.py` lists them and puts
one back. The profile had always been the only thing copied anywhere, and a throwaway test
that wiped `data/jobs` and `data/packets` found nine packets and every saved posting gone
with nothing to restore from. A copy nobody can find is not a backup, so the tool lists
what exists and says whether the newest copy predates a replace or a delete.

Backups are named `<record>-<stamp>-<replace|deleted>.json` — stamp first, because sorting
by name has to order by time. Profile backups are rate-limited to one per ten minutes: the
dashboard saves on every edit.

## 0.1.6 — labelled fields align, and assets stop caching
Experience and saved-answer cards are a two-column form now: a fixed label column with
every control starting at the same x, whatever the label length. The rules are scoped to
`.sub .fields .row > label` because the old bare `label` selectors lost to a browser
extension on one machine, which raggied every row on that machine and nobody else's. A
real Chromium render now measures the left edge of each box and asserts they match —
equal lefts alone would also pass with labels stacked on top, so the test checks the
label column sits beside the boxes.

Static files carried no `Cache-Control` at all, so the browser chose how long to keep the
dashboard's CSS and JS: an upgraded extension could sit next to a week-old stylesheet and
produce a bug that source cannot explain. Everything served from `web/` is `no-store`
now, and `HEAD` returns 200 instead of 501.

## 0.1.5 — extension errors appear in the panel
A failure used to be visible only on `chrome://extensions`, which you have to navigate to
and which keeps old entries: one 0.1.0 `ReferenceError` sat there for days, its snippet
re-rendered against a file where that line is markup, while the build in use was fine.
Errors thrown by our own script — and rejections from a rejected fill — now print in the
panel log, capped at three so a hostile page cannot flood it. The host page's own errors
stay the host page's problem.

## 0.1.4 — the origin guard is path-scoped
0.1.3 compared only origins, and the sample form at `/preview.html` is served from the
dashboard's own origin, so the panel vanished from the one page the docs tell you to open
first. The guard now lists the dashboard's paths and leaves the sample form alone.

## 0.1.3 — the extension stands down on its own dashboard
`content_scripts` match `http://*/*`, which includes the local dashboard: a page made
entirely of input fields. The panel mounted there, and pressing Fill would have typed an
approved packet into the profile form that produces the packet. Boot, the mount, and
popup-driven fills now compare `location.origin` with the configured server and do
nothing on a match.

## 0.1.2 — the build number is visible where you look
A fixed content script and a stale one look identical, and Chrome's error list re-renders
old entries against the *current* file, so a stale trace points at a line that never
threw. The panel header now carries `v<version>`, the popup appends it to the connection
state, and the page console logs the version plus whether the matcher and calendar
helpers attached. Manifest and server versions are held equal by a test.

## 0.1.1 — declared the running flag
`content.js` runs in strict mode, and `setRunning()` assigned `running = on` without ever
declaring it. `ReferenceError: running is not defined` on the first click, before a single
field was typed. Fixed, and a static audit now fails any browser file that assigns an
undeclared identifier or omits `'use strict'`.

## 0.1.0 — first release

- **Ask-per-field review mode** in the extension: Y / N / A / Esc, plus *Undo what
  FillDesk typed* after a run.
- **Cover-letter draft from the page you are on** (`POST /api/jobs/<id>/draft_cover`).
  Draft only: it lives on the job record and cannot reach the autofill engine.
- **Compliance scrubbing of generated prose.** A model invented a work-authorization
  claim from a home town; drafted resumes, letters and answers are now scanned
  sentence by sentence, claims are replaced with `[NEEDS INPUT]`, and the removed
  sentences are listed in the dashboard. Nine classes: work authorization,
  attestations, criminal history, age, protected class, disability, veteran, health.
- **Calendar date pickers**, one widget shared by the dashboard and the extension:
  month+year for work history, bare year for schooling, full date for "earliest
  start", and a *Year only* escape hatch because a bare year is a true answer and a
  invented day is not. In the panel's per-field card a picked date is re-shaped into
  the format that field asked for.
- `Ask per field` no longer looks disabled when it is off (dashed outline, and the
  label shows ✓ / ○), and a real reviewer read the old dimmed style as "cannot click".
- **Profile importers**: `tools/import_skills.py` (text lists) and
  `tools/import_linkedin.py` (your own LinkedIn data export — never account access).
- **Dashboard deep links** (`#packet=…`, `#job=…`) so panel buttons land somewhere.
- `LICENSE.md` and `TERMS.md`: proprietary one-person perpetual license, non-refundable
  sale, 30-day limited warranty, support via GitHub Issues, user responsible for
  submissions.

Local-first job application filler: one profile, a tailored packet per job, and a
browser extension that types **only what you approved** and never submits.

### How it works

1. **Profile** — identity, links, work history, education, skills, and your own
   reusable answers. Import a resume from the dashboard or `tools/dry_run.py`.
2. **Packet** — per job: a tailored resume, a cover letter, and answers to that
   employer's questions. Re-ranks your own evidence by the posting's language.
3. **Review** — you read and edit it. Approval is the gate; unapproved packets are
   refused by the API (HTTP 423), and an answer containing `[NEEDS INPUT]` is never
   typed even on a forced approval.
4. **Autofill** — Chrome fills the live form field by field: green filled, amber
   verify, red yours-to-answer. Multi-page forms get `Next page`. Documents are
   attached as `.docx`.
5. **You press Submit.** There is no submit code in the extension; a test asserts it.

### What it refuses, always

Protected-class and self-identification questions (race, ethnicity, gender, religion,
sexual orientation), disability and accommodation, veteran status, work authorization
and sponsorship, age and date of birth, arrest and conviction history, health,
attestations and signatures, passwords and payment credentials. Not configurable.
Salary, relocation, start date, notice period, clearances and references are filled
but flagged amber.

### Safety behaviour worth knowing

- A resume that only says `2023` fills `2023` flagged for review — it never becomes
  `01/01/2023`. An impossible date (`2026-24`) is never typed at all.
- Employment dates need employment context, so "Earliest start date" cannot steal
  your first job's start date.
- Yes/no radio groups inherit the question above them, which is how work-authorization
  and accommodation traps get past naive matchers.
- A PDF with no usable text layer is refused rather than ingested as garbage;
  `pdftotext` is used when installed, with a built-in fallback.
- A multi-column education block is left empty instead of guessing a school name.
- `tools/dry_run.py` runs your real resume through everything and writes a report of
  every fill / attach / verify / leave-alone / refuse decision before you trust it.

### Engineering

- Server: Python standard library only. Dashboard: vanilla JS. No build step, no
  dependencies, no accounts, no telemetry, no phone-home.
- Model: bring your own. OpenAI-compatible, Anthropic, Gemini, Ollama, or none — with
  no key it drafts from your own saved answers and flags every gap instead of
  inventing one. It bundles no inference and resells none.
- Field matcher is pure and unit-tested in Node; the compliance rules are mirrored in
  Python and JavaScript with a parity test, so the refusal list cannot drift apart.
- `./data` is the entire state, gitignored by default.
- Coverage you can measure: every run logs fields filled / unrecognised / refused per
  host into `data/events.jsonl`, and the dashboard shows it.
- Publish guard: `tests/test_no_personal_data.py` scans **all** git history for
  secrets and for strings derived from your own local profile, because a resume tool
  leaks this way.
- `tests.sh` — the whole suite, no browser required.
