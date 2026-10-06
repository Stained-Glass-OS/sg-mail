"""Gate: a Microsoft account set up in SG Mail's own account step, through
DavMail for everything -- mail (IMAP, SMTP), calendar (CalDAV), contacts
(CardDAV) -- with one DavMail sign-in. DavMail is the stand-in
(test/servers/davmail_standin.py: the same token check, then Dovecot, the
SMTP server and Radicale behind it); the helper and user unit as installed,
under a systemd user manager of the gate's own.

The first start, no account: SG Mail's "Add an account" in front. A
Microsoft address (megan@outlook.com): "Microsoft account", Connect, the
sign-in (DavMail's window), then Thunderbird's IMAP account on the gateway
(127.0.0.1), its outgoing server, its calendar and address book. Megan's
mail on the "server" is in SG Mail's list; a message sent goes out through
the gateway (and a copy is in Sent Items, kept by Exchange -- Thunderbird
keeps none of its own); the calendar and contacts answer. Any other address
(carol@autoconf.test): Thunderbird's own account setup, the address already
typed in. The account removed: its mail account, outgoing server,
passwords, calendar, address book and gateway gone.

Mutants (test/mutants.json): davmail-mail-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import CALDAV_PORT, IMAP_PORT, SMTP_PORT, SRC, Env, Gate, message  # noqa: E402

g = Gate("davmail-mail")
env = Env("davmail-mail", accounts=())
MEGAN = "megan@outlook.com"
NAME = "megan-at-outlook.com"
UNIT = f"sg-mail-davmail@{NAME}.service"


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


def requests_log():
    try:
        return open(os.path.join(gw_dir(), "requests.log")).read()
    except OSError:
        return ""


def modal_title(timeout=30, want=None):
    try:
        t = env.wait_ui("text", lambda r: bool(r) and (want is None or r[-1] == want), selector=".modal .modal-title", timeout=timeout)
        return t[-1]
    except TimeoutError:
        return None


ACCOUNT = """const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const acct = MailServices.accounts.accounts.find(a => a.defaultIdentity?.email == args);
"""

try:
    env.start_servers()
    env.make_davmail_collections(MEGAN)
    env.append("INBOX", message("Nestor Wilke <nestor@contoso.test>", f"Megan Bowen <{MEGAN}>", "Budget for Q4", text="Numbers attached."), user=MEGAN)
    env.make_profile()
    dm_env = {"SG_DAVMAIL": os.path.join(SRC, "test/servers/davmail_standin.py"),
              "SG_STANDIN_UPSTREAM": f"http://127.0.0.1:{CALDAV_PORT}", "SG_STANDIN_UPSTREAM_AUTH": f"{MEGAN}:megan-secret",
              "SG_STANDIN_IMAP": f"127.0.0.1:{IMAP_PORT}", "SG_STANDIN_SMTP": f"127.0.0.1:{SMTP_PORT}"}
    env.start_user_manager(dm_env)
    env.start_thunderbird(mutant_env=dm_env)

    # ---- the first start: SG Mail's own account step, in front ------------------------------
    title = modal_title(60)
    g.check(title == "Add an account", "the first start, no account: SG Mail's \"Add an account\" in front", title)
    env.ui("type", selector=".modal #aa-name", value="Megan Bowen")
    env.ui("type", selector=".modal #aa-email", value=MEGAN)
    env.ui("button", label="Next")
    title = modal_title(30, "Microsoft account")
    g.check(bool(title), "a Microsoft address: SG Mail offers its mail, calendar and contacts through DavMail", title)
    body = env.ui("text", selector=".modal .modal-body")
    g.check(any("mail, calendar and contacts" in b and "one sign-in" in b for b in body), "with one Microsoft sign-in, in DavMail's window", body)
    env.ui("button", label="Connect")
    env.wait_ui("count", lambda n: n > 0, selector=".ms-waiting", timeout=20)
    hint = env.ui("text", selector=".ms-waiting .ms-consent")
    g.check(hint and "Approval required" in hint[0] and "facd6cff-a294-4415-b59f-c5b01937d7bd" in hint[0],
            "the waiting box says what to do when the organisation must approve DavMail (its application ID)", hint)
    win = wait(lambda: env.x_windows("DavMail stand-in sign-in"), 60)
    g.check(bool(win), "DavMail's sign-in window opens", requests_log()[-400:])
    open(os.path.join(gw_dir(), "signin.approve"), "w").close()
    env.wait_ui("count", lambda n: n == 0, selector=".ms-waiting", timeout=60)

    # ---- what was made -------------------------------------------------------------------
    acct = wait(lambda: env.chrome(ACCOUNT + """if (!acct) return null; const s = acct.incomingServer, id = acct.defaultIdentity;
      const out = MailServices.outgoingServer.getServerByKey(id.smtpServerKey);
      return { type: s.type, host: s.hostname ?? s.hostName, port: s.port, user: s.username, name: id.fullName, fcc: id.doFcc,
               smtp: out && { host: out.QueryInterface(Ci.nsISmtpServer).hostname, port: out.QueryInterface(Ci.nsISmtpServer).port, user: out.username } };""", MEGAN), 30)
    props = open(os.path.join(gw_dir(), "davmail.properties")).read()
    ports = {k: int(v) for k, v in re.findall(r"davmail\.(caldav|imap|smtp)Port=(\d+)", props)}
    g.check(acct is not None and acct["type"] == "imap" and acct["host"] == "127.0.0.1" and acct["port"] == ports.get("imap") and acct["user"] == MEGAN,
            "Thunderbird's mail account: IMAP on the gateway (127.0.0.1)", (acct, ports))
    g.check(acct and acct["smtp"] == {"host": "127.0.0.1", "port": ports.get("smtp"), "user": MEGAN}, "its outgoing server: SMTP on the gateway", acct)
    g.check(acct and acct["name"] == "Megan Bowen" and acct["fcc"] is False,
            "the name typed; no Sent copy of Thunderbird's own (Exchange keeps one)", acct)
    g.check(env.systemctl("is-active", UNIT) == "active", "the gateway runs as the user service")
    listen = os.popen("ss -Hltn").read()
    for k in ("caldav", "imap", "smtp"):
        lines = [l for l in listen.splitlines() if f":{ports.get(k)} " in l + " "]
        g.check(lines and all("127.0.0.1:" in l for l in lines), f"its {k.upper()} on 127.0.0.1 only", lines)

    # ---- mail through the gateway ----------------------------------------------------------
    d = env.wait_ui("mail", lambda r: any(x.get("subject") == "Budget for Q4" for x in r["list"]), timeout=120)
    g.check(True, "Megan's mail is in SG Mail's list (IMAP through the gateway)")
    g.check("IMAP LOGIN megan@outlook.com OK" in requests_log(), "logged in with the gateway's password (DavMail's token)", requests_log()[-600:])
    env.ui("click", selector="#rb-new-email")
    env.wait_ui("dump", lambda r: True, target="compose", timeout=40)
    env.ui("type", target="compose", selector="#to", value="bob@example.test")
    env.ui("type", target="compose", selector="#subject", value="Agenda through DavMail")
    env.ui("type", target="compose", selector="#editor", value="Hello Bob, the agenda.")
    env.ui("click", target="compose", selector="#send")
    m = wait(lambda: next((x for x in env.smtp_messages() if "Agenda through DavMail" in x["raw"]), None), 60)
    g.check(m is not None and m["rcpt"] == ["bob@example.test"] and f"From: Megan Bowen <{MEGAN}>" in m["raw"],
            "a message sent goes out through the gateway's SMTP", m["raw"][:400] if m else requests_log()[-600:])
    sent = wait(lambda: [r for f, r in env.mailbox("Sent", user=MEGAN) if b"Agenda through DavMail" in r], 30)
    g.check(len(sent or []) == 1, "one copy in Sent Items (Exchange's, not a second of Thunderbird's)", len(sent or []))

    # ---- calendar and contacts on the same gateway, the same sign-in -----------------------
    env.ui("click", selector="#nav-calendar")
    d = env.wait_ui("calendar", lambda r: any(c["name"] == f"Calendar ({MEGAN})" for c in r["calendars"]), timeout=60)
    g.check(True, "its calendar is there")
    st = env.wait_ui("microsoft", lambda r: any(s["state"] == "ok" for s in r["status"]), timeout=60)
    g.check(True, "and answers (no second sign-in)", st)
    books = env.chrome("""const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      return MailServices.ab.directories.map(d => d.dirName);""")
    g.check(f"Contacts ({MEGAN})" in books, "and its address book", books)
    g.check(requests_log().count(" window ") == 1, "one sign-in window in all", requests_log().count(" window "))

    # ---- a meeting invitation: Exchange has put it in the calendar itself -------------------------
    # (the real account showed it: Exchange adds an invitation to the calendar
    # as tentative, under its own UID -- the global object ID carrying the
    # invitation's UID -- and DavMail refuses a second copy; SG Mail answers
    # on Exchange's copy)
    INV_UID = "planning-qa@example.test"
    goid = ("040000008200E00074C5B7101A82E00800000000000000000000000000000000000000003200000076" "43616C2D55696401000000"
            + INV_UID.encode().hex().upper() + "00")
    vevent = ("BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:20261001T080000Z\r\nDTSTART:20261020T160000Z\r\nDTEND:20261020T170000Z\r\n"
              "SUMMARY:QA planning\r\nORGANIZER;CN=Bob Builder:mailto:bob@example.test\r\n"
              "ATTENDEE;CN=Megan Bowen;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:" + MEGAN + "\r\n{extra}END:VEVENT\r\n")
    cal_ics = lambda uid, extra="": "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Exchange stand-in//EN\r\n" + vevent.format(uid=uid, extra=extra) + "END:VCALENDAR\r\n"
    env.dav("PUT", f"/{MEGAN}/calendar/exchange-copy.ics", cal_ics(goid, "STATUS:TENTATIVE\r\n"), user=MEGAN, headers={"Content-Type": "text/calendar"})
    req = cal_ics(INV_UID).replace("VERSION:2.0\r\n", "VERSION:2.0\r\nMETHOD:REQUEST\r\n")
    env.append("INBOX", message("Bob Builder <bob@example.test>", f"Megan Bowen <{MEGAN}>", "QA planning", text="Shall we plan?",
                                calendar=(req, "REQUEST")), user=MEGAN)
    env.ui("click", selector="#nav-mail")
    env.wait_ui("mail", lambda r: any(x.get("subject") == "QA planning" for x in r["list"]), timeout=120)
    env.ui("selectMessage", subject="QA planning")
    env.wait_ui("mail", lambda r: r["reader"].get("invite") is not None, timeout=40)
    env.ui("click", selector="#invite-accept")

    def meg_vevents():
        return [re.sub(r"\r?\n[ \t]", "", t).replace("\r", "") for t in env.collection_files(MEGAN, "calendar", ".ics")]
    acc = wait(lambda: next((e for e in meg_vevents() if goid in e and re.search(r"PARTSTAT=ACCEPTED[^\n]*" + re.escape(MEGAN), e)), None), 60)
    g.check(acc is not None, "Accept answers on Exchange's own copy of the meeting (Megan ACCEPTED there)", [e[-400:] for e in meg_vevents() if "QA planning" in e])
    g.check(len([e for e in meg_vevents() if "SUMMARY:QA planning" in e]) == 1, "and puts no second copy in the calendar",
            len([e for e in meg_vevents() if "SUMMARY:QA planning" in e]))
    t = env.wait_ui("text", lambda r: r and "You have accepted this invitation." in r[0], selector="#rp-invite", timeout=40)
    g.check(True, "the reading pane then says it is accepted (and offers Tentative, Decline)", t)

    # ---- any other address: Thunderbird's own setup, the address typed in ----------------------
    env.ui("click", selector="#nav-mail")
    env.ui("click", selector="#rt-file")
    env.ui("menu", label="Add Account…")
    modal_title(20)
    env.ui("type", selector=".modal #aa-name", value="Carol Autoconf")
    env.ui("type", selector=".modal #aa-email", value="carol@autoconf.test")
    env.ui("button", label="Next")
    filled = env.chrome("""
      const w = Services.wm.getMostRecentWindow("mail:3pane"), d = w.document;
      const deep = (root, sel) => { const out = []; const walk = n => { out.push(...n.querySelectorAll(sel));
        for (const e of n.querySelectorAll("*")) if (e.shadowRoot) walk(e.shadowRoot); }; if (root) walk(root); return out; };
      for (let i = 0; i < 100; i++) {
        const hub = d.querySelector("account-hub-container");
        if (hub?.modal?.open) { const e = deep(hub.shadowRoot, "#email")[0]; if (e?.value) return { setup: "hub", email: e.value }; }
        const t = d.getElementById("tabmail").tabInfo.find(t => t.browser?.currentURI.spec == "about:accountsetup");
        const e = t?.browser?.contentDocument?.getElementById("email");
        if (e?.value) return { setup: "tab", email: e.value };
        await new Promise(r => w.setTimeout(r, 200));
      }
      return null;""", timeout_ms=40000)
    g.check(filled and filled["email"] == "carol@autoconf.test", "any other address: Thunderbird's own account setup, with it typed in", filled)
    env.chrome("""const w = Services.wm.getMostRecentWindow("mail:3pane"), d = w.document;
      const hub = d.querySelector("account-hub-container"); if (hub?.modal?.open) hub.modal.close?.();
      const tm = d.getElementById("tabmail"); const t = tm.tabInfo.find(t => t.browser?.currentURI.spec == "about:accountsetup");
      if (t) tm.closeTab(t); return true;""")

    # ---- the account removed: everything with it -------------------------------------------------
    smtp_key = env.chrome(ACCOUNT + "return acct.defaultIdentity.smtpServerKey;", MEGAN)
    env.chrome(ACCOUNT + "MailServices.accounts.removeAccount(acct, true); return true;", MEGAN)
    g.check(wait(lambda: not os.path.exists(gw_dir()), 60), "the account removed: its gateway's settings and token are deleted")
    left = env.chrome("""const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
      // (the test's own Radicale password for Megan is not SG Mail's)
      const logins = (await Services.logins.getAllLogins()).filter(l => l.username == args.email && l.origin != args.radicale).map(l => l.origin);
      return { smtp: MailServices.outgoingServer.servers.some(s => s.key == args.key), logins,
               cals: cal.manager.getCalendars().filter(c => c.name.includes(args.email)).length,
               books: MailServices.ab.directories.filter(d => d.dirName.includes(args.email)).length };""", {"email": MEGAN, "key": smtp_key, "radicale": f"http://127.0.0.1:{CALDAV_PORT}"})
    g.check(left == {"smtp": False, "logins": [], "cals": 0, "books": 0}, "and its outgoing server, passwords, calendar and address book", left)
    g.check(env.systemctl("is-active", UNIT) != "active", "and the service is stopped")
    env.screenshot(os.path.join(env.dir, "davmail-mail.png"))
finally:
    env.stop()
sys.exit(g.result())
