#!/bin/sh
# Gate: the launcher (/usr/bin/sg-mail). It lays SG Mail's extension and
# settings into SG Mail's own profile and starts Thunderbird with that
# profile and SG Mail's window class; a new extension (a package upgrade)
# replaces the old one and Thunderbird's add-on cache; an administrator's
# /etc/sg-mail/user.js comes after ours; the person's own Thunderbird profile
# is not touched; mailto: links pass through.
#   test/launcher-gate.sh [LAUNCHER]      (--mutants: each mutant must fail)
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
L=${1:-$HERE/launcher/sg-mail}
if [ "$L" = --mutants ]; then
    rc=0; W=$(mktemp -d /var/tmp/sgmail-lm.XXXXXX)
    while IFS='|' read -r name find repl; do
        [ -n "$name" ] || continue
        sed "s|$find|$repl|" "$HERE/launcher/sg-mail" > "$W/$name"
        cmp -s "$W/$name" "$HERE/launcher/sg-mail" && { echo "MUTANT $name: nothing changed"; rc=1; continue; }
        if sh "$0" "$W/$name" >/dev/null 2>&1; then echo "SURVIVED $name"; rc=1; else echo "KILLED  $name"; fi
    done <<'M'
no-xpi-update|if ! cmp -s|if false \&\& ! cmp -s
no-cache-reset|rm -f "$PROFILE/addonStartup.json.lz4"|: rm -f "$PROFILE/addonStartup.json.lz4"
no-policy|cat "${SG_MAIL_POLICY:-/etc/sg-mail/user.js}"|:
no-profile|--profile "$PROFILE"|
no-class|--name sg-mail --class sg-mail|
no-userchrome|cp "$SHARE/userChrome.css"|: cp "$SHARE/userChrome.css"
no-fractional-compat|export GDK_SG_FRACTIONAL=0|: export GDK_SG_FRACTIONAL=0
no-davmail-start|"$DAVMAIL_HELPER" start-all|: "$DAVMAIL_HELPER" start-all
no-wait-ending|while kill -0 "$lockpid"|while false \&\& kill -0 "$lockpid"
M
    rm -rf "$W"; [ $rc = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"; exit $rc
fi
W=$(mktemp -d /var/tmp/sgmail-lg.XXXXXX)
trap 'rm -rf "$W"' EXIT
RC=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; RC=1; }
mkdir -p "$W/share" "$W/home/.thunderbird/own.default"
echo "the person's own profile" > "$W/home/.thunderbird/own.default/prefs.js"
printf 'XPI-1' > "$W/share/sg-mail@stained-glass-os.org.xpi"
cp "$HERE/launcher/user.js" "$W/share/user.js"
cp "$HERE/launcher/userChrome.css" "$W/share/userChrome.css"
printf 'user_pref("mail.server.default.check_time", 30);\n' > "$W/policy.js"
cat > "$W/thunderbird" <<'T'
#!/bin/sh
printf '%s\n' "$@" > "$SG_GATE_ARGS"
printf '%s\n' "${GDK_SG_FRACTIONAL-unset}" > "$SG_GATE_ARGS.fractional"
T
chmod +x "$W/thunderbird"
cat > "$W/davmail-helper" <<'T'
#!/bin/sh
echo "$@" >> "$SG_GATE_DAVMAIL"
T
chmod +x "$W/davmail-helper"
run() { HOME="$W/home" XDG_DATA_HOME="$W/home/.local/share" SG_MAIL_SHARE="$W/share" SG_MAIL_THUNDERBIRD="$W/thunderbird" \
        SG_MAIL_POLICY="$W/policy.js" SG_GATE_ARGS="$W/args" SG_MAIL_DAVMAIL_HELPER="$W/davmail-helper" SG_GATE_DAVMAIL="$W/davmail" \
        DISPLAY=:9 sh "$L" "$@"; }
