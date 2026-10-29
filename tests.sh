#!/usr/bin/env bash
# Everything that can be verified without a browser.
set -uo pipefail
cd "$(dirname "$0")"

fail=0
echo "== python api + rules (stdlib unittest) =="
python3 tests/test_api.py            || fail=1
python3 tests/test_extension.py      || fail=1
python3 tests/test_resume_ingest.py  || fail=1
python3 tests/test_importers.py        || fail=1
python3 tests/test_no_personal_data.py || fail=1
echo
echo "== matcher (node:test) =="
node --test tests/matcher.test.mjs   || fail=1
echo
if [ "$fail" -eq 0 ]; then echo "all green"; else echo "FAILURES above"; fi
exit $fail
