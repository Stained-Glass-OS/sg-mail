"""Gate: what Home does to messages, and new mail. Mark as Read / Unread
(Ctrl+Q / Ctrl+U, Ctrl+Q typed for real: it must not quit), Follow Up
(Insert), Delete (to Deleted Items), Archive (Backspace), Move to another
folder (Ctrl+Shift+V's folder dialog), Junk, each reaching the IMAP server;
a message delivered while SG Mail runs appears in the Inbox, with a desktop
notification; Send/Receive (F9).

Mutants (test/mutants.json): actions-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import smtplib
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message, SMTP_PORT, USERS  # noqa: E402

g = Gate("actions")
env = Env("actions", with_caldav=False)


def wait(fn, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def flags(subject, box="INBOX"):
    for f, raw in env.mailbox(box):
        if f"Subject: {subject}".encode() in raw:
            return f
    return None


def in_box(subject, box):
    return any(f"Subject: {subject}".encode() in raw for f, raw in env.mailbox(box))


def listed(subject):
    return any(x.get("subject") == subject for x in env.ui("mail")["list"])


try:
    env.start_servers()
    for i, s in enumerate(["One", "Two", "Three", "Four", "Five", "Six"]):
        env.append("INBOX", message("Bob Builder <bob@example.test>", "alice@example.test", f"Message {s}", text=f"Text {s}.",
                                    date=time.time() - 600 * (i + 1)), date=time.time() - 600 * (i + 1))
    env.append("Projects", message("Bob Builder <bob@example.test>", "alice@example.test", "Already filed", text="x"), seen=True)
    env.make_profile()
    env.start_thunderbird()
    env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 6, timeout=90)
    env.ui("selectFolder", name="Projects")
    time.sleep(2)
    env.ui("selectFolder", name="Inbox")
    env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 6, timeout=30)

    # read / unread
    env.ui("selectMessage", subject="Message One")
    time.sleep(0.3)
    env.ui("key", selector="#message-list", key="q", ctrl=True)
    g.check(wait(lambda: "\\Seen" in (flags("Message One") or "")), "Ctrl+Q marks it read on the server")
    env.ui("key", selector="#message-list", key="u", ctrl=True)
    g.check(wait(lambda: "\\Seen" not in (flags("Message One") or "\\Seen")), "Ctrl+U marks it unread again")
    d = env.ui("mail")
    g.check(any(x.get("subject") == "Message One" and x["unread"] for x in d["list"]), "the list shows it unread")

    # Ctrl+Q typed on the keyboard: Mark as Read, and Thunderbird keeps running
    env.ui("selectMessage", subject="Message Two")
    wait(lambda: "\\Seen" in (flags("Message Two") or ""), 10)      # read once shown
    env.ui("key", selector="#message-list", key="u", ctrl=True)
    g.check(wait(lambda: "\\Seen" not in (flags("Message Two") or "\\Seen")), "(unread again before the real key)")
    env.ui("focus", selector="#message-list")
    env.chrome("""Services.wm.getMostRecentWindow("mail:3pane").focus(); return true;""")
    r = subprocess.run(["xdotool", "key", "--clearmodifiers", "ctrl+q"], env=dict(os.environ, DISPLAY=":91"), capture_output=True)
    time.sleep(3)
    alive = env.tb.poll() is None
    g.check(alive, "a real Ctrl+Q does not quit SG Mail", r.stderr.decode()[:200])
    if alive:
        g.check(wait(lambda: "\\Seen" in (flags("Message Two") or ""), 15), "it marks the message read", flags("Message Two"))

    # flag
    env.ui("selectMessage", subject="Message Three")
    env.ui("key", selector="#message-list", key="Insert")
    g.check(wait(lambda: "\\Flagged" in (flags("Message Three") or "")), "Insert flags it (Follow Up) on the server")

    # delete
    env.ui("selectMessage", subject="Message Four")
    env.ui("key", selector="#message-list", key="Delete")
    g.check(wait(lambda: in_box("Message Four", "Trash"), 30), "Delete moves it to Deleted Items on the server")
    g.check(wait(lambda: not listed("Message Four"), 10), "and out of the list")

    # archive
    env.ui("selectMessage", subject="Message Five")
    env.ui("key", selector="#message-list", key="Backspace")
    g.check(wait(lambda: in_box("Message Five", "Archive") or any(b"Message Five" in r for f, r in env.mailbox("Archive/" + time.strftime("%Y"))), 30),
            "Backspace archives it")

    # move with the folder dialog
    env.ui("selectMessage", subject="Message Six")
    env.ui("key", selector="#message-list", key="v", ctrl=True, shift=True)
    env.wait_ui("count", lambda n: n > 0, selector=".modal .fp-row", timeout=10)
    env.ui("click", selector=".modal .fp-row .fp-name", text="Projects")
    env.ui("button", label="OK")
    g.check(wait(lambda: in_box("Message Six", "Projects"), 30), "Move to Folder moves it to Projects on the server")

    # junk
    env.ui("selectMessage", subject="Message Two")
    env.ui("click", selector="#rb-junk")
    env.ui("menu", label="Block Sender / Junk")
    g.check(wait(lambda: in_box("Message Two", "Junk"), 30), "Junk moves it to Junk Email")

    # new mail while running: delivered by SMTP, it shows up and is announced
    s = smtplib.SMTP("127.0.0.1", SMTP_PORT)
    s.login("bob@example.test", USERS["bob@example.test"][1])
    s.sendmail("bob@example.test", ["alice@example.test"], message("Bob Builder <bob@example.test>", "alice@example.test",
                                                                    "Fresh news", text="Just arrived."))
    s.quit()
    env.ui("key", selector="#message-list", key="F9")
    d = env.wait_ui("mail", lambda r: any(x.get("subject") == "Fresh news" for x in r["list"]), timeout=90)
    g.check(True, "new mail appears in the Inbox")
    note = [n for n in d["notifications"] if n["kind"] == "mail" and n["message"] == "Fresh news"]
    g.check(bool(note) and note[0]["title"] == "Bob Builder", "a desktop notification names the sender and subject", d["notifications"])
    g.check(any(x.get("subject") == "Fresh news" and x["unread"] for x in d["list"]), "unread")
    env.screenshot(os.path.join(env.dir, "actions.png"))
finally:
    env.stop()
sys.exit(g.result())
