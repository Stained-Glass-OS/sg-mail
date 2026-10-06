"""Gate: Microsoft calendars and contacts through DavMail, end to end, with a
stand-in for DavMail (test/servers/davmail_standin.py: no Microsoft account
here; it passes CalDAV/CardDAV on to Radicale and shows a stand-in sign-in
window) and everything else as installed: the package's helper
(/usr/lib/sg-mail/sg-mail-davmail) and user unit (sg-mail-davmail@.service)
run by a systemd user manager of the gate's own.

A Microsoft account (megan@outlook.com) is added while SG Mail runs: SG Mail
offers its calendar and contacts; "Add" opens the sign-in (our waiting box,
DavMail's window) and, once signed in, the account's gateway runs as the
user service on 127.0.0.1 only, its settings private, and Thunderbird has
the CalDAV calendar and CardDAV address book on it. Through SG Mail's own
window: the server's appointment is drawn, a new one is saved, dragged to
another day, deleted; the server's contact is in People, a new contact is
saved. The service stopped: "Start". The sign-in expired: "Sign in again"
(and Cancel ends the sign-in, nothing left running). The account removed:
calendar, address book, settings and token gone, the service stopped.

Mutants (test/mutants.json): davmail-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import datetime
import os
import re
import stat
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import CALDAV_PORT, IMAP_PORT, SRC, Env, Gate  # noqa: E402

# Radicale's rights: each user their own, and Megan may read Bob's (a
# colleague's calendar shared with her, as Exchange shares calendars)
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
"""
g = Gate("davmail")
env = Env("davmail", radicale_rights=RIGHTS)
MEGAN = "megan@outlook.com"
NAME = "megan-at-outlook.com"
UNIT = f"sg-mail-davmail@{NAME}.service"
CAL = f"Calendar ({MEGAN})"
BOOK = f"Contacts ({MEGAN})"
SLOT = 24


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


def megan_events():
    return [t.replace("\r\n ", "").replace("\r", "") for t in env.collection_files(MEGAN, "calendar", ".ics")]


def megan_cards():
    return [t.replace("\r", "") for t in env.collection_files(MEGAN, "contacts", ".vcf")]


def signin_procs():
    """Processes of a sign-in gateway (the stand-in run on signin.properties)."""
    out = []
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode()
            except OSError:
                continue
            if "signin.properties" in cmd:
                out.append(cmd)
    return out


def approve_signin(timeout=60):
    """The person signs in, in the (stand-in) DavMail window."""
    win = wait(lambda: env.x_windows("DavMail stand-in sign-in"), timeout)
    open(os.path.join(gw_dir(), "signin.approve"), "w").close()
    return bool(win)


def ms(cond, timeout=40):
    return env.wait_ui("microsoft", cond, timeout=timeout)


def state_of(r):
    return next((s["state"] for s in r["status"] if s["accountId"] == env.megan), None)


def listening():
    return subprocess.run(["ss", "-Hltn"], capture_output=True, text=True).stdout


def event_window(timeout=40):
    return env.wait_ui("dump", lambda r: True, target="event", timeout=timeout)


