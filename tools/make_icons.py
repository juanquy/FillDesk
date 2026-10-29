"""Generate the extension icons with no image library: raw RGBA -> PNG by hand.

Run: python3 tools/make_icons.py
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"

BG = (91, 140, 255)      # #5b8cff
FG = (255, 255, 255)
INK = (18, 22, 29)


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path: Path, size: int, pixels) -> None:
    raw = b"".join(b"\x00" + b"".join(struct.pack("4B", *px) for px in row) for row in pixels)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def rounded(x: int, y: int, size: int, radius: float) -> float:
    """Coverage of a rounded square at (x,y), for cheap anti-aliased edges."""
    r = radius
    cx = min(max(x, r), size - r)
    cy = min(max(y, r), size - r)
    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    if x < r or y < r or x >= size - r or y >= size - r:
        return max(0.0, min(1.0, r + 0.5 - d))
    return 1.0


def in_letter_f(x: int, y: int, size: int) -> bool:
    """A blocky 'F' scaled to the canvas."""
    s = size
    u = s / 16.0
    px, py = x / u, y / u
    stem = 4.0 <= px <= 7.2 and 3.5 <= py <= 12.5
    top = 4.0 <= px <= 12.4 and 3.5 <= py <= 6.0
    mid = 4.0 <= px <= 10.4 and 7.4 <= py <= 9.6
    return stem or top or mid


def build(size: int):
    rows = []
    radius = size * 0.22
    for y in range(size):
        row = []
        for x in range(size):
            cover = rounded(x, y, size, radius)
            if in_letter_f(x, y, size):
                r, g, b = FG
                a = cover
            else:
                # subtle vertical shade so the icon is not a flat slab
                t = y / size
                r, g, b = (int(BG[0] + (18 - BG[0]) * t * 0.35), int(BG[1] + (30 - BG[1]) * t * 0.35), int(BG[2] + (90 - BG[2]) * t * 0.35))
                a = cover
            row.append((r, g, b, int(a * 255)))
        rows.append(row)
    return rows


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(OUT / f"icon{size}.png", size, build(size))
        print(f"wrote extension/icons/icon{size}.png")


if __name__ == "__main__":
    main()
