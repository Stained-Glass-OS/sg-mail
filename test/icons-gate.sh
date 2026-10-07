#!/bin/sh
# Gate: SG Mail's Linux icons. The package installs hicolor PNGs at every
# size desktops ask for -- 16, 22, 24, 32, 48, 64, 96, 128, 256 and 512 px --
# plus the scalable SVG; each PNG is its size, and the committed PNGs are what
# tools/gen-icons.py makes from the vector source today (no hand-made or
# stale picture). --mutants: SG_MUTANT_ICON_SIZES (the old seven sizes) fails.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
if [ "${1:-}" = --mutants ]; then
    if SG_MUTANT_ICON_SIZES=1 sh "$0" >/dev/null 2>&1; then echo "SURVIVED icon-sizes"; echo "RESULT: FAIL"; exit 1; fi
    echo "KILLED  icon-sizes"; echo "RESULT: PASS"; exit 0
fi
command -v rsvg-convert >/dev/null && python3 -c 'import PIL' 2>/dev/null || { echo "SKIP: rsvg-convert or python3-pil missing"; exit 77; }
T=$(mktemp -d /var/tmp/sgmail-icons.XXXXXX); trap 'rm -rf "$T"' EXIT INT TERM
RC=0
# what the package lays out, from icons made now (the mutant makes fewer)
mkdir -p "$T/src"; for d in Makefile data extension launcher tools; do cp -a "$HERE/$d" "$T/src/"; done
rm -rf "$T/src/data/icons"
python3 "$T/src/tools/gen-icons.py" "$T/src/data/icons" || RC=1
make -s -C "$T/src" install DESTDIR="$T/dest" >/dev/null 2>&1 || { echo "FAIL  make install"; RC=1; }
python3 - "$T/dest/usr/share/icons/hicolor" "$HERE/data/icons" "$T/src/data/icons" <<'PY' || RC=1
import os, sys
from PIL import Image, ImageChops
hic, committed, fresh = sys.argv[1:4]
rc = 0
def check(ok, what):
    global rc
    print(("PASS  " if ok else "FAIL  ") + what)
    rc |= not ok
check(os.path.isfile(os.path.join(hic, "scalable/apps/sg-mail.svg")), "the scalable icon is installed")
for n in (16, 22, 24, 32, 48, 64, 96, 128, 256, 512):
    p = os.path.join(hic, f"{n}x{n}/apps/sg-mail.png")
    if not os.path.isfile(p):
        check(False, f"{n} px icon installed"); continue
    im = Image.open(p)
    check(im.size == (n, n) and im.mode == "RGBA", f"{n} px icon installed, {im.size[0]}x{im.size[1]} {im.mode}")
    c = os.path.join(committed, f"{n}x{n}/sg-mail.png")
    f = os.path.join(fresh, f"{n}x{n}/sg-mail.png")
    if os.path.isfile(c) and os.path.isfile(f):
        diff = ImageChops.difference(Image.open(c).convert("RGBA"), Image.open(f).convert("RGBA"))
        worst = max(b[1] for b in diff.getextrema())
        check(worst <= 8, f"{n} px committed icon is the vector source's (max channel difference {worst})")
    else:
        check(False, f"{n} px committed icon exists in data/icons")
sys.exit(rc)
PY
[ $RC = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $RC
