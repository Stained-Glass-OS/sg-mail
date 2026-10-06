"""Gate: many messages at once, as in Outlook. Ctrl+A typed on the keyboard
with the message list focused selects every message in the view (also
shown as conversations: every conversation's messages), and the reading
pane says "N items selected"; Ctrl+A in the search box selects its text
instead. Home > Unread/ Read toggles: all read -> unread, otherwise read;
Ctrl+Q / Ctrl+U; right-click > Mark as Read and Mark as Unread -- each one
batch on the IMAP server. With all selected: Follow Up (flag) and its
clearing, Categorize, Move, Archive and Delete act on every message.
Respond > Meeting: a meeting with the message's people. A folder's
right-click: Mark All as Read.

Mutants (test/mutants.json): multi-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message  # noqa: E402

g = Gate("multiselect")
env = Env("multiselect", with_caldav=False)
ALICE = "Alice Example <alice@example.test>"
N = 30
X = dict(os.environ, DISPLAY=":91")


def wait(fn, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def box_flags(box="INBOX"):
    return [f for f, raw in env.mailbox(box)]


def count(box, flag, have=True):
    return sum(1 for f in box_flags(box) if (flag in f) == have)


def listed(d):
    return [x for x in d["list"] if "id" in x]


def real_key(keys, selector="#message-list"):
    for wid in subprocess.run(["xdotool", "search", "--name", "SG Mail"], env=X, capture_output=True, text=True).stdout.split()[:1]:
        subprocess.run(["xdotool", "windowfocus", "--sync", wid], env=X, capture_output=True)
    env.chrome("""const w = Services.wm.getMostRecentWindow("mail:3pane"); w.focus();
      const t = w.document.getElementById("tabmail").tabInfo.find(t => t.browser && t.browser.currentURI.spec.includes("/ui/main.html"));
      t.browser.focus(); return true;""")
    env.ui("focus", selector=selector)
    subprocess.run(["xdotool", "key", keys], env=X, capture_output=True)


def select_range(first, last, n):
    """Shift+click: the messages first..last; their number in the reading pane."""
    env.ui("selectMessage", subject=first)
    env.ui("clickRow", subject=last, shift=True)
    d = wait(lambda: (lambda r: r if r["reader"].get("many") == n else None)(env.ui("mail")), 15) or env.ui("mail")
    print("range:", d["reader"], sum(1 for x in listed(d) if x["selected"]), flush=True)
    return d["reader"].get("many") == n


def select_all():
    real_key("ctrl+a")
    return env.wait_ui("mail", lambda r: sum(1 for x in listed(r) if x["selected"]) == len(listed(r)) and r["reader"].get("many"), timeout=20)


try:
    env.start_servers()
    now = time.time()
    for i in range(N):
        t = now - 300 * (i + 1)
        rf = [("References", "<m0@x.test>"), ("In-Reply-To", "<m0@x.test>")] if i in (1, 2) else []
        env.append("INBOX", message(f"Sender {i} <s{i}@example.test>", ALICE, f"Message {i:02d}", text=f"Text {i}.", date=t, msgid=f"<m{i}@x.test>",
                                    extra_headers=rf), seen=i % 3 == 0, date=t)
    env.make_profile()
    env.start_thunderbird()
    env.wait_ui("mail", lambda r: len(listed(r)) >= 1, timeout=90)
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-focused-inbox")
    env.wait_ui("mail", lambda r: r["focused"] is None and len(listed(r)) == N, timeout=30)
    env.ui("click", selector='.ribbon-tab[data-tab="home"]')
    env.ui("selectMessage", subject="Message 05")

    # ---- Ctrl+A ----
    real_key("ctrl+a")
    d = wait(lambda: (lambda r: r if r["reader"].get("many") == N else None)(env.ui("mail")), 20) or env.ui("mail")
    g.check(d["reader"].get("many") == N, f"a real Ctrl+A in the list selects all {N} messages; the reading pane: {N} items selected", d["reader"])
    env.ui("type", selector="#search", value="hello there")
    real_key("ctrl+a", "#search")
    time.sleep(1)
    sel = env.ui("textSelection", selector="#search")
    g.check(sel == [0, 11], "Ctrl+A in the search box selects its text", sel)
    env.ui("type", selector="#search", value="")
    env.ui("key", selector="#search", key="Escape")
    env.wait_ui("mail", lambda r: len(listed(r)) == N, timeout=30)

    # ---- read / unread on all, batch ----
    env.ui("selectMessage", subject="Message 05")
    select_all()
    env.ui("click", selector="#rb-unread-read")
    g.check(wait(lambda: count("INBOX", "\\Seen") == N), "Unread/ Read with some unread: all marked read on the server", count("INBOX", "\\Seen"))
    env.ui("click", selector="#rb-unread-read")
    g.check(wait(lambda: count("INBOX", "\\Seen", False) == N), "again, all read: all marked unread", count("INBOX", "\\Seen"))
    real_key("ctrl+q")
    g.check(wait(lambda: count("INBOX", "\\Seen") == N), "Ctrl+Q: all read")
    real_key("ctrl+u")
    g.check(wait(lambda: count("INBOX", "\\Seen", False) == N), "Ctrl+U: all unread")
    env.ui("contextmenu", selector=".ml-msg.selected")
    labels = env.ui("text", selector=".menu .mi-label")
    g.check("Mark as Read" in labels and "Mark as Unread" in labels, "right-click: Mark as Read and Mark as Unread", labels)
    env.ui("menu", label="Mark as Read")
    g.check(wait(lambda: count("INBOX", "\\Seen") == N), "right-click > Mark as Read: all read")

    # ---- flag, categorize ----
    env.ui("click", selector="#rb-follow-up")
    g.check(wait(lambda: count("INBOX", "\\Flagged") == N), "Follow Up: every selected message flagged", count("INBOX", "\\Flagged"))
    env.ui("click", selector="#rb-follow-up")
    g.check(wait(lambda: count("INBOX", "\\Flagged") == 0), "again: every flag cleared", count("INBOX", "\\Flagged"))
    env.ui("click", selector="#rb-categorize")
    env.ui("menu", label="Important")
    g.check(wait(lambda: count("INBOX", "$label1") == N), "Categorize: every one Important", count("INBOX", "$label1"))
    real_key("ctrl+u")
    wait(lambda: count("INBOX", "\\Seen", False) == N)

    # ---- Respond > Meeting ----
    env.ui("selectMessage", subject="Message 07")
    env.ui("click", selector="#rb-reply-meeting")
    e = env.wait_ui("dump", lambda r: r["meeting"], target="event", timeout=40)
    g.check(e["title"] == "Message 07" and "s7@example.test" in e["attendees"], "Meeting: a meeting with the sender, the message's subject", e)
    env.ui("close", target="event")
    time.sleep(1)
    try:
        env.ui("button", target="event", label="No", timeout_ms=4000)
    except Exception:
        pass

    # ---- conversations: Ctrl+A selects every conversation's messages ----
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-conversations")
    env.wait_ui("mail", lambda r: any("conv" in x for x in r["list"]), timeout=30)
    env.ui("click", selector='.ribbon-tab[data-tab="home"]')
    env.ui("selectMessage", subject="Message 10")
    real_key("ctrl+a")
    d = env.wait_ui("mail", lambda r: r["reader"].get("many"), timeout=20)
    g.check(d["reader"]["many"] == N, f"as conversations: Ctrl+A selects all {N} messages (the conversation's 3 too)", d["reader"])
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-conversations")
    d = env.wait_ui("mail", lambda r: not r["conversations"], timeout=20)
    g.check(not any(x["selected"] for x in listed(d)), "(conversations off: nothing selected)")
    env.ui("click", selector='.ribbon-tab[data-tab="home"]')

    # ---- move a part, archive a part, delete the rest ----
    g.check(select_range("Message 00", "Message 09", 10), "Shift+click: 10 selected")
    env.ui("click", selector="#rb-move")
    env.ui("menu", label="Junk Email")
    g.check(wait(lambda: len(box_flags("Junk")) == 10), "Move: the 10 selected to Junk Email", len(box_flags("Junk")))
    env.wait_ui("mail", lambda r: len(listed(r)) == N - 10, timeout=30)
    g.check(select_range("Message 10", "Message 19", 10), "Shift+click: the next 10 selected")
    env.ui("click", selector="#rb-archive")
    g.check(wait(lambda: len(env.mailbox("Archive")) + sum(len(env.mailbox(f"Archive/{y}")) for y in (time.strftime("%Y"),)) == 10), "Archive: the 10 selected")
    env.wait_ui("mail", lambda r: len(listed(r)) == N - 20, timeout=30)
    env.ui("selectMessage", subject="Message 25")
    select_all()
    env.ui("click", selector="#rb-delete")
    g.check(wait(lambda: len(box_flags("Trash")) == N - 20 and not box_flags("INBOX")), "Delete: the rest to Deleted Items", len(box_flags("Trash")))

    # ---- a folder's Mark All as Read ----
    env.ui("contextmenu", selector='.fp-row .fp-name', text="Junk Email")
    env.ui("menu", label="Mark All as Read")
    g.check(wait(lambda: count("Junk", "\\Seen") == 10), "a folder's right-click > Mark All as Read")
finally:
    env.stop()
sys.exit(g.result())
