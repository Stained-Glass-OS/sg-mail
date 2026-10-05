#!/bin/sh
# Make SG Mail's test root: Debian trixie (with its security updates) with
# Thunderbird, Xvfb, ImageMagick, Dovecot, Radicale and aiosmtpd; rootless
# (mmdebstrap --mode=unshare, needs /etc/subuid), read-only once made.
#   build/mkroot.sh [ROOT] [THUNDERBIRD_DEB]   (default /var/tmp/sgmail/root-tb)
# THUNDERBIRD_DEB: a thunderbird package to put over Debian's, as apt does on
# an installed machine (Stained Glass OS's own, Mozilla's build: sg-image
# thunderbird/); `make test TB_DEB=...` makes and uses such a root.
set -eu
ROOT=${1:-/var/tmp/sgmail/root-tb}
DEB=${2:-}
PKGS="ca-certificates python3 thunderbird xvfb xauth x11-utils x11-apps xdotool imagemagick
dbus dbus-bin dbus-x11 python3-aiosmtpd radicale dovecot-imapd openssl zip unzip file
fonts-liberation2 fonts-dejavu-core fonts-noto-color-emoji fonts-inter"
[ ! -e "$ROOT" ] || { echo "$ROOT exists"; exit 1; }
set --
if [ -n "$DEB" ]; then
    b=$(basename "$DEB")
    set -- --customize-hook="copy-in $(realpath "$DEB") /tmp" \
        --customize-hook="chroot \"\$1\" env DEBIAN_FRONTEND=noninteractive apt-get -y -q install /tmp/$b" \
        --customize-hook="rm -f \"\$1/tmp/$b\""
fi
nice -n 10 mmdebstrap --mode=unshare --variant=apt --format=directory \
    --include="$(echo $PKGS | tr ' ' ,)" \
    "$@" \
    trixie "$ROOT" \
    "deb http://deb.debian.org/debian trixie main" \
    "deb http://deb.debian.org/debian-security trixie-security main" \
    "deb http://deb.debian.org/debian trixie-updates main"
