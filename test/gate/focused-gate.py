"""Gate: the Focused Inbox. Alice's Inbox shows two tabs, Focused and Other
(with the count of unread messages waiting in the other one). Bulk mail
(List-Unsubscribe, List-Id / Precedence: list, a no-reply sender) goes to
Other; people she knows stay Focused even when their mail looks like bulk
(a contact in her address book; someone she has written to: her Sent
folder on the IMAP server); other people's mail is Focused. "Move to
Focused" moves one message; "Always Move to Other" moves its sender's mail,
and the next message from them (delivered while SG Mail runs) arrives in
Other; each is remembered when SG Mail starts again. View > Show Focused
Inbox turns the tabs off (All / Unread again, every message listed).

Mutants (test/mutants.json): focused-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import smtplib
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message, SMTP_PORT, USERS  # noqa: E402

g = Gate("focused")
env = Env("focused", with_caldav=False)
ALICE = "Alice Example <alice@example.test>"

MAIL = [
    # (from, subject, headers, where it belongs)
    ("Shop <hello@shop.test>", "Weekly digest", [("List-Unsubscribe", "<mailto:unsub@shop.test>")], "other"),
    ("Store <noreply@store.test>", "Sale ends today", [], "other"),
    ("Project list <list@project.test>", "Release notes", [("List-Id", "<announce.project.test>"), ("Precedence", "list")], "other"),
    ("Lee Gu <lee@example.test>", "Lunch tomorrow?", [], "focused"),
    ("Carol Contact <carol@example.test>", "Club newsletter", [("List-Unsubscribe", "<mailto:leave@club.test>")], "focused"),
    ("Order Desk <orders@shop.test>", "Your order 1182", [("Auto-Submitted", "auto-generated")], "focused"),
]


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


def ready(timeout=90):
    return env.wait_ui("mail", lambda r: r["focused"] and len(r["focused"]["of"]) >= len(MAIL) and
                       all(r["focused"]["of"].get(s) for _, s, _, _ in MAIL), timeout=timeout)


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
    for i, (frm, subj, hdrs, _) in enumerate(MAIL):
        t = time.time() - 300 * (i + 1)
        env.append("INBOX", message(frm, ALICE, subj, text=f"{subj}.", date=t, extra_headers=hdrs), date=t)
    # she wrote to the order desk once (her Sent folder on the server)
    env.append("Sent", message(ALICE, "Order Desk <orders@shop.test>", "Question about my order", text="Where is it?"), seen=True)
    env.make_profile()
    env.start_thunderbird()
    env.wait_ui("ping", lambda r: r["ready"], timeout=60)
    # Carol is in her address book
    ok = env.chrome("""
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const dir = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
      const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(Ci.nsIAbCard);
      card.displayName = "Carol Contact"; card.primaryEmail = "carol@example.test";
      dir.addCard(card);
      return !!MailServices.ab.cardForEmailAddress("carol@example.test");""")
    g.check(ok, "(Carol is a contact in Alice's address book)")
    env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 1, timeout=90)
    # (SG Mail looks at the Sent folder by itself at start, and decides again
    # when a contact is added)
    d = ready()
    g.check(d["focused"]["tabs"][0] == "Focused" and d["focused"]["tabs"][1].startswith("Other"),
            "the Inbox has two tabs: Focused and Other", d["focused"]["tabs"])
    want = {s: w for _, s, _, w in MAIL}
    d = env.wait_ui("mail", lambda r: r["focused"]["of"] == want, timeout=40)
    g.check(True, "bulk mail is Other; people she knows (a contact, someone she wrote to) and other people are Focused")
    g.check(listed(d) == sorted(s for s, w in want.items() if w == "focused"), "the Focused tab lists the Focused messages", listed(d))
    g.check(d["focused"]["tabs"][1] == "Other3", "the Other tab shows its 3 unread messages waiting", d["focused"]["tabs"])

    env.ui("click", selector='.list-filter[data-focus="other"]')
    d = env.wait_ui("mail", lambda r: r["focused"]["tab"] == "other", timeout=10)
    g.check(listed(d) == sorted(s for s, w in want.items() if w == "other"), "the Other tab lists bulk mail", listed(d))

    # Move to Focused: this message
    env.ui("selectMessage", subject="Weekly digest")
    env.ui("contextmenu", selector=".ml-msg.selected")
    env.ui("menu", label="Move to Focused")
    d = env.wait_ui("mail", lambda r: "Weekly digest" not in listed(r), timeout=10)
    g.check(d["focused"]["of"]["Weekly digest"] == "focused", "Move to Focused moves it out of Other", d["focused"]["of"])
    env.ui("click", selector='.list-filter[data-focus="focused"]')
    d = env.wait_ui("mail", lambda r: r["focused"]["tab"] == "focused", timeout=10)
    g.check("Weekly digest" in listed(d), "into Focused", listed(d))
    restart()
    d = env.wait_ui("mail", lambda r: r["focused"] and len(r["focused"]["of"]) >= len(MAIL), timeout=90)
    d = wait(lambda: (lambda r: r if r["focused"]["of"].get("Weekly digest") == "focused" else None)(env.ui("mail")), 20) or d
    g.check(d["focused"]["of"].get("Weekly digest") == "focused", "after a restart: the message moved to Focused stays there", d["focused"]["of"])

    # Always Move to Other: Lee's mail, now and later
    env.ui("selectMessage", subject="Lunch tomorrow?")
    env.ui("contextmenu", selector=".ml-msg.selected")
    env.ui("menu", label="Always Move to Other")
    d = env.wait_ui("mail", lambda r: "Lunch tomorrow?" not in listed(r), timeout=10)
    g.check(d["focused"]["of"]["Lunch tomorrow?"] == "other", "Always Move to Other moves Lee's message to Other")
    s = smtplib.SMTP("127.0.0.1", SMTP_PORT)
    s.login("bob@example.test", USERS["bob@example.test"][1])
    s.sendmail("lee@example.test", ["alice@example.test"], message("Lee Gu <lee@example.test>", ALICE, "Coffee instead?", text="At three?"))
    s.quit()
    env.ui("key", selector="#message-list", key="F9")
    d = env.wait_ui("mail", lambda r: "Coffee instead?" in (r["focused"] or {}).get("of", {}), timeout=90)
    g.check(d["focused"]["of"]["Coffee instead?"] == "other" and "Coffee instead?" not in listed(d),
            "Lee's next message arrives in Other", d["focused"]["of"])

    # the rule remembered when SG Mail starts again
    restart()
    d = env.wait_ui("mail", lambda r: r["focused"] and "Coffee instead?" in r["focused"]["of"], timeout=90)
    g.check(d["focused"]["of"]["Lunch tomorrow?"] == "other" and d["focused"]["of"]["Coffee instead?"] == "other",
            "after a restart: Lee's rule kept", d["focused"]["of"])

    # View > Show Focused Inbox: off
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-focused-inbox")
    d = env.wait_ui("mail", lambda r: r["focused"] is None, timeout=10)
    tabs = env.ui("text", selector=".list-filter")
    g.check(tabs == ["All", "Unread"] and len(listed(d)) == len(MAIL) + 1, "Show Focused Inbox off: All / Unread, every message listed", (tabs, listed(d)))
    env.ui("click", selector="#rb-focused-inbox")
    env.wait_ui("mail", lambda r: r["focused"] is not None, timeout=10)
    time.sleep(1)
    env.screenshot(os.path.join(env.dir, "focused.png"))
finally:
    env.stop()
sys.exit(g.result())
