"""Gate: what Outlook shows beside one's own calendar and mailbox, through
DavMail (the stand-in before Radicale and Dovecot; the helper and user unit
as installed): colleagues' calendars in a calendar group of their own
("Team: ..."), side by side, and a shared mailbox as a folder tree of its own.

Megan (megan@outlook.com, a Microsoft account connected for calendar and
contacts) may read Bob's and Carol's calendars (Radicale's rights) and open
the Front Desk mailbox (the stand-in's IMAP: "megan/frontdesk" with her own
sign-in, as DavMail takes it). Checked: the organisation's directory book
(DavMail's LDAP gateway: Thunderbird's LDAP address book on the gateway's
port, bound as Megan, with the gateway's password); New Team Calendar Group
opens Bob's and Carol's calendars in "Team: Bob" and says Dave's is not
shared; the group's box hides and shows both; Day side by side: a column
each, Bob's appointment in his; the group removed, its calendars kept (in
Shared Calendars); Add Shared Mailbox: the gateway gets IMAP, Front Desk's
Inbox is in SG Mail's folder pane with its message; Megan's account removed:
the shared mailbox, the colleagues' calendars and the directory go with it.

Mutants (test/mutants.json): davmail-shared-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import datetime
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import CALDAV_PORT, IMAP_PORT, SMTP_PORT, SRC, Env, Gate, message  # noqa: E402

RIGHTS = r"""
[owner]
user: .+
collection: {user}(/.*)?
permissions: RrWw
[root]
user: .+
collection:
permissions: R
[megan-reads-bob]
user: megan@outlook\.com
collection: bob@example\.test(/.*)?
permissions: Rr
[megan-reads-carol]
user: megan@outlook\.com
collection: carol@autoconf\.test(/.*)?
permissions: Rr
"""
g = Gate("davmail-shared")
env = Env("davmail-shared", radicale_rights=RIGHTS)
MEGAN = "megan@outlook.com"
NAME = "megan-at-outlook.com"
FRONT = "frontdesk@outlook.com"


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


def ics(uid, summary, start, end):
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SG gate//EN\r\nBEGIN:VEVENT\r\n"
            f"UID:{uid}\r\nDTSTAMP:20261001T080000Z\r\nDTSTART:{start}\r\nDTEND:{end}\r\nSUMMARY:{summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")


def cal(cond, timeout=60):
    return env.wait_ui("calendar", cond, timeout=timeout)


try:
    env.start_servers()
    env.make_davmail_collections(MEGAN)
    for who, path in (("bob@example.test", "/bob@example.test/calendar/"), ("carol@autoconf.test", "/carol@autoconf.test/calendar/")):
        env.make_calendar(who, path, "Calendar")
    env.dav("PUT", "/bob@example.test/calendar/b1.ics", ics("b1@example.test", "Bob at the dentist", "20261013T150000Z", "20261013T160000Z"),
            user="bob@example.test", headers={"Content-Type": "text/calendar"})
    env.dav("PUT", "/carol@autoconf.test/calendar/c1.ics", ics("c1@example.test", "Carol presents", "20261013T170000Z", "20261013T180000Z"),
            user="carol@autoconf.test", headers={"Content-Type": "text/calendar"})
    env.append("INBOX", message("Bob Builder <bob@example.test>", f"Front Desk <{FRONT}>", "Parcel at reception", text="A parcel came."), user=FRONT)
    env.make_profile()
    dm_env = {"SG_DAVMAIL": os.path.join(SRC, "test/servers/davmail_standin.py"),
              "SG_STANDIN_UPSTREAM": f"http://127.0.0.1:{CALDAV_PORT}", "SG_STANDIN_UPSTREAM_AUTH": f"{MEGAN}:megan-secret",
              "SG_STANDIN_IMAP": f"127.0.0.1:{IMAP_PORT}", "SG_STANDIN_SMTP": f"127.0.0.1:{SMTP_PORT}",
              "SG_STANDIN_MAILBOXES": '{"frontdesk@outlook.com": "frontdesk-secret"}'}
    env.start_user_manager(dm_env)
    env.start_thunderbird(mutant_env=dm_env)
    env.wait_ui("ping", lambda r: r["ready"], timeout=60)
    env.ui("click", selector="#nav-calendar")

    # ---- Megan's Microsoft account, its calendar and contacts through DavMail ----------------
    env.megan = env.chrome("""
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const server = MailServices.accounts.createIncomingServer(args.user, "127.0.0.1", "imap");
      server.port = args.port; server.socketType = 0; server.authMethod = 3; server.setBoolValue("login_at_startup", false);
      const id = MailServices.accounts.createIdentity(); id.email = args.user; id.fullName = "Megan Bowen";
      const account = MailServices.accounts.createAccount(); account.addIdentity(id); account.incomingServer = server;
      return account.key;""", {"user": MEGAN, "port": IMAP_PORT})
    env.wait_ui("text", lambda t: t == ["Calendar and contacts (Microsoft)"], selector=".modal .modal-title", timeout=30)
    env.ui("button", label="Add calendar and contacts")
    wait(lambda: env.x_windows("DavMail stand-in sign-in"), 60)
    open(os.path.join(gw_dir(), "signin.approve"), "w").close()
    cal(lambda r: any(c["name"] == f"Calendar ({MEGAN})" for c in r["calendars"]))

    # ---- the organisation's directory: DavMail's LDAP gateway ---------------------------------
    props = open(os.path.join(gw_dir(), "davmail.properties")).read()
    ldap = int((re.search(r"^davmail\.ldapPort=(\d+)$", props, re.M) or [0, 0])[1])
    d = env.chrome("""const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const dir = MailServices.ab.directories.find(d => d.dirName == args.name);
      if (!dir) return null;
      const l = dir.QueryInterface(Ci.nsIAbLDAPDirectory);
      const logins = await Services.logins.searchLoginsAsync({ origin: "ldap://127.0.0.1:" + args.port });
      return { url: l.lDAPURL.spec, dn: l.authDn, password: logins.some(x => x.httpRealm == l.lDAPURL.spec && x.password) };""",
                   {"name": f"Directory ({MEGAN})", "port": ldap})
    g.check(ldap > 0 and d == {"url": f"ldap://127.0.0.1:{ldap}/ou=people??sub?(objectclass=*)", "dn": MEGAN, "password": True},
            "the organisation's directory: an LDAP address book on the gateway's LDAP port, bound as Megan with the gateway's password", (ldap, d))
    g.check("davmail.bindAddress=127.0.0.1" in props and f"davmail.ldapPort={ldap}" in props, "DavMail's LDAP on the loopback only", props[-500:])

    # ---- a Team group: colleagues' calendars ----------------------------------------------------
    env.ui("click", selector="#rb-open-calendar")
    env.ui("menu", label="New Team Calendar Group…")
    env.wait_ui("count", lambda n: n == 1, selector=".modal #team-people", timeout=10)
    env.ui("type", selector=".modal #team-name", value="Team: Bob")
    env.ui("type", selector=".modal #team-people", value="bob@example.test\ncarol@autoconf.test\ndave@example.test\nlists@example.test")
    env.ui("button", label="Open Calendars")
    res = env.wait_ui("text", lambda t: bool(t), selector="#team-result", timeout=120)
    g.check(res == ['2 calendars opened in "Team: Bob".'], "New Team Calendar Group: Bob's and Carol's calendars opened", res)
    body = env.ui("text", selector=".modal .modal-body")
    g.check(any("dave@example.test: dave@example.test has not shared a calendar with you" in b for b in body),
            "and it says Dave has not shared his (Microsoft's \"not found\", through DavMail)", body)
    g.check(any("lists@example.test is a group or a list, whose calendar DavMail cannot open" in b for b in body),
            "and that a group's (Microsoft 365 group, list) calendar cannot be opened through DavMail", body)
    env.ui("button", label="OK")
    r = cal(lambda r: len([c for c in r["calendars"] if c["group"] == "Team: Bob"]) == 2)
    team = [c for c in r["calendars"] if c["group"] == "Team: Bob"]
    g.check(all(c["shared"] and c["readOnly"] for c in team), "both in the group, read-only (as they are shared)", team)
    g.check("Team: Bob" in r["groups"], "the side pane shows the calendar group", r["groups"])
    urls = env.chrome("""const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
      return cal.manager.getCalendars().filter(c => c.getProperty("sgmail.group")).map(c => c.uri.spec).sort();""")
    port = int(re.search(r"davmail\.caldavPort=(\d+)", props).group(1))
    g.check(urls == [f"http://127.0.0.1:{port}/users/bob@example.test/calendar/", f"http://127.0.0.1:{port}/users/carol@autoconf.test/calendar/"],
            "through the account's gateway (/users/THEIR-ADDRESS/calendar/)", urls)

    # the group's box: all its calendars at once
    env.ui("click", selector='.cal-group[data-group="g:Team: Bob"]')
    r = cal(lambda r: all(not c["shown"] for c in r["calendars"] if c["group"] == "Team: Bob"), 20)
    g.check(True, "the group's box hides both")
    env.ui("click", selector='.cal-group[data-group="g:Team: Bob"]')
    cal(lambda r: all(c["shown"] for c in r["calendars"] if c["group"] == "Team: Bob"), 20)

    # ---- side by side ----------------------------------------------------------------------------
    env.ui("calendarDate", y=2026, m=10, d=13)
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-side-by-side")
    r = cal(lambda r: r["view"] == "day" and len(r["sideBySide"]) == 4 and any(e["title"] == "Bob at the dentist" for e in r["events"]), 60)
    g.check(True, "Side by Side: Day, a column for each calendar shown", r["sideBySide"])
    bob_id = env.chrome("""const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
      return cal.manager.getCalendars().find(c => c.uri.spec.includes("/bob@example.test/")).id;""")
    in_bob = env.ui("count", selector=f'#module-calendar .tg-col[data-calendar="{bob_id}"] .ev[title^="Bob at the dentist"]')
    elsewhere = env.ui("count", selector=f'#module-calendar .tg-col:not([data-calendar="{bob_id}"]) .ev[title^="Bob at the dentist"]')
    g.check(in_bob == 1 and elsewhere == 0, "Bob's appointment in Bob's column only", (in_bob, elsewhere))
    env.ui("click", selector="#rb-side-by-side")
    r = cal(lambda r: not r["sideBySide"], 20)
    g.check(True, "and back to one column (overlay)")

    # ---- the group removed, its calendars kept ---------------------------------------------------
    env.ui("contextmenu", selector='.cal-group[data-group="g:Team: Bob"]')
    env.ui("menu", label="Remove Group (keep its calendars)")
    r = cal(lambda r: "Team: Bob" not in r["groups"] and len([c for c in r["calendars"] if c["shared"]]) == 2, 20)
    g.check("Shared Calendars" in r["groups"], "Remove Group: its calendars stay, in Shared Calendars", r["groups"])

    # ---- a shared mailbox -----------------------------------------------------------------------
    env.ui("click", selector="#nav-mail")
    env.ui("click", selector="#rt-file")
    env.ui("menu", label="Add Shared Mailbox…")
    env.wait_ui("count", lambda n: n == 1, selector=".modal #sm-mailbox", timeout=10)
    # one Megan may not open: said so, nothing added
    env.ui("type", selector=".modal #sm-mailbox", value="dave@example.test")
    env.ui("button", label="Add")
    err = env.wait_ui("text", lambda t: t and any("could not be opened" in x for x in t), selector=".modal .modal-body", timeout=60)
    g.check(any("dave@example.test could not be opened: you have no access to it" in x for x in err), "a mailbox Megan may not open: SG Mail says so", err)
    env.ui("button", label="OK")
    n = env.chrome("""const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      return MailServices.accounts.accounts.filter(a => (a.incomingServer?.username || "").includes("/")).length;""")
    g.check(n == 0, "and adds no account for it", n)
    env.ui("click", selector="#rt-file")
    env.ui("menu", label="Add Shared Mailbox…")
    env.wait_ui("count", lambda n: n == 1, selector=".modal #sm-mailbox", timeout=10)
    env.ui("type", selector=".modal #sm-mailbox", value=FRONT)
    env.ui("button", label="Add")
    acct = wait(lambda: env.chrome("""const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const a = MailServices.accounts.accounts.find(a => a.incomingServer?.username == args);
      return a && { host: a.incomingServer.hostname ?? a.incomingServer.hostName, port: a.incomingServer.port, name: a.incomingServer.prettyName };""",
                                     f"{MEGAN}/{FRONT}"), 60)
    props = open(os.path.join(gw_dir(), "davmail.properties")).read()
    imap = int((re.search(r"^davmail\.imapPort=(\d+)$", props, re.M) or [0, 0])[1])
    g.check(imap > 0 and acct == {"host": "127.0.0.1", "port": imap, "name": FRONT},
            "Add Shared Mailbox: the gateway gets IMAP; an account \"OWN/MAILBOX\" on it", (imap, acct))
    d = env.wait_ui("mail", lambda r: any(t.startswith("# " + FRONT) for t in r["tree"]), timeout=60)
    g.check(True, "Front Desk's folders: a tree of their own in the folder pane", [t for t in d["tree"] if t.startswith("#")])
    env.ui("selectFolder", account=FRONT, name="Inbox")
    d = env.wait_ui("mail", lambda r: any(x.get("subject") == "Parcel at reception" for x in r["list"]), timeout=90)
    g.check(True, "and its Inbox, with its mail")
    status = env.ui("microsoft")
    g.check(not any(a["email"] == FRONT for a in status["accounts"]) and len(status["status"]) == 1,
            "the shared mailbox is not taken for an account of its own to sign in", status)

    # ---- Megan's account removed: what came through it goes too ------------------------------------
    env.chrome("""const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      MailServices.accounts.removeAccount(MailServices.accounts.getAccount(args), true); return true;""", env.megan)
    left = wait(lambda: (lambda x: x if not x["accounts"] and not x["calendars"] and not x["books"] else None)(env.chrome("""
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
      return { accounts: MailServices.accounts.accounts.map(a => a.incomingServer?.username).filter(u => u && u.includes("outlook.com")),
               calendars: cal.manager.getCalendars().filter(c => c.uri.spec.startsWith("http://127.0.0.1:" + args + "/")).map(c => c.name),
               books: MailServices.ab.directories.filter(d => d.dirName.includes("megan")).map(d => d.dirName) };""", port)), 60)
    g.check(left is not None, "Megan's account removed: the shared mailbox, the colleagues' calendars and the directory go with it", left)
    env.screenshot(os.path.join(env.dir, "davmail-shared.png"))
finally:
    env.stop()
sys.exit(g.result())
