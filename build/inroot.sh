#!/bin/sh
# Run a command in SG Mail's test root (a Debian trixie system with
# Thunderbird, Xvfb, Dovecot, Radicale and aiosmtpd; read-only) as the
# calling user, with the work area writable. No privileges: bwrap. The
# caller's own account is added to the root's passwd/group (Dovecot and
# Thunderbird look the user up).
#   SG_ROOT=... SG_AREA=... build/inroot.sh CMD...
# A checkout outside the work area (a release worktree) is seen at
# /var/tmp/sg-mail-src inside, and SG_CWD under it is translated there.
# SG_NONET=1: no network but its own loopback (the gates: nothing can reach
# a real mail provider).
ROOT=${SG_ROOT:-/var/tmp/sgmail/root-tb}
AREA=${SG_AREA:-/var/tmp/sgmail}
SRC=$(cd "$(dirname "$0")/.." && pwd)
CWD=${SG_CWD:-$PWD}
mkdir -p "$AREA/home" "$AREA/etc"
u=$(id -un); uid=$(id -u); g=$(id -gn); gid=$(id -g)
{ cat "$ROOT/etc/passwd"; echo "$u:x:$uid:$gid:$u:$AREA/home:/bin/sh"; } > "$AREA/etc/passwd"
{ cat "$ROOT/etc/group"; echo "$g:x:$gid:"; } > "$AREA/etc/group"
case "$SRC/" in
    "$AREA"/*) MAP= ;;
    *) MAP="--bind $SRC /var/tmp/sg-mail-src"
       case "$CWD/" in "$SRC"/*) CWD=/var/tmp/sg-mail-src${CWD#"$SRC"} ;; esac ;;
esac
NET=; [ -n "${SG_NONET:-}" ] && NET=--unshare-net
exec bwrap --die-with-parent $NET --ro-bind "$ROOT" / --tmpfs /var/tmp --bind "$AREA" "$AREA" $MAP \
  --ro-bind "$AREA/etc/passwd" /etc/passwd --ro-bind "$AREA/etc/group" /etc/group \
  --dev /dev --proc /proc --tmpfs /tmp --tmpfs /run --tmpfs /dev/shm \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --setenv HOME "$AREA/home" --setenv PATH /usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  --chdir "$CWD" "$@"
