"""Gate: conversations, Clean Up and Ignore Conversation.
View > Show as Conversations groups the messages of a conversation (by the
Message-IDs they name: References / In-Reply-To) into one row with its count;
the reading pane shows the whole conversation, one's own reply from Sent
Items too, newest first; the row opens (the arrow, the Right key) to show its
messages and closes (Left); the choice is remembered. Clean Up Conversation
and Clean Up Folder move a message to Deleted Items only when a later reply
quotes all of it -- never an unread, flagged or categorized one, never one
whose text the reply leaves out. Ignore Conversation moves the conversation
to Deleted Items and so the next message in it, also after SG Mail starts
again; in Deleted Items, Stop Ignoring Conversation brings it back.

Mutants (test/mutants.json): conv-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import smtplib
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message, SMTP_PORT, USERS  # noqa: E402

g = Gate("conversations")
env = Env("conversations", with_caldav=False)
SHOTS = os.environ.get("SG_MAIL_SHOTS") or os.path.join(env.dir, "shots")
os.makedirs(SHOTS, exist_ok=True)
ALICE = "Alice Example <alice@example.test>"
MEGAN = "Megan Bowen <megan@example.test>"
LEE = "Lee Gu <lee@example.test>"
NESTOR = "Nestor Wilke <nestor@example.test>"


def wait(fn, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def refs(*ids):
    ids = [f"<{i}>" for i in ids]
    return [("References", " ".join(ids)), ("In-Reply-To", ids[-1])]


def subjects(box):
    out = []
    for f, raw in env.mailbox(box):
        for line in raw.decode("utf-8", "replace").split("\r\n"):
            if line.startswith("Subject: "):
                out.append(line[9:])
                break
    return sorted(out)


def has(box, subject, text=None):
    for f, raw in env.mailbox(box):
        r = raw.decode("utf-8", "replace")
        if f"\r\nSubject: {subject}\r\n" in "\r\n" + r and (text is None or text in r):
            return True
    return False


def convs(d):
    return {x["subject"]: x for x in d["list"] if "conv" in x}


def restart():
    env.m.quit()
    env.m = None
    env.tb.wait(30)
    env.xvfb.terminate()
    env.xvfb.wait(5)
    env.start_thunderbird()
    env.wait_ui("ping", lambda r: r["ready"], timeout=90)


try:
    env.start_servers()
    h = 3600
    now = time.time()
    seed = [
        # (box, from, to, subject, text, hours ago, msgid, refs, seen, flagged)
        ("INBOX", MEGAN, ALICE, "Budget plan", "Here is the first draft of the budget.", 9, "a1@x.test", [], True, False),
        ("Sent", ALICE, MEGAN, "RE: Budget plan", "Thanks, looks good.\n\n> Here is the first draft of the budget.", 8, "a2@x.test", ["a1@x.test"], True, False),
        ("INBOX", MEGAN, ALICE, "RE: Budget plan", "Updated numbers below.\n\n> Thanks, looks good.\n>\n>> Here is the first draft of the budget.", 7, "a3@x.test", ["a1@x.test", "a2@x.test"], False, False),
        ("INBOX", LEE, ALICE, "Kite day", "Shall we fly kites on Saturday?\nThe wind looks good.", 30, "k1@x.test", [], True, False),
        ("INBOX", LEE, ALICE, "RE: Kite day", "Saturday works for me.\n\n> Shall we fly kites on Saturday?\n> The wind looks good.", 29, "k2@x.test", ["k1@x.test"], True, False),
        ("INBOX", LEE, ALICE, "Lunch", "Lunch at noon at the corner cafe?", 50, "l1@x.test", [], True, False),
        ("INBOX", LEE, ALICE, "RE: Lunch", "Sure.", 49, "l2@x.test", ["l1@x.test"], True, False),
        ("INBOX", MEGAN, ALICE, "Venue", "The venue is booked for May.", 60, "v1@x.test", [], False, False),
        ("INBOX", MEGAN, ALICE, "RE: Venue", "Confirmed.\n\n> The venue is booked for May.", 59, "v2@x.test", ["v1@x.test"], True, False),
        ("INBOX", MEGAN, ALICE, "Invoice", "Invoice 77 is due Friday.", 70, "i1@x.test", [], True, True),
        ("INBOX", MEGAN, ALICE, "RE: Invoice", "Paid.\n\n> Invoice 77 is due Friday.", 69, "i2@x.test", ["i1@x.test"], True, False),
        ("INBOX", NESTOR, ALICE, "Party planning", "Who brings the cake?", 80, "p1@x.test", [], True, False),
        ("INBOX", NESTOR, ALICE, "RE: Party planning", "I can bake one.", 79, "p2@x.test", ["p1@x.test"], False, False),
        ("INBOX", LEE, ALICE, "Team photo", "The photo is on the share.", 2, "t1@x.test", [], False, False),
    ]
    for box, frm, to, subj, text, ago, mid, rf, seen, flagged in seed:
        t = now - ago * h
        env.append(box, message(frm, to, subj, text=text, date=t, msgid=f"<{mid}>", extra_headers=refs(*rf) if rf else ()), seen=seen, flagged=flagged, date=t)
    env.make_profile()
    env.start_thunderbird()
    env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 13, timeout=90)
    # (the Focused Inbox off: this is about the list itself)
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-focused-inbox")
    d = env.wait_ui("mail", lambda r: r["focused"] is None and len([x for x in r["list"] if "id" in x]) == 13, timeout=20)
    g.check(not convs(d) and not d["conversations"], "at first: one row a message (13), no conversations", len(d["list"]))

    # ---- Show as Conversations ----
    env.ui("click", selector="#rb-conversations")
    d = env.wait_ui("mail", lambda r: r["conversations"] and len(convs(r)) >= 6, timeout=30)
    c = convs(d)
    g.check(sorted(c) == ["Budget plan", "Invoice", "Kite day", "Lunch", "Party planning", "Venue"],
            "View > Show as Conversations: each conversation one row", sorted(c))
    g.check(c["Budget plan"]["count"] == 2 and c["Budget plan"]["unread"] == 1, "its count (2 here) and its unread", c["Budget plan"])
    singles = [x["subject"] for x in d["list"] if "id" in x]
    g.check(singles == ["Team photo"], "a message alone is a message's row; the others are in their conversations' rows", singles)
    g.check(env.ui("attr", selector=".ribbon-group .rb#rb-conversations", name="class").find("toggled") >= 0, "the button shows it is on")

    env.ui("selectConversation", subject="Budget plan")
    d = env.wait_ui("mail", lambda r: len(r["reader"].get("conversation") or []) == 3 and "Updated numbers" in r["reader"]["conversation"][0]["text"], timeout=40)
    cv = d["reader"]["conversation"]
    g.check([x["from"] for x in cv] == ["Megan Bowen", "Alice Example", "Megan Bowen"],
            "the reading pane shows the conversation, newest first: one's own reply from Sent Items too", [x["from"] for x in cv])
    g.check(cv[1]["folder"] == "Sent Items" and cv[0]["folder"] == "", "the reply marked as kept in Sent Items", [x["folder"] for x in cv])
    g.check(cv[0]["expanded"] and not cv[2]["expanded"], "the newest (and unread) one open, the others closed", [x["expanded"] for x in cv])
    g.check(d["reader"]["subject"] == "Budget plan", "titled by the conversation's subject", d["reader"]["subject"])
    time.sleep(1)
    env.screenshot(os.path.join(SHOTS, "sg-mail-conversations-light.png"))
    g.check(wait(lambda: "\\Seen" in next((f for f, raw in env.mailbox("INBOX") if b"a3@x.test" in raw), "")), "the unread message read once shown")

    # the row opens and closes
    env.ui("click", selector=".ml-conv.selected .ml-twisty")
    d = env.wait_ui("mail", lambda r: convs(r)["Budget plan"]["expanded"], timeout=10)
    kids = [x for x in d["list"] if x.get("child")]
    g.check(len(kids) == 2 and all(x["subject"] == "Budget plan" for x in kids), "opened: its two messages under it", kids)
    env.ui("click", selector=".ml-msg.child", index=1)
    d = env.wait_ui("mail", lambda r: not r["reader"].get("conversation") and r["reader"].get("text"), timeout=20)
    g.check("first draft" in d["reader"]["text"] and "Updated" not in d["reader"]["text"], "a message of it chosen: that message alone", d["reader"]["text"][:80])
    env.ui("key", selector="#message-list", key="ArrowLeft")
    d = env.wait_ui("mail", lambda r: not convs(r)["Budget plan"]["expanded"], timeout=10)
    g.check(convs(d)["Budget plan"]["selected"], "Left closes it, the conversation chosen")
    env.ui("key", selector="#message-list", key="ArrowRight")
    d = env.wait_ui("mail", lambda r: convs(r)["Budget plan"]["expanded"], timeout=10)
    g.check(True, "Right opens it again")
    env.ui("key", selector="#message-list", key="ArrowLeft")

    restart()
    d = env.wait_ui("mail", lambda r: r["conversations"] and len(convs(r)) >= 6, timeout=60)
    g.check(d["focused"] is None, "Show as Conversations is remembered when SG Mail starts again")

    # ---- Clean Up ----
    env.ui("selectConversation", subject="Kite day")
    env.ui("click", selector='.ribbon-tab[data-tab="home"]')
    env.ui("click", selector="#rb-clean-up")
    env.ui("menu", label="Clean Up Conversation")
    g.check(wait(lambda: has("Trash", "Kite day") and not has("INBOX", "Kite day")),
            "Clean Up Conversation: the message the reply quotes whole goes to Deleted Items", subjects("Trash"))
    g.check(has("INBOX", "RE: Kite day"), "the reply stays")
    env.ui("click", selector="#rb-clean-up")
    env.ui("menu", label="Clean Up Folder")
    env.ui("button", label="Clean Up Folder")
    g.check(wait(lambda: has("Trash", "Budget plan")), "Clean Up Folder: the first budget message (quoted whole in the last reply) too", subjects("Trash"))
    time.sleep(2)
    inbox = subjects("INBOX")
    g.check(has("INBOX", "Lunch") and has("INBOX", "RE: Lunch"), "a message the reply does not quote stays", inbox)
    g.check(has("INBOX", "Venue"), "an unread message stays", inbox)
    g.check(has("INBOX", "Invoice"), "a flagged message stays", inbox)
    g.check(has("INBOX", "RE: Budget plan") and has("Sent", "RE: Budget plan"), "the newest reply stays, and one's own in Sent Items", inbox)
    g.check(subjects("Trash") == ["Budget plan", "Kite day"], "nothing else moved", subjects("Trash"))

    # ---- Ignore Conversation ----
    env.ui("selectConversation", subject="Party planning")
    env.ui("click", selector="#rb-ignore")
    env.ui("button", label="Ignore Conversation")
    g.check(wait(lambda: has("Trash", "Party planning") and has("Trash", "RE: Party planning") and not has("INBOX", "Party planning")),
            "Ignore: the conversation goes to Deleted Items", subjects("Trash"))
    restart()
    s = smtplib.SMTP("127.0.0.1", SMTP_PORT)
    s.login("bob@example.test", USERS["bob@example.test"][1])
    s.sendmail("nestor@example.test", ["alice@example.test"], message(NESTOR, ALICE, "RE: Party planning", text="And balloons?\n\n> I can bake one.",
                                                                       msgid="<p3@x.test>", extra_headers=refs("p1@x.test", "p2@x.test")))
    s.sendmail("lee@example.test", ["alice@example.test"], message(LEE, ALICE, "Parking", text="Where do we park?", msgid="<z1@x.test>"))
    s.quit()
    env.wait_ui("mail", lambda r: r["list"] is not None, timeout=30)
    env.ui("key", selector="#message-list", key="F9")
    g.check(wait(lambda: has("INBOX", "Parking"), 90), "(new mail arrived)")
    g.check(wait(lambda: any(b"p3@x.test" in raw for f, raw in env.mailbox("Trash")) and not any(b"p3@x.test" in raw for f, raw in env.mailbox("INBOX")), 60),
            "the next message in an ignored conversation goes to Deleted Items too (after a restart)", subjects("INBOX"))
    g.check(has("INBOX", "Parking"), "other new mail stays")

    env.ui("selectFolder", name="Deleted Items")
    d = env.wait_ui("mail", lambda r: r["folder"]["name"] == "Deleted Items" and len([x for x in r["list"] if "id" in x or "conv" in x]) >= 2, timeout=40)
    env.ui("selectConversation", subject="Party planning")
    env.ui("contextmenu", selector=".ml-conv.selected")
    env.ui("menu", label="Stop Ignoring Conversation")
    g.check(wait(lambda: sum(1 for f, raw in env.mailbox("INBOX") if b"Party planning" in raw) == 3),
            "in Deleted Items: Stop Ignoring Conversation brings it back to the Inbox", subjects("INBOX"))

    # ---- off again ----
    env.ui("selectFolder", name="Inbox")
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-conversations")
    d = env.wait_ui("mail", lambda r: not r["conversations"] and not convs(r) and len([x for x in r["list"] if "id" in x]) >= 10, timeout=30)
    g.check(True, "Show as Conversations off: one row a message again")
finally:
    env.stop()
sys.exit(g.result())
