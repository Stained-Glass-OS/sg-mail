#!/bin/sh
# Make SG Mail's test root: Debian trixie (with its security updates) with
# Thunderbird, Xvfb, ImageMagick, Dovecot, Radicale and aiosmtpd; rootless
# (mmdebstrap --mode=unshare, needs /etc/subuid), read-only once made.
#   build/mkroot.sh [ROOT]          (default /var/tmp/sgmail/root-tb)
set -eu
ROOT=${1:-/var/tmp/sgmail/root-tb}
PKGS="ca-certificates python3 thunderbird xvfb xauth x11-utils x11-apps xdotool imagemagick
dbus dbus-bin dbus-x11 python3-aiosmtpd radicale dovecot-imapd openssl zip unzip file
fonts-liberation2 fonts-dejavu-core fonts-noto-color-emoji fonts-inter"
[ ! -e "$ROOT" ] || { echo "$ROOT exists"; exit 1; }
nice -n 10 mmdebstrap --mode=unshare --variant=apt --format=directory \
    --include="$(echo $PKGS | tr ' ' ,)" trixie "$ROOT" \
    "deb http://deb.debian.org/debian trixie main" \
    "deb http://deb.debian.org/debian-security trixie-security main" \
    "deb http://deb.debian.org/debian trixie-updates main"
