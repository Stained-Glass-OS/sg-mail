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
# a real mail provider), and a PID namespace of its own (nothing outlives it).
# SG_NONET=lan: the same, with a network card besides the loopback that
# leads nowhere (a dummy interface, 192.0.2.1/24, no route out) -- for
# programs that test "is there a network" before they try (DavMail); with
# /sys (cgroups) for a systemd user manager of the gate's own.
# SG_STAGE=DIR: DIR/usr laid over the root's /usr (packages installed as
# the package would: `make stage`).
ROOT=${SG_ROOT:-/var/tmp/sgmail/root-tb-r3}
AREA=${SG_AREA:-/var/tmp/sgmail}
SRC=$(cd "$(dirname "$0")/.." && pwd)
CWD=${SG_CWD:-$PWD}
# SG_NONET=lan: first the namespaces and the card (unshare, as root inside),
# then this script again in them (SG_LAN_INSIDE: the caller's ids passed on)
if [ "${SG_NONET:-}" = lan ] && [ -z "${SG_LAN_INSIDE:-}" ]; then
    SG_LAN_INSIDE="$(id -un):$(id -u):$(id -gn):$(id -g)" SG_CWD=$CWD
    export SG_LAN_INSIDE SG_CWD
    exec unshare --user --map-root-user --net --pid --fork --mount-proc --kill-child sh -c \
        'ip link set lo up && ip link add sg0 type dummy && ip addr add 192.0.2.1/24 dev sg0 && ip link set sg0 up && exec sh "$@"' \
        sg-lan "$0" "$@"
fi
mkdir -p "$AREA/home" "$AREA/etc"
if [ -n "${SG_LAN_INSIDE:-}" ]; then
    IFS=: read -r u uid g gid <<EOF
$SG_LAN_INSIDE
EOF
else
    u=$(id -un); uid=$(id -u); g=$(id -gn); gid=$(id -g)
fi
{ cat "$ROOT/etc/passwd"; echo "$u:x:$uid:$gid:$u:$AREA/home:/bin/sh"; } > "$AREA/etc/passwd"
{ cat "$ROOT/etc/group"; echo "$g:x:$gid:"; } > "$AREA/etc/group"
case "$SRC/" in
    "$AREA"/*) MAP= ;;
    *) MAP="--bind $SRC /var/tmp/sg-mail-src"
       case "$CWD/" in "$SRC"/*) CWD=/var/tmp/sg-mail-src${CWD#"$SRC"} ;; esac ;;
esac
STAGE=; [ -n "${SG_STAGE:-}" ] && STAGE="--overlay-src $ROOT/usr --overlay-src $SG_STAGE/usr --ro-overlay /usr"
NET=; [ -n "${SG_NONET:-}" ] && NET="--unshare-net --unshare-pid"
LAN=
if [ -n "${SG_LAN_INSIDE:-}" ]; then
    # in unshare's namespaces already: back to the caller's ids, with /sys
    NET="--unshare-user --uid $uid --gid $gid"
    LAN="--ro-bind /sys /sys --bind /sys/fs/cgroup /sys/fs/cgroup"
fi
# shellcheck disable=SC2086  # the option lists, split
exec bwrap --die-with-parent $NET --ro-bind "$ROOT" / $STAGE --tmpfs /var/tmp --bind "$AREA" "$AREA" $MAP \
  --ro-bind "$AREA/etc/passwd" /etc/passwd --ro-bind "$AREA/etc/group" /etc/group \
  --dev /dev --proc /proc --tmpfs /tmp --tmpfs /run --tmpfs /dev/shm $LAN \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --setenv HOME "$AREA/home" --setenv SG_AREA "$AREA" --setenv PATH /usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  --chdir "$CWD" "$@"
