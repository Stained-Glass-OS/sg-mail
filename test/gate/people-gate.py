"""Gate: People in SG Mail's own window (Ctrl+3, the navigation bar), not
Thunderbird's address book: the address books on the side, the contacts
list and the contact card. New Contact (name, e-mail, phone, company, job
title) is saved in Thunderbird's address book as a vCard; Edit changes it
and keeps what SG Mail does not show (a fax number, Thunderbird's own
fields); search finds people by company; a New Contact Group with two
members is a Thunderbird mailing list; a member removed from the group's
card; Email and Meeting from a card open the message and meeting windows
addressed to them; Delete removes a contact.

Mutants (test/mutants.json): people-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate  # noqa: E402

g = Gate("people")
env = Env("people", with_caldav=False)

AB = """const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const dir = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
const vcard = email => { const c = MailServices.ab.cardForEmailAddress(email); return c ? c.getProperty("_vCard", "") : null; };
"""


def card_vcard(email):
    return env.chrome(AB + "return vcard(args);", email)


def new_contact(fields):
    env.wait_ui("count", lambda n: n > 0, selector=".modal #ce-first", timeout=15)
    for k, v in fields.items():
        env.ui("type", selector=f".modal #ce-{k}", value=v)
    env.ui("button", label="Save & Close")


def people(cond, timeout=30):
    return env.wait_ui("people", cond, timeout=timeout)


try:
    env.start_servers()
    env.make_profile()
    env.start_thunderbird()
    env.wait_ui("ping", lambda r: r["ready"], timeout=60)
    # a contact Thunderbird already has, with fields SG Mail does not edit
    env.chrome(AB + """
      const { VCardUtils } = ChromeUtils.importESModule("resource:///modules/VCardUtils.sys.mjs");
      const card = VCardUtils.vCardToAbCard("BEGIN:VCARD\\r\\nVERSION:4.0\\r\\nFN:Nestor Wilke\\r\\nN:Wilke;Nestor;;;\\r\\nEMAIL;PREF=1:nestor@example.test\\r\\n" +
        "TEL;TYPE=fax:+1 555 0199\\r\\nORG:Fabrikam\\r\\nX-SG-GATE:kept\\r\\nURL:https://fabrikam.example\\r\\nEND:VCARD\\r\\n");
      dir.addCard(card); return true;""")
    g.check(card_vcard("nestor@example.test") is not None, "(Nestor is in Thunderbird's address book)")

    env.ui("key", selector="#message-list", key="3", ctrl=True)
    try:
        d = people(lambda r: "Personal Address Book" in r["books"] and r["title"] == "People - SG Mail")
    except TimeoutError as e:
        d = None
        g.check(False, "Ctrl+3: People, in SG Mail's window", str(e)[:300])
        raise SystemExit(g.result())
    g.check(True, "Ctrl+3: People, in SG Mail's window")
    own = env.chrome("""const tm = Services.wm.getMostRecentWindow("mail:3pane").document.getElementById("tabmail");
      return tm.currentTabInfo.browser?.currentURI.spec || tm.currentTabInfo.mode.name;""")
    g.check("/ui/main.html" in own, "not Thunderbird's address book tab", own)
    g.check(d["list"] == ["Nestor Wilke"], "the address book's contacts are listed", d["list"])

    # New Contact
    env.ui("click", selector="#rb-new-contact")
    new_contact({"first": "Megan", "last": "Bowen", "email": "megan@example.test", "cell": "+1 555 0100", "company": "Contoso", "title": "Marketing Manager"})
    d = people(lambda r: "Megan Bowen" in r["list"])
    v = card_vcard("megan@example.test") or ""
    g.check("FN:Megan Bowen" in v and "N:Bowen;Megan" in v and "ORG:Contoso" in v and "TITLE:Marketing Manager" in v and "+1 555 0100" in v,
            "New Contact is saved in Thunderbird's address book (a vCard: name, e-mail, mobile, company, job title)", v)
    tb = env.chrome(AB + "const c = MailServices.ab.cardForEmailAddress('megan@example.test'); return c && c.displayName;")
    g.check(tb == "Megan Bowen", "Thunderbird sees her by name", tb)
    d = people(lambda r: r["card"] and r["card"]["name"] == "Megan Bowen")
    g.check("Marketing Manager · Contoso" in d["card"]["text"] and "+1 555 0100" in d["card"]["text"], "her card shows title, company and phone", d["card"]["text"])
    env.ui("click", selector="#rb-new-contact")
    new_contact({"first": "Lee", "last": "Gu", "email": "lee@example.test"})
    d = people(lambda r: "Lee Gu" in r["list"])
    g.check(d["list"] == ["Lee Gu", "Megan Bowen", "Nestor Wilke"], "listed by name", d["list"])

    # Edit: keeps what People does not show
    env.ui("dblclick", selector=".pp-row", text="Nestor Wilke")
    env.wait_ui("count", lambda n: n > 0, selector=".modal #ce-company", timeout=15)
    env.ui("type", selector=".modal #ce-company", value="Fabrikam Ltd")
    env.ui("button", label="Save & Close")
    v = wait = None
    for _ in range(40):
        v = card_vcard("nestor@example.test") or ""
        if "Fabrikam Ltd" in v:
            break
        time.sleep(0.5)
    g.check("ORG:Fabrikam Ltd" in v, "Edit saves the change", v)
    g.check("X-SG-GATE:kept" in v and "TEL;TYPE=fax:+1 555 0199" in v and "URL:https://fabrikam.example" in v,
            "and keeps what People does not show (fax, web page, Thunderbird's own fields)", v)

    # search
    env.ui("type", selector="#pp-search", value="contoso")
    d = people(lambda r: r["list"] == ["Megan Bowen"])
    g.check(True, "Search People finds her by company")
    env.ui("type", selector="#pp-search", value="")
    people(lambda r: len(r["list"]) == 3)

    # a contact group
    env.ui("click", selector="#rb-new-group")
    env.wait_ui("count", lambda n: n > 0, selector=".modal #ge-name", timeout=15)
    env.ui("type", selector=".modal #ge-name", value="Marketing team")
    ids = {c["display"]: c["id"] for c in env.ui("people")["contacts"]}
    for who in ("Megan Bowen", "Lee Gu"):
        env.ui("click", selector=f'.modal #ge-pick input[data-id="{ids[who]}"]')
    env.ui("button", label="Save & Close")
    d = people(lambda r: any(x["name"] == "Marketing team" for x in r["groups"]))
    members = lambda: env.chrome(AB + """const l = dir.childNodes.find(n => n.dirName == "Marketing team");
      return l ? l.childCards.map(c => c.primaryEmail).sort() : null;""")
    g.check(members() == ["lee@example.test", "megan@example.test"], "New Contact Group is a Thunderbird mailing list with its two members", members())
    d = people(lambda r: r["card"] and r["card"]["name"] == "Marketing team")
    g.check("Contact group · 2 members" in d["card"]["text"], "its card lists the members", d["card"]["text"])
    env.ui("click", selector=f'#pp-members .pp-member[data-id="{ids["Lee Gu"]}"] .pp-remove')
    ok = None
    for _ in range(30):
        ok = members()
        if ok == ["megan@example.test"]:
            break
        time.sleep(0.5)
    g.check(ok == ["megan@example.test"], "a member removed from the group's card", ok)

    # Email the group, a meeting with Megan
    env.ui("click", selector=".pp-actions .rb", text="Email")
    c = env.wait_ui("dump", lambda r: True, target="compose", timeout=30)
    g.check("megan@example.test" in c["to"] and "lee@" not in c["to"], "Email from the group's card: a message to its members", c["to"])
    env.ui("close", target="compose")
    time.sleep(1)
    env.ui("click", selector=".pp-row", text="Megan Bowen")
    people(lambda r: r["card"] and r["card"]["name"] == "Megan Bowen")
    env.ui("click", selector=".pp-actions .rb", text="Meeting")
    w = env.wait_ui("dump", lambda r: True, target="event", timeout=30)
    g.check(w["meeting"] and "megan@example.test" in w["attendees"], "Meeting from her card: a meeting request inviting her", w)
    env.ui("close", target="event")
    time.sleep(1)

    # Delete
    env.ui("click", selector=".pp-row", text="Lee Gu")
    env.ui("key", selector="#pp-list", key="Delete")
    env.ui("button", label="Delete")
    d = people(lambda r: "Lee Gu" not in r["list"])
    g.check(card_vcard("lee@example.test") is None, "Delete removes the contact from Thunderbird's address book")
    time.sleep(1)
    env.ui("click", selector=".pp-row", text="Megan Bowen")
    time.sleep(1)
    env.screenshot(os.path.join(env.dir, "people.png"))
finally:
    env.stop()
sys.exit(g.result())