P="$W/home/.local/share/sg-mail/profile"
run
[ "$(cat "$P/extensions/sg-mail@stained-glass-os.org.xpi" 2>/dev/null)" = XPI-1 ] && pass "the extension is laid into SG Mail's profile" || fail "no extension in the profile"
grep -q '"sgmail.profile", true' "$P/user.js" 2>/dev/null && pass "SG Mail's settings are in its user.js" || fail "no user.js"
grep -q '^user_pref("mail.imap.fetch_by_chunks", false);' "$P/user.js" 2>/dev/null && pass "whole messages in one fetch (no 64 KB chunks: each one a round trip through DavMail)" || fail "IMAP fetches in chunks"
cmp -s "$P/chrome/userChrome.css" "$HERE/launcher/userChrome.css" && grep -q 'legacyUserProfileCustomizations.stylesheets", true' "$P/user.js" \
    && pass "no glimpse of Thunderbird's own view at start (userChrome.css, enabled)" || fail "no userChrome.css"
[ "$(tail -n1 "$P/user.js" 2>/dev/null)" = 'user_pref("mail.server.default.check_time", 30);' ] && pass "an administrator's settings come last (they win)" || fail "the policy is not last"
grep -qx -- "--profile" "$W/args" && grep -qx -- "$P" "$W/args" && pass "Thunderbird starts with SG Mail's profile" || fail "not started with SG Mail's profile: $(tr '\n' ' ' < "$W/args")"
grep -qx -- "--class" "$W/args" && grep -qx -- "sg-mail" "$W/args" && pass "its window class is sg-mail (the taskbar's icon)" || fail "no window class"
[ "$(cat "$W/args.fractional" 2>/dev/null)" = 0 ] && pass "GTK is told Thunderbird scales itself (GDK_SG_FRACTIONAL=0: at 175% not scaled twice)" || fail "GDK_SG_FRACTIONAL: $(cat "$W/args.fractional" 2>/dev/null)"
[ "$(cat "$W/home/.thunderbird/own.default/prefs.js")" = "the person's own profile" ] && [ ! -e "$W/home/.thunderbird/own.default/user.js" ] && pass "the person's own Thunderbird profile is not touched" || fail "own profile touched"
grep -qx "start-all" "$W/davmail" 2>/dev/null && pass "the Microsoft calendar gateways (DavMail user services) are started" || fail "the DavMail gateways are not started"
touch "$P/addonStartup.json.lz4"
run
[ -e "$P/addonStartup.json.lz4" ] && pass "an unchanged extension keeps Thunderbird's add-on cache" || fail "the cache was dropped for nothing"
printf 'XPI-2' > "$W/share/sg-mail@stained-glass-os.org.xpi"
run "mailto:bob@example.test?subject=Hi"
[ "$(cat "$P/extensions/sg-mail@stained-glass-os.org.xpi")" = XPI-2 ] && pass "a new extension (an upgrade) replaces the old" || fail "the old extension stays"
[ ! -e "$P/addonStartup.json.lz4" ] && pass "and Thunderbird's add-on cache is dropped so it loads the new one" || fail "the add-on cache stays"
grep -qx -- "mailto:bob@example.test?subject=Hi" "$W/args" && pass "a mailto: link is passed on" || fail "mailto: lost"
[ "$(stat -c %a "$P")" = 700 ] && pass "the profile is private (0700)" || fail "profile mode $(stat -c %a "$P")"
# a Thunderbird still ending (holding the lock, no window): the new one waits
# for it; one still running (a window): handed the request at once
sleep 30 & OLD=$!
ln -sfn "127.0.1.1:+$OLD" "$P/lock"
printf '#!/bin/sh\n[ -f "%s/haswindow" ] && echo 12345\nexit 0\n' "$W" > "$W/xdotool"; chmod +x "$W/xdotool"
( sleep 2; kill "$OLD" ) &
t0=$(date +%s%3N); SG_MAIL_XDOTOOL="$W/xdotool" run; t1=$(date +%s%3N)
waited=$((t1 - t0))
[ "$waited" -ge 1500 ] && pass "a Thunderbird still ending is waited for (${waited} ms), not met with 'not responding'" || fail "did not wait for the ending Thunderbird (${waited} ms)"
sleep 30 & OLD=$!
ln -sfn "127.0.1.1:+$OLD" "$P/lock"; touch "$W/haswindow"
t0=$(date +%s%3N); SG_MAIL_XDOTOOL="$W/xdotool" run; t1=$(date +%s%3N); kill "$OLD" 2>/dev/null
waited=$((t1 - t0))
[ "$waited" -lt 1000 ] && pass "a running one (it has a window) is handed the request at once" || fail "waited for a running Thunderbird (${waited} ms)"
[ "$RC" = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit "$RC"
