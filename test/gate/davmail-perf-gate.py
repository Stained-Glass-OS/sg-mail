"""Gate: a Microsoft account's mail through DavMail, quick to read -- the
stand-in gateway before Dovecot, the helper and user unit as installed.

What the real account showed (QA VM, 2026-10-06): every message not kept on
this computer is a round trip to Microsoft; Thunderbird's autosync held the
folder for minutes (no useful order) while a click waited behind it, and a
message came in 64 KB chunks, each a request of its own; read only a second
after it was shown; a gateway that stopped answering raised Thunderbird's
"connection to 127.0.0.1" dialog.

Checked here: the account's settings (no Thunderbird autosync, whole
messages, IDLE and a check each minute, three connections; whole-message
fetches); the newest messages of the last 30 days fetched here first,
newest first, older ones not; a click on one: shown from here in well under
half a second, read at once, the server's \\Seen soon after; the ones beside
it fetched ahead; the gateway stopped: SG Mail starts it again, "Reconnecting
to Microsoft…", no dialog; DavMail killed: systemd starts it again; DavMail's
Java with room for a big mailbox (-Xmx1g) and out on OutOfMemoryError.

Mutants (test/mutants.json): davmail-perf-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import signal
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import CALDAV_PORT, IMAP_PORT, SMTP_PORT, SRC, Env, Gate, message  # noqa: E402

g = Gate("davmail-perf")
env = Env("davmail-perf", accounts=())
MEGAN = "megan@outlook.com"
NAME = "megan-at-outlook.com"
UNIT = f"sg-mail-davmail@{NAME}.service"
DAY = 86400


def wait(fn, timeout=40, every=0.5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(every)
    return None


def gw_dir():
    return os.path.join(env.dir, "home/.config/sg-mail/davmail", NAME)


OFFLINE = """const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const acct = MailServices.accounts.accounts.find(a => a.defaultIdentity?.email == args);
if (!acct) return null;
const inbox = acct.incomingServer.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
if (!inbox) return null;
return [...inbox.msgDatabase.enumerateMessages()].map(h => [h.subject, !!(h.flags & Ci.nsMsgMessageFlags.Offline)]);"""


def offline():
    try:
        return dict(env.chrome(OFFLINE, MEGAN) or [])
    except Exception:
        return {}


def main_pid():
    return env.systemctl("show", "-p", "MainPID", "--value", UNIT)


try:
    env.start_servers()
    env.make_davmail_collections(MEGAN)
    now = time.time()
    # 40 of the last 28 days ("Recent 01" the newest; more than the list
    # shows at once, so SG Mail's prefetch has its own to fetch), 5 of two
    # months ago
    for i in range(1, 41):
        env.append("INBOX", message("Nestor Wilke <nestor@contoso.test>", f"Megan Bowen <{MEGAN}>", f"Recent {i:02d}",
                                    text=f"Message {i}. " + "Lorem ipsum. " * 200, date=now - i * DAY * 0.7 + 600), user=MEGAN)
    for i in range(1, 6):
        env.append("INBOX", message("Nestor Wilke <nestor@contoso.test>", f"Megan Bowen <{MEGAN}>", f"Old {i:02d}",
                                    text="An old one.", date=now - (60 + i) * DAY), user=MEGAN)
    env.make_profile()
    dm_env = {"SG_DAVMAIL": os.path.join(SRC, "test/servers/davmail_standin.py"),
              "SG_STANDIN_UPSTREAM": f"http://127.0.0.1:{CALDAV_PORT}", "SG_STANDIN_UPSTREAM_AUTH": f"{MEGAN}:megan-secret",
              "SG_STANDIN_IMAP": f"127.0.0.1:{IMAP_PORT}", "SG_STANDIN_SMTP": f"127.0.0.1:{SMTP_PORT}"}
    env.start_user_manager(dm_env)
    env.start_thunderbird(mutant_env=dm_env)

    # ---- the account, through DavMail (SG Mail's own account step) ------------------------------
    env.wait_ui("text", lambda t: bool(t) and t[-1] == "Add an account", selector=".modal .modal-title", timeout=60)
    env.ui("type", selector=".modal #aa-name", value="Megan Bowen")
    env.ui("type", selector=".modal #aa-email", value=MEGAN)
    env.ui("button", label="Next")
    env.wait_ui("text", lambda t: bool(t) and t[-1] == "Microsoft account", selector=".modal .modal-title", timeout=30)
    env.ui("button", label="Connect")
    wait(lambda: env.x_windows("DavMail stand-in sign-in"), 60)
    order = []
    open(os.path.join(gw_dir(), "signin.approve"), "w").close()

    # ---- what is fetched here, in which order ---------------------------------------------------
    deadline = time.time() + 120
    while time.time() < deadline:
        off = offline()
        for subj, isoff in off.items():
            if isoff and subj not in order:
                order.append(subj)
        if off and all(off.get(f"Recent {i:02d}") for i in range(1, 41)):
            break
        time.sleep(0.2)
    recent = [s for s in order if s.startswith("Recent")]
    g.check(len(recent) == 40, "the newest month's messages are fetched here (all 40)", order)
    first = recent[:6]
    g.check(set(first) <= {f"Recent {i:02d}" for i in range(1, 9)}, "newest first (the first fetched are among the newest eight)", first)
    # SG Mail's own prefetch, from nothing kept here (the list's previews
    # above already fetched what they showed): the store's flags taken off,
    # then the order in which the messages come back
    env.chrome("""const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const inbox = MailServices.accounts.accounts.find(a => a.defaultIdentity?.email == args).incomingServer.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
      for (const h of inbox.msgDatabase.enumerateMessages()) h.andFlags(~Ci.nsMsgMessageFlags.Offline);
      return true;""", MEGAN)
    env.ui("prefetchNow")
    order2 = []
    deadline = time.time() + 120
    while time.time() < deadline:
        off = offline()
        for subj, isoff in off.items():
            if isoff and subj not in order2:
                order2.append(subj)
        if all(off.get(f"Recent {i:02d}") for i in range(1, 41)):
            break
        time.sleep(0.2)
    nums = [int(x.split()[1]) for x in order2 if x.startswith("Recent")]
    g.check(len(nums) == 40 and nums[:10] == sorted(nums[:10]) and max(nums[:10]) <= 15,
            "SG Mail's prefetch: the newest first (Recent 01, 02, ... in that order)", order2[:15])
    time.sleep(3)
    off = offline()
    g.check(not any(off.get(f"Old {i:02d}") for i in range(1, 6)), "and none older than 30 days", {k: v for k, v in off.items() if k.startswith("Old")})
    prefs = env.chrome("""const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const s = MailServices.accounts.accounts.find(a => a.defaultIdentity?.email == args).incomingServer;
      return { autosync: s.getBoolValue("autosync_offline_stores"), parts: s.getBoolValue("mime_parts_on_demand"), idle: s.getBoolValue("use_idle"),
               check: s.getBoolValue("check_new_mail"), every: s.getIntValue("check_time"), conns: s.getIntValue("max_cached_connections"),
               chunks: Services.prefs.getBoolPref("mail.imap.fetch_by_chunks", true) };""", MEGAN)
    g.check(prefs == {"autosync": False, "parts": False, "idle": True, "check": True, "every": 1, "conns": 3, "chunks": False},
            "the account: no Thunderbird autosync, whole messages, IDLE and a check each minute, three connections; whole-message fetches", prefs)

    # ---- a click: shown from here at once, read at once ---------------------------------------
    env.wait_ui("mail", lambda r: any(x.get("subject") == "Recent 03" for x in r["list"]), timeout=60)
    t = env.ui("openTimed", subject="Recent 03")
    g.check(t["offline"] and t["ms"] < 500, f"a click on a message fetched ahead: shown in {t['ms']} ms (under 0.5 s)", t)
    g.check(t["readAtClick"] is True, "and marked read on the click itself", t)
    busy = env.ui("busyFor")
    g.check(busy > 1000, "and background fetching (previews, prefetch) gives way to it for a few seconds", busy)
    seen = wait(lambda: any(r"\Seen" in f for f, raw in env.mailbox("INBOX", user=MEGAN) if b"Subject: Recent 03" in raw), 30)
    g.check(bool(seen), "the server's \\Seen follows in the background")

    # ---- the ones beside a message opened: fetched ahead -----------------------------------------
    # (Old 02 taken off this computer's store: as one not fetched yet)
    env.chrome("""const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const inbox = MailServices.accounts.accounts.find(a => a.defaultIdentity?.email == args).incomingServer.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
      for (const h of inbox.msgDatabase.enumerateMessages()) if (h.subject == "Old 02") h.andFlags(~Ci.nsMsgMessageFlags.Offline);
      return true;""", MEGAN)
    g.check(not offline().get("Old 02"), "(Old 02 is not here)")
    env.ui("openTimed", subject="Old 01")
    g.check(bool(wait(lambda: offline().get("Old 02"), 30)), "opening Old 01 fetches the next one (Old 02) ahead")

    # ---- the gateway stopped: started again, quietly --------------------------------------------
    env.systemctl("stop", UNIT)
    wait(lambda: env.systemctl("is-active", UNIT) != "active", 20)
    env.ui("sendReceive")
    healed = wait(lambda: env.systemctl("is-active", UNIT) == "active" and "recovered" in env.ui("microsoft").get("trouble", []), 90)
    g.check(bool(healed), "the gateway stopped: SG Mail starts it again when Thunderbird finds it not answering", env.ui("microsoft").get("trouble"))
    dialogs = env.chrome("""const out = [];
      for (const w of Services.wm.getEnumerator(null)) if (/commonDialog|alert/.test(w.location?.href || "")) out.push(w.location.href);
      const tb = Services.wm.getMostRecentWindow("mail:3pane");
      for (const d of tb.document.querySelectorAll("dialog[open], .dialogBox")) out.push(d.localName);
      return out;""")
    g.check(dialogs == [], "no dialog about 127.0.0.1", dialogs)
    trouble = env.ui("microsoft")["trouble"]
    g.check("reconnecting" in trouble, "\"Reconnecting to Microsoft…\" in the status bar meanwhile", trouble)

    # ---- DavMail killed: systemd starts it again; its Java's settings ---------------------------
    pid = main_pid()
    env_text = open(f"/proc/{pid}/environ", "rb").read().decode(errors="replace") if pid.isdigit() else ""
    g.check("-Xmx1g" in env_text and "-XX:+ExitOnOutOfMemoryError" in env_text, "DavMail's Java: 1 GB of heap, and out at once on OutOfMemoryError", pid)
    os.kill(int(pid), signal.SIGKILL)
    back = wait(lambda: env.systemctl("is-active", UNIT) == "active" and main_pid() not in ("0", pid), 30)
    g.check(bool(back), "DavMail killed: systemd starts it again (Restart=always)", (pid, main_pid()))
finally:
    env.stop()
sys.exit(g.result())
