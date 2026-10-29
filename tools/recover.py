"""List and restore backups of jobs and packets.

  python3 tools/recover.py                     # newest copies, both kinds
  python3 tools/recover.py --restore backups/packet_x-deleted-....json

Every write and delete in store.py keeps a copy first, because a throwaway test once
wiped data/jobs and data/packets and there was nothing to restore from. This is the
other half of that: a copy nobody can find is not a backup.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# backups are named <record>-<yyyymmdd>-<hhmmss>-<usec>-<replace|deleted>.json
COPY_NAME = re.compile(r"^(?P<stem>.+)-\d{8}-\d{6}-\d{6}-(?P<why>replace|deleted)\.json$")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import config, store  # noqa: E402


def _kind(path: Path) -> str:
    return "job" if path.name.startswith("job_") else "packet" if path.name.startswith("packet_") else "other"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--restore", help="backup file to put back, e.g. backups/packet_x-deleted-....json")
    ap.add_argument("--limit", type=int, default=12, help="how many copies to list")
    args = ap.parse_args()

    if not config.BACKUP_DIR.exists():
        print("no backups yet — nothing has been replaced or deleted")
        return 0

    if args.restore:
        if not COPY_NAME.match(Path(args.restore).name):
            print(f"{args.restore} is not a backup copy (expected <record>-<stamp>-replace|deleted.json)")
            return 1
        target = Path(args.restore)
        if not target.is_absolute():
            target = config.DATA_DIR / args.restore
        if not target.is_file():
            print(f"no such backup: {target}")
            return 1
        kind = _kind(target)
        if kind == "other":
            print(f"{target.name} is not a job or packet copy")
            return 1
        record = json.loads(target.read_text(encoding="utf-8"))
        if not store.restore_backup(target, kind):
            print("that file is not a readable record")
            return 1
        where = config.JOBS_DIR if kind == "job" else config.PACKETS_DIR
        print(f"restored {kind} {record.get('id')} -> {where / (str(record.get('id')) + '.json')}")
        print("content check it: it is the version that existed before the replace or delete.")
        return 0

    records = {}
    for path in config.BACKUP_DIR.glob("*-*.json"):
        kind = _kind(path)
        if kind == "other":
            continue
        match = COPY_NAME.match(path.name)
        if not match:
            continue
        records.setdefault((kind, match.group("stem")), []).append(path)

    if not records:
        print("no job or packet copies in", config.BACKUP_DIR)
        print("profile backups are listed with: ls data/backups/profile-*")
        return 0

    print(f"{'kind':7} {'record':34} {'copies':6} newest")
    for (kind, stem), files in sorted(records.items())[: args.limit]:
        newest = sorted(files, reverse=True)[0]
        try:
            data = json.loads(newest.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - a half-written copy is still listed
            data = {}
        label = data.get("title") or data.get("company") or ""
        why = "deleted" if newest.name.endswith("-deleted.json") else "replaced"
        print(f"{kind:7} {stem:34} {len(files):6} {why:9} {label[:40]}")
    print(f"\nrestore one: python3 tools/recover.py --restore backups/<newest filename>")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