QUARTERLY = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SG Mail gate//EN
BEGIN:VEVENT
UID:quarterly@outlook.test
DTSTAMP:20261001T080000Z
DTSTART:20261013T100000Z
DTEND:20261013T110000Z
SUMMARY:Quarterly review
END:VEVENT
END:VCALENDAR
"""
NESTOR = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:nestor-1\r\nFN:Nestor Wilke\r\nN:Wilke;Nestor;;;\r\nEMAIL:nestor@contoso.test\r\nEND:VCARD\r\n"

try:
    env.start_servers()
    st = env.make_davmail_collections(MEGAN)
    g.check(st == (201, 201), "(Radicale has Megan's calendar and address book, behind the DavMail stand-in)", st)
    env.dav("PUT", f"/{MEGAN}/calendar/quarterly.ics", QUARTERLY, user=MEGAN, headers={"Content-Type": "text/calendar"})
    env.dav("PUT", f"/{MEGAN}/contacts/nestor.vcf", NESTOR, user=MEGAN, headers={"Content-Type": "text/vcard"})
    env.make_calendar("bob@example.test", "/bob@example.test/calendar/", "Calendar")
    env.dav("PUT", "/bob@example.test/calendar/bob-1.ics", QUARTERLY.replace("quarterly@outlook.test", "bob-1@example.test")
            .replace("Quarterly review", "Bob at the dentist").replace("T100000Z", "T140000Z").replace("T110000Z", "T150000Z"),
            user="bob@example.test", headers={"Content-Type": "text/calendar"})
    env.make_profile()
    dm_env = {"SG_DAVMAIL": os.path.join(SRC, "test/servers/davmail_standin.py"),
              "SG_STANDIN_UPSTREAM": f"http://127.0.0.1:{CALDAV_PORT}", "SG_STANDIN_UPSTREAM_AUTH": f"{MEGAN}:megan-secret"}
    env.start_user_manager(dm_env)
    g.check(os.path.exists("/usr/lib/systemd/user/sg-mail-davmail@.service") and os.access("/usr/lib/sg-mail/sg-mail-davmail", os.X_OK),
            "(the package's user unit and helper are installed)")
    env.start_thunderbird(mutant_env=dm_env)
    env.wait_ui("ping", lambda r: r["ready"], timeout=60)
    env.ui("click", selector="#nav-calendar")

    # ---- a Microsoft account added: the offer ---------------------------------------------
    env.megan = env.chrome("""
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const server = MailServices.accounts.createIncomingServer(args.user, "127.0.0.1", "imap");
      server.port = args.port; server.socketType = 0; server.authMethod = 3;
      server.setBoolValue("login_at_startup", false);
      const id = MailServices.accounts.createIdentity();
      id.email = args.user; id.fullName = "Megan Bowen";
      const account = MailServices.accounts.createAccount();
      account.addIdentity(id);
      account.incomingServer = server;
      return account.key;""", {"user": MEGAN, "port": IMAP_PORT})
    title = wait(lambda: env.ui("text", selector=".modal .modal-title"), 30)
    g.check(title == ["Calendar and contacts (Microsoft)"], "a Microsoft account added: SG Mail offers its calendar and contacts", title)
    if not title:
        raise SystemExit(g.result())
    env.ui("button", label="Add calendar and contacts")
    waiting = env.wait_ui("count", lambda n: n > 0, selector=".ms-waiting", timeout=15)
    g.check(waiting == 1, "a box says Microsoft's sign-in is open, with Cancel")
    g.check(approve_signin(), "DavMail's sign-in window opens (the stand-in's)", requests_log()[-500:])
    gone = env.wait_ui("count", lambda n: n == 0, selector=".ms-waiting", timeout=60)
    d = env.wait_ui("calendar", lambda r: any(c["name"] == CAL for c in r["calendars"]), timeout=60)
    g.check(True, "signed in: the box closes and the account's calendar is listed", [c["name"] for c in d["calendars"]])

    # ---- the gateway: a user service, on the loopback only, private ---------------------------
    g.check(env.systemctl("is-active", UNIT) == "active", f"its gateway runs as the user service {UNIT}", env.systemctl("status", UNIT))
    port = int(re.search(r"davmail.caldavPort=(\d+)", open(os.path.join(gw_dir(), "davmail.properties")).read()).group(1))
    lines = [l for l in listening().splitlines() if f":{port} " in l + " "]
    g.check(lines and all("127.0.0.1:" in l for l in lines), f"listening on 127.0.0.1:{port} only", lines)
    g.check(not signin_procs(), "the sign-in gateway is gone once signed in", signin_procs())
    modes = {n: stat.S_IMODE(os.stat(os.path.join(gw_dir(), n)).st_mode) for n in ("davmail.properties", "tokens")}
    dmode = stat.S_IMODE(os.stat(gw_dir()).st_mode)
    g.check(dmode == 0o700 and all(m == 0o600 for m in modes.values()), "its settings and token are the user's only (0700, 0600)", (oct(dmode), modes))
    props = open(os.path.join(gw_dir(), "davmail.properties")).read()
    g.check("davmail.allowRemote=false" in props and "davmail.bindAddress=127.0.0.1" in props and f"davmail.userWhiteList={MEGAN}" in props
            and "O365StoredTokenAuthenticator" in props and "davmail.mode=O365Graph" in props,
            "DavMail's settings: loopback only, this address only, Graph, the service never opens a sign-in window", props)
    cal = env.chrome("""const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
      const c = cal.manager.getCalendars().find(x => x.name == args);
      return c && { type: c.type, uri: c.uri.spec, user: c.getProperty("username") };""", CAL)
    g.check(cal == {"type": "caldav", "uri": f"http://127.0.0.1:{port}/users/{MEGAN}/calendar/", "user": MEGAN},
            "Thunderbird's CalDAV calendar on the gateway", cal)

    # ---- the calendar through SG Mail's window ---------------------------------------------
    env.ui("calendarView", view="workweek")
    env.ui("calendarDate", y=2026, m=10, d=13)
    d = env.wait_ui("calendar", lambda r: any(e["title"] == "Quarterly review" and e["calendar"] == CAL for e in r["events"]), timeout=90)
    g.check(any("Quarterly review" in x for x in d["drawn"]), "the Microsoft calendar's appointment is drawn")
    env.dayms = {x: int(datetime.datetime(2026, 10, x, tzinfo=datetime.timezone.utc).timestamp() * 1000) for x in range(1, 32)}
    env.ui("newEvent", start=env.dayms[14] + 12 * 3600000, end=env.dayms[14] + 13 * 3600000)
    event_window()
    env.ui("type", target="event", selector="#title", value="Budget sync")
    env.ui("selectCalendarInEvent", target="event", name=CAL)
    env.ui("save", target="event")
    ev = wait(lambda: next((e for e in megan_events() if "SUMMARY:Budget sync" in e), None), 60)
    g.check(ev is not None and "DTSTART:20261014T120000Z" in ev, "a new appointment is saved in the Microsoft calendar (through the gateway)", ev)
    g.check(re.search(r"service PUT /users/megan(@|%40)outlook\.com/calendar/\S+ 20[14]", requests_log()) is not None,
            "by Thunderbird's CalDAV, to the gateway's /users/ADDRESS/calendar/", requests_log()[-800:])
    env.wait_ui("count", lambda n: n > 0, selector='#module-calendar .tg-col .ev[title^="Budget sync"]', timeout=40)
    col = f'#module-calendar .tg-col[data-day="{env.dayms[15]}"]'
    env.ui("drag", selector='#module-calendar .tg-col .ev[title^="Budget sync"]', fy=0.3, to={"selector": col, "fy": 0, "py": 12.3 * 2 * SLOT})
    moved = wait(lambda: next((e for e in megan_events() if "SUMMARY:Budget sync" in e and "DTSTART:20261015T120000Z" in e), None), 60)
    g.check(moved is not None, "dragged to Thursday: moved in the Microsoft calendar", [e for e in megan_events() if "Budget" in e])
    env.wait_ui("calendar", lambda r: any(e["title"] == "Budget sync" and datetime.datetime.fromtimestamp(e["start"] / 1000, datetime.timezone.utc).day == 15
                                          for e in r["events"]), timeout=30)
    # (the view redraws when the move comes back from the server: select and
    # press Delete on what is drawn then, again if a redraw took the selection)
    gone = False
    for _ in range(3):
        env.wait_ui("count", lambda n: n > 0, selector='#module-calendar .tg-col .ev[title^="Budget sync"]', timeout=30)
        env.ui("calendarSelect", title="Budget sync")
        env.ui("key", key="Delete", selector="#module-calendar")
        gone = wait(lambda: not any("Budget sync" in e for e in megan_events()), 20)
        if gone:
            break
    g.check(gone, "Delete removes it from the Microsoft calendar")

    # ---- contacts through People ---------------------------------------------------------
    env.ui("key", selector="#module-calendar", key="3", ctrl=True)
    d = env.wait_ui("people", lambda r: BOOK in r["books"], timeout=60)
    g.check(True, "People lists the account's address book (CardDAV on the gateway)", d["books"])
    env.ui("click", selector=".pp-scope .fp-name", text=BOOK)
    d = env.wait_ui("people", lambda r: "Nestor Wilke" in r["list"], timeout=60)
    g.check(True, "with the Microsoft contact in it")
    env.ui("click", selector="#rb-new-contact")
    env.wait_ui("count", lambda n: n > 0, selector=".modal #ce-first", timeout=15)
    for k, v in {"first": "Lee", "last": "Gu", "email": "lee@contoso.test"}.items():
        env.ui("type", selector=f".modal #ce-{k}", value=v)
    env.ui("button", label="Save & Close")
    card = wait(lambda: next((c for c in megan_cards() if "lee@contoso.test" in c), None), 60)
    g.check(card is not None and "FN:Lee Gu" in card, "a new contact is saved to the Microsoft address book", megan_cards())
    env.ui("key", selector="#pp-list", key="2", ctrl=True)

    # ---- a colleague's calendar, shared with Megan: through the same gateway ------------------
    env.ui("click", selector="#nav-calendar")
    env.ui("click", selector="#rb-open-calendar")
    env.ui("menu", label="Open Shared Calendar…")
    env.wait_ui("count", lambda n: n == 1, selector=".modal #shared-name", timeout=10)
    env.ui("type", selector=".modal #shared-name", value="bob@example.test")
    env.ui("button", label="OK")
    c = env.wait_ui("calendar", lambda r: any(x.get("shared") for x in r["calendars"]), timeout=60)
    sh = env.chrome("""const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
      return cal.manager.getCalendars().filter(c => c.getProperty("sgmail.shared")).map(c => c.uri.spec);""")
    g.check(sh == [f"http://127.0.0.1:{port}/users/bob@example.test/calendar/"],
            "Open Shared Calendar: a colleague's calendar, through the account's gateway (/users/THEIR-ADDRESS/calendar/)", sh)
    env.ui("calendarDate", y=2026, m=10, d=13)
    d = env.wait_ui("calendar", lambda r: any(e["title"] == "Bob at the dentist" for e in r["events"]), timeout=60)
    g.check(True, "with the colleague's appointments in it")

    # ---- the service stopped: Start ---------------------------------------------------------
    env.systemctl("stop", UNIT)
    r = ms(lambda r: state_of(r) == "stopped", 40)
    g.check(True, "the service stopped: SG Mail says so")
    env.wait_ui("count", lambda n: n > 0, selector='.ms-row[data-state="stopped"] .ms-action', timeout=20)
    env.ui("click", selector='.ms-row[data-state="stopped"] .ms-action', text="Start")
    r = ms(lambda r: state_of(r) == "ok", 60)
    g.check(env.systemctl("is-active", UNIT) == "active", "Start: the service runs again and the calendar answers")

    # ---- the sign-in expired: Sign in again ---------------------------------------------------
    windows_before = requests_log().count(" window ")
    os.remove(os.path.join(gw_dir(), "tokens"))
    r = ms(lambda r: state_of(r) == "signin", 60)
    g.check(True, "DavMail's sign-in expired: SG Mail asks to sign in again", r["status"])
    g.check(requests_log().count(" window ") == windows_before and "service window" not in requests_log(),
            "and the service itself opened no sign-in window", requests_log()[-600:])
    env.wait_ui("count", lambda n: n > 0, selector='.ms-row[data-state="signin"] .ms-action', timeout=20)
    env.ui("click", selector='.ms-row[data-state="signin"] .ms-action', text="Sign in again")
    env.wait_ui("count", lambda n: n > 0, selector=".ms-waiting", timeout=15)
    g.check(approve_signin(), "Sign in again opens DavMail's sign-in window")
    r = ms(lambda r: state_of(r) == "ok", 60)
    g.check(env.wait_ui("count", lambda n: n == 0, selector=".ms-row", timeout=20) == 0, "signed in again: the calendar answers, the warning is gone")

    # and given up: Cancel
    os.remove(os.path.join(gw_dir(), "tokens"))
    ms(lambda r: state_of(r) == "signin", 60)
    env.wait_ui("count", lambda n: n > 0, selector='.ms-row[data-state="signin"] .ms-action', timeout=20)
    env.ui("click", selector='.ms-row[data-state="signin"] .ms-action', text="Sign in again")
    env.wait_ui("count", lambda n: n > 0, selector=".ms-waiting", timeout=15)
    wait(lambda: env.x_windows("DavMail stand-in sign-in"), 60)
    env.ui("click", selector=".ms-waiting .btn", text="Cancel")
    env.wait_ui("count", lambda n: n == 0, selector=".ms-waiting", timeout=30)
    g.check(wait(lambda: not signin_procs() and not env.x_windows("DavMail stand-in sign-in"), 20),
            "Cancel ends the sign-in: its gateway and window are gone", signin_procs())
    r = ms(lambda r: state_of(r) == "signin", 30)
    g.check(True, "and SG Mail still asks to sign in again")

    # ---- the account removed --------------------------------------------------------------
    env.chrome("""const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      MailServices.accounts.removeAccount(MailServices.accounts.getAccount(args), true); return true;""", env.megan)
    d = env.wait_ui("calendar", lambda r: not any(c["name"] == CAL for c in r["calendars"]), timeout=60)
    g.check(True, "the account removed: its Microsoft calendar is gone from SG Mail")
    left = env.chrome("""const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
      return cal.manager.getCalendars().filter(c => c.uri && c.uri.spec.startsWith(args)).map(c => c.name);""", f"http://127.0.0.1:{port}/")
    g.check(left == [], "and the shared calendar opened through its gateway", left)
    books = env.chrome("""const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      return MailServices.ab.directories.map(d => d.dirName);""")
    g.check(BOOK not in books, "and its address book", books)
    g.check(wait(lambda: not os.path.exists(gw_dir()), 30), "its gateway's settings and DavMail's token are deleted")
    g.check(env.systemctl("is-active", UNIT) != "active", "and the service is stopped", env.systemctl("is-active", UNIT))
    env.screenshot(os.path.join(env.dir, "davmail.png"))
finally:
    env.stop()
sys.exit(g.result())
