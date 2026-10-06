"""Gate: the real DavMail (sg-image's sg-davmail package, laid over the test
root as installed) as SG Mail runs it, with no Microsoft account and no
route out (a network card that leads nowhere): what can be seen of DavMail
without signing in to Microsoft.

  - "Add calendar and contacts" for a Microsoft account: DavMail's own
    sign-in window opens (its SWT/WebKitGTK browser, at Microsoft's login
    page, unreachable here), from a sign-in gateway on 127.0.0.1 only;
    Cancel closes it, ends DavMail and leaves nothing set up.
  - The account's gateway as the systemd user service: DavMail runs, listens
    on 127.0.0.1 only (refused on the network card's address), with
    NoNewPrivileges and a private umask; without a sign-in it answers
    "No valid refresh token", which SG Mail shows as "Sign in again" -- and
    the service itself never opens a sign-in window; "Sign in again" opens
    DavMail's.

Mutants (test/mutants.json): davmail-service-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import json
import os
import re
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import IMAP_PORT, Env, Gate  # noqa: E402

g = Gate("davmail-service")
env = Env("davmail-service")
MEGAN = "megan@outlook.com"
NAME = "megan-at-outlook.com"
UNIT = f"sg-mail-davmail@{NAME}.service"
HELPER = "/usr/lib/sg-mail/sg-mail-davmail"


def wait(fn, timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def gw_dir():
    return os.path.join(env.dir, "home/.config/sg-mail/davmail", NAME)


def javas():
    out = []
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                cmd = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
            except OSError:
                continue
            if cmd and cmd[0].endswith(b"java"):
                out.append((int(pid), b" ".join(cmd).decode(errors="replace")))
    return out


def davmail_windows():
    return env.x_windows("DavMail")


def listening(port):
    return [l for l in subprocess.run(["ss", "-Hltn"], capture_output=True, text=True).stdout.splitlines() if f":{port} " in l + " "]


def loopback_only(lines):
    """ss lines: each bound to 127.0.0.1 (Java shows it as [::ffff:127.0.0.1])"""
    return bool(lines) and all(re.search(r"\s(\[::ffff:)?127\.0\.0\.1\]?:\d+\s", l + " ") for l in lines)


def state_of(r):
    return next((s["state"] for s in r["status"] if s["email"] == MEGAN), None)


try:
    g.check(os.access("/usr/bin/sg-davmail", os.X_OK) and os.path.exists("/usr/share/sg-davmail/davmail.jar"),
            "(DavMail is installed: the sg-davmail package)")
    env.start_servers()
    env.make_profile()
    env.start_user_manager()
    env.start_thunderbird()
    env.wait_ui("ping", lambda r: r["ready"], timeout=60)
    env.ui("click", selector="#nav-calendar")

    # ---- the sign-in: DavMail's own window, and Cancel ------------------------------------------
    env.megan = env.chrome("""
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const server = MailServices.accounts.createIncomingServer(args.user, "127.0.0.1", "imap");
      server.port = args.port; server.socketType = 0; server.authMethod = 3;
      const id = MailServices.accounts.createIdentity(); id.email = args.user; id.fullName = "Megan Bowen";
      const account = MailServices.accounts.createAccount(); account.addIdentity(id); account.incomingServer = server;
      return account.key;""", {"user": MEGAN, "port": IMAP_PORT})
    env.wait_ui("text", lambda t: t == ["Calendar and contacts (Microsoft)"], selector=".modal .modal-title", timeout=30)
    env.ui("button", label="Add calendar and contacts")
    env.wait_ui("count", lambda n: n > 0, selector=".ms-waiting", timeout=15)
    win = wait(davmail_windows, 90)
    g.check(bool(win), "DavMail's own sign-in window opens (its browser, for Microsoft's login page)", javas())
    props = open(os.path.join(gw_dir(), "signin.properties")).read() if os.path.exists(os.path.join(gw_dir(), "signin.properties")) else ""
    sport = int(next((l.split("=")[1] for l in props.splitlines() if l.startswith("davmail.caldavPort=")), "0"))
    g.check(sport and loopback_only(listening(sport)),
            f"the sign-in gateway listens on 127.0.0.1 only ({sport})", listening(sport))
    g.check("davmail.authenticator" not in props and "O365Interactive" in props, "it is DavMail's interactive sign-in", props[-400:])
    env.ui("click", selector=".ms-waiting .btn", text="Cancel")
    env.wait_ui("count", lambda n: n == 0, selector=".ms-waiting", timeout=30)
    g.check(wait(lambda: not javas() and not davmail_windows(), 30), "Cancel: DavMail's window and DavMail are gone", javas())
    g.check(wait(lambda: not os.path.exists(gw_dir()), 20), "and nothing is left set up", os.listdir(os.path.dirname(gw_dir())) if os.path.exists(os.path.dirname(gw_dir())) else [])
    d = env.ui("calendar")
    g.check(not any(MEGAN in c["name"] for c in d["calendars"]), "no calendar added", [c["name"] for c in d["calendars"]])

    # ---- the service: an account whose sign-in is missing or expired ------------------------------
    out = subprocess.run([HELPER, "setup", NAME, "microsoft", MEGAN], env=env.user_env(), capture_output=True, text=True)
    port = int(out.stdout.split("port=")[1].split()[0])
    env.chrome("""
      Services.prefs.setStringPref("sgmail.davmail." + args.key, JSON.stringify({ name: args.name, email: args.email, user: args.email, kind: "microsoft", port: args.port }));
      const l = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
      l.init("http://127.0.0.1:" + args.port, null, "DavMail Gateway", args.email, "a-password-SG-Mail-made-up", "", "");
      await Services.logins.addLoginAsync(l); return true;""", {"key": env.megan, "name": NAME, "email": MEGAN, "port": port})
    subprocess.run([HELPER, "start", NAME], env=env.user_env(), check=True)
    up = wait(lambda: listening(port), 90)
    g.check(env.systemctl("is-active", UNIT) == "active", f"DavMail runs as the user service {UNIT}", env.systemctl("status", UNIT))
    main = env.systemctl("show", "-p", "MainPID", "--value", UNIT)
    g.check(any(str(pid) == main for pid, _ in javas()), "its main process is DavMail's Java (the helper hands over with exec)", (main, javas()))
    g.check(loopback_only(up), f"listening on 127.0.0.1:{port} only", up)
    try:
        socket.create_connection(("192.0.2.1", port), timeout=3).close()
        refused = False
    except OSError:
        refused = True
    g.check(refused, "not reachable on the network card's address", port)
    props = env.systemctl("show", "-p", "NoNewPrivileges", "-p", "UMask", UNIT)
    g.check("NoNewPrivileges=yes" in props and "UMask=0077" in props, "the service: no new privileges, private files", props)
    r = env.wait_ui("microsoft", lambda r: state_of(r) == "signin", timeout=90)
    g.check(True, "DavMail without a sign-in: SG Mail says \"Sign in again\"", r["status"])
    g.check(not davmail_windows(), "and the service opened no sign-in window of its own", davmail_windows())
    log = open(os.path.join(gw_dir(), "davmail.log")).read() if os.path.exists(os.path.join(gw_dir(), "davmail.log")) else ""
    g.check("refresh token" in log or "refresh token" in json.dumps(r["status"]), "(DavMail: no valid refresh token)", log[-400:])
    env.wait_ui("count", lambda n: n > 0, selector='.ms-row[data-state="signin"] .ms-action', timeout=20)
    env.ui("click", selector='.ms-row[data-state="signin"] .ms-action', text="Sign in again")
    g.check(bool(wait(davmail_windows, 90)), "Sign in again opens DavMail's sign-in window")
    env.ui("click", selector=".ms-waiting .btn", text="Cancel")
    g.check(wait(lambda: not davmail_windows() and len(javas()) == 1, 30), "Cancel closes it; the service keeps running", javas())
    rss = next((int(l.split()[1]) for pid, _ in javas() for l in open(f"/proc/{pid}/status") if l.startswith("VmRSS:")), 0)
    print(f"(DavMail service memory: {rss // 1024} MB resident)")
    env.screenshot(os.path.join(env.dir, "davmail-service.png"))
finally:
    try:
        subprocess.run([HELPER, "remove", NAME], env=env.user_env(), timeout=30)
    except Exception:
        pass
    env.stop()
sys.exit(g.result())
