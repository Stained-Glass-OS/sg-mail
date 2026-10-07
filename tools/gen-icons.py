#!/usr/bin/env python3
"""gen-icons: SG Mail's hicolor PNGs, made from its vector icon (data/sg-mail.svg)
the way Stained Glass OS makes every icon (sg-shell tools/sgicon.py): the
drawing rendered once large (librsvg, 4x the largest size), each size reduced
straight from that -- premultiplied, Lanczos -- and sizes up to 24 px lightly
sharpened so the envelope's edges stay crisp rather than grey.

  tools/gen-icons.py [OUTDIR]     (default data/icons: OUTDIR/<n>x<n>/sg-mail.png)

The PNGs are committed (the package build needs neither librsvg nor PIL);
test/icons-gate.sh regenerates them and checks they match. Mutant:
SG_MUTANT_ICON_SIZES=1 writes the old seven sizes (no 22, 96 or 512).

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import io
import os
import subprocess
import sys

from PIL import Image, ImageFilter

HICOLOR = (16, 22, 24, 32, 48, 64, 96, 128, 256, 512)
if os.environ.get("SG_MUTANT_ICON_SIZES"):
    HICOLOR = (16, 24, 32, 48, 64, 128, 256)
MASTER = 2048
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def reduce(big, n):
    pm = big.convert("RGBa").resize((n, n), Image.LANCZOS)
    im = pm.convert("RGBA")
    if n <= 24:
        r, g, b, a = im.split()
        rgb = Image.merge("RGB", (r, g, b)).filter(ImageFilter.UnsharpMask(radius=0.6, percent=45, threshold=0))
        a = a.filter(ImageFilter.UnsharpMask(radius=0.6, percent=35, threshold=0))
        im = Image.merge("RGBA", (*rgb.split(), a))
    return im


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "data", "icons")
    png = subprocess.run(["rsvg-convert", "-w", str(MASTER), "-h", str(MASTER),
                          os.path.join(HERE, "data", "sg-mail.svg")], check=True, capture_output=True).stdout
    big = Image.open(io.BytesIO(png)).convert("RGBA")
    for n in HICOLOR:
        d = os.path.join(out, "%dx%d" % (n, n))
        os.makedirs(d, exist_ok=True)
        # no timestamps or other varying chunks: the same drawing, the same bytes
        reduce(big, n).save(os.path.join(d, "sg-mail.png"), optimize=True)


if __name__ == "__main__":
    main()
