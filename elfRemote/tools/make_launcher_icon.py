#!/usr/bin/env python3
"""Build rounded-rect launcher mipmaps from the transparent elfRadio logo."""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "art", "elfradio-icon.png")
RES = os.path.join(ROOT, "app", "src", "main", "res")
BG = (58, 124, 210, 255)
SIZES = {
    "ldpi": 36,
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    bbox = src.getbbox()
    if bbox is None:
        raise SystemExit("source icon is empty")
    logo = src.crop(bbox)
    for density, size in SIZES.items():
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        radius = max(8, int(round(size * 0.22)))
        mask = rounded_mask(size, radius)
        fill = Image.new("RGBA", (size, size), BG)
        canvas.paste(fill, (0, 0), mask)
        inner = int(size * 0.90)
        cw, ch = logo.size
        scale = min(inner / float(cw), inner / float(ch))
        nw = max(1, int(round(cw * scale)))
        nh = max(1, int(round(ch * scale)))
        resized = logo.resize((nw, nh), Image.Resampling.LANCZOS)
        x = (size - nw) // 2
        y = (size - nh) // 2
        canvas.paste(resized, (x, y), resized)
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(canvas, (0, 0), mask)
        dest_dir = os.path.join(RES, "mipmap-%s" % density)
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, "ic_launcher.png")
        out.save(dest, "PNG")
        print("wrote", dest, out.size)


if __name__ == "__main__":
    main()
