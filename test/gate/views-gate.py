"""Gate: the reading pane's place and what else Outlook's daily use has.
View > Reading Pane: Bottom (the list above it, one line a message; the
splitter between them dragged, its height kept), Off (the list alone) and
Right again, remembered when SG Mail starts again. Search Folders: Unread
Mail (unread mail of every folder but Junk), For Follow Up (flagged).
Categorize: a category (Thunderbird's tags) on a message is an IMAP keyword
on the server, shown in the list and the reading pane, and cleared again.
Rules > Always Move Messages From: the sender's messages go to the folder
chosen, those in the Inbox now and the next one delivered (a Thunderbird
filter on the account).

Mutants (test/mutants.json): views-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import smtplib
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message, SMTP_PORT, USERS  # noqa: E402

g = Gate("views")
env = Env("views", with_caldav=False)
ALICE = "Alice Example <alice@example.test>"


def wait(fn, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def listed(d):
    return sorted(x["subject"] for x in d["list"] if "id" in x)


def box(selector, index=0):
    return env.ui("rect", selector=selector, index=index)


def flags(subject, mailbox="INBOX"):
    for f, raw in env.mailbox(mailbox):
        if f"Subject: {subject}".encode() in raw:
            return f
    return None


def in_box(subject, mailbox):
    return any(f"Subject: {subject}".encode() in raw for f, raw in env.mailbox(mailbox))


def restart():
    env.m.quit()
    env.m = None
    env.tb.wait(30)
    env.xvfb.terminate()
    env.xvfb.wait(5)
    env.start_thunderbird()
    env.wait_ui("ping", lambda r: r["ready"], timeout=90)


def reading_pane(where):
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-reading-pane")
    env.ui("menu", label=where)


try:
    env.start_servers()
    now = time.time()
    for i, (frm, subj, seen, flagged) in enumerate([
            ("Bob Builder <bob@example.test>", "Site visit", False, False),
            ("Bob Builder <bob@example.test>", "Concrete order", True, True),
            ("Lee Gu <lee@example.test>", "Team photo", False, False),
            ("Megan Bowen <megan@example.test>", "Budget", True, False)]):
        env.append("INBOX", message(frm, ALICE, subj, text=f"{subj} text.", date=now - 600 * (i + 1)), seen=seen, flagged=flagged, date=now - 600 * (i + 1))
    env.append("Projects", message("Lee Gu <lee@example.test>", ALICE, "Kite plans", text="x"), flagged=True)
    env.append("Junk", message("Prize <win@spam.test>", ALICE, "You won", text="x"))
    env.make_profile()
    env.start_thunderbird()
    env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 4, timeout=90)
    # (the Focused Inbox off here: these are about the list itself)
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-focused-inbox")
    env.wait_ui("mail", lambda r: r["focused"] is None and len(listed(r)) == 4, timeout=20)
    env.ui("selectMessage", subject="Budget")
    env.wait_ui("mail", lambda r: r["reader"].get("subject") == "Budget", timeout=20)

    # ---- the reading pane ----
    lp, rp = box("#list-pane"), box("#reading-pane")
    g.check(rp["shown"] and rp["left"] >= lp["right"] - 3, "Reading Pane: Right (as it starts)", (lp, rp))
    reading_pane("Bottom")
    d = env.wait_ui("mail", lambda r: r["readingPane"] == "bottom", timeout=10)
    lp, rp = box("#list-pane"), box("#reading-pane")
    g.check(rp["shown"] and rp["top"] >= lp["bottom"] - 3 and rp["width"] > 900, "Reading Pane: Bottom puts it under the list, the window's width", (lp, rp))
    rows = sorted([box(".ml-msg"), box(".ml-msg", 1)], key=lambda r: r["top"])
    g.check(rows[0]["height"] <= 32 and rows[1]["top"] - rows[0]["top"] <= 32, "the list one line a message", rows)
    g.check(d["reader"].get("subject") == "Budget", "the message still shown in it", d["reader"].get("subject"))
    env.ui("drag", selector='#module-mail > .splitter[data-for="list-pane"]', dy=80)
    h1 = box("#list-pane")["height"]
    g.check(abs(h1 - (lp["height"] + 80)) < 6, "the splitter between them dragged: the list 80 px taller", (lp["height"], h1))
    reading_pane("Off")
    env.wait_ui("mail", lambda r: r["readingPane"] == "off", timeout=10)
    lp, rp = box("#list-pane"), box("#reading-pane")
    g.check(not rp["shown"] and lp["width"] > 1000, "Reading Pane: Off leaves the list alone, the whole width", (lp, rp))
    restart()
    d = env.wait_ui("mail", lambda r: r["readingPane"] == "off", timeout=30)
    g.check(True, "Off is remembered when SG Mail starts again")
    reading_pane("Bottom")
    env.wait_ui("mail", lambda r: r["readingPane"] == "bottom", timeout=10)
    g.check(abs(box("#list-pane")["height"] - h1) < 6, "and the list's height at the bottom", (box("#list-pane"), h1))
    reading_pane("Right")
    env.wait_ui("mail", lambda r: r["readingPane"] == "right", timeout=10)
    lp, rp = box("#list-pane"), box("#reading-pane")
    g.check(rp["shown"] and rp["left"] >= lp["right"] - 3 and (box(".ml-msg") or {}).get("height", 0) > 60, "Right again: beside the list, two lines a message", (lp, rp))

    # ---- Search Folders ----
    env.ui("click", selector='.fp-row[data-id="search:unread"]')
    d = env.wait_ui("mail", lambda r: r["folder"] and r["folder"]["id"] == "search:unread" and len(listed(r)) >= 2, timeout=40)
    d = env.wait_ui("mail", lambda r: len(listed(r)) >= 3, timeout=40)
    g.check(listed(d) == sorted(["Site visit", "Team photo", "Kite plans"]),
            "Search Folders > Unread Mail: the unread mail of every folder (Projects too, not Junk)", listed(d))
    g.check("You won" not in listed(d), "Junk Email's left out")
    env.ui("click", selector='.fp-row[data-id="search:flagged"]')
    d = env.wait_ui("mail", lambda r: r["folder"] and r["folder"]["id"] == "search:flagged" and len(listed(r)) >= 2, timeout=40)
    g.check(listed(d) == ["Concrete order", "Kite plans"], "For Follow Up: the flagged messages of every folder", listed(d))
    g.check(d["title"] == "For Follow Up - Search Folders - SG Mail", "titled as such", d["title"])

    # ---- Categorize ----
    env.ui("selectFolder", name="Inbox")
    env.wait_ui("mail", lambda r: len(listed(r)) == 4, timeout=30)
    env.ui("selectMessage", subject="Team photo")
    env.ui("click", selector='.ribbon-tab[data-tab="home"]')
    env.ui("click", selector="#rb-categorize")
    env.ui("menu", label="Important")
    g.check(wait(lambda: "$label1" in (flags("Team photo") or "")), "Categorize > Important: a keyword ($label1) on the server", flags("Team photo"))
    d = env.wait_ui("mail", lambda r: r["reader"].get("categories") == ["Important"], timeout=10)
    g.check(env.ui("count", selector=".ml-msg.selected .ml-cat") == 1, "shown in the list and the reading pane", d["reader"].get("categories"))
    env.ui("click", selector="#rb-categorize")
    env.ui("menu", label="Clear All Categories")
    g.check(wait(lambda: "$label1" not in (flags("Team photo") or "$label1")), "Clear All Categories takes it off", flags("Team photo"))

    # ---- Rules: always move messages from Bob ----
    env.ui("selectMessage", subject="Site visit")
    env.ui("click", selector="#rb-rules")
    env.ui("menu", label="Always Move Messages From: Bob Builder")
    env.wait_ui("count", lambda n: n > 0, selector=".modal .fp-row", timeout=10)
    env.ui("click", selector=".modal .fp-row .fp-name", text="Projects")
    env.ui("button", label="OK")
    g.check(wait(lambda: in_box("Site visit", "Projects") and in_box("Concrete order", "Projects")), "Bob's messages in the Inbox move to Projects")
    rule = env.chrome("""
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const s = MailServices.accounts.defaultAccount.incomingServer, l = s.getFilterList(null);
      const out = []; for (let i = 0; i < l.filterCount; i++) { const f = l.getFilterAt(i); out.push(f.filterName + "|" + f.enabled); }
      return out;""")
    g.check(rule == ["Always move messages from bob@example.test|true"], "a rule (Thunderbird filter) on the account", rule)
    s = smtplib.SMTP("127.0.0.1", SMTP_PORT)
    s.login("bob@example.test", USERS["bob@example.test"][1])
    s.sendmail("bob@example.test", ["alice@example.test"], message("Bob Builder <bob@example.test>", ALICE, "Delivery Monday", text="Truck at 8."))
    s.quit()
    env.ui("key", selector="#message-list", key="F9")
    g.check(wait(lambda: in_box("Delivery Monday", "Projects"), 90), "and Bob's next message goes there when it arrives")
    time.sleep(1)
    env.screenshot(os.path.join(env.dir, "views.png"))
finally:
    env.stop()
sys.exit(g.result())
