"""Gate: shared calendars and the Scheduling Assistant. Open Shared
Calendar finds a colleague's calendar on the CalDAV server one's own is on,
as far as they share it (Bob lets Alice read his; Carol shares nothing:
SG Mail says so): it is listed under Shared Calendars, read-only, with its
events. The meeting window's Scheduling Assistant shows each attendee's busy
times for the day: Alice's own (her calendar), Bob's (his calendar she has
open; his Free time not busy), Carol's from her calendar server's free/busy
(a CalDAV scheduling server: here a free/busy provider registered in
Thunderbird), Dave: no information. AutoPick Next finds the next time all
are free; a click in the grid moves the meeting; Send saves it there. A
shared calendar is removed again from its menu.

Mutants (test/mutants.json): sched-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import calendar
import datetime
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate  # noqa: E402

RIGHTS = r"""
[owner]
user: .+
collection: {user}(/.*)?
permissions: RrWw
[root]
user: .+
collection:
permissions: R
[alice-reads-bob]
user: alice@example\.test
collection: bob@example\.test(/.*)?
permissions: Rr
"""

g = Gate("scheduling")
env = Env("scheduling", radicale_rights=RIGHTS)
SHOTS = os.environ.get("SG_MAIL_SHOTS") or os.path.join(env.dir, "shots")
os.makedirs(SHOTS, exist_ok=True)

# a Wednesday at least two days ahead (UTC, as the gate's Thunderbird)
d = datetime.date.today() + datetime.timedelta(days=2)
while d.weekday() != 2:
    d += datetime.timedelta(days=1)
DAY = d


def at(h, m=0):
    return calendar.timegm((DAY.year, DAY.month, DAY.day, h, m, 0))


def wait(fn, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def rows(s):
    return {r["email"]: r for r in s["rows"]}


try:
    env.start_servers()
    env.dav("PROPFIND", "/bob@example.test/", "", user="bob@example.test", headers={"Depth": "0"})
    st, _ = env.make_calendar("bob@example.test", "/bob@example.test/calendar/", "Bob's Calendar")
    g.check(st in (200, 201), "(Bob's calendar on the server)", st)
    env.put_event("bob@example.test", "/bob@example.test/calendar/", "bob-1", "Bob busy", at(10), at(11))
    env.put_event("bob@example.test", "/bob@example.test/calendar/", "bob-2", "Bob free time", at(14), at(15), transp="TRANSPARENT")
    env.put_event("alice@example.test", "/alice@example.test/work/", "alice-1", "Dentist", at(13), at(14))
    env.make_profile()
    env.start_thunderbird()
    env.caldav_id = env.add_caldav_calendar()
    env.wait_ui("ping", lambda r: r["ready"], timeout=90)
    # Carol's calendar server: free/busy as a CalDAV scheduling server gives it
    env.chrome("""
      const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
      const provider = {
        QueryInterface: ChromeUtils.generateQI(["calIFreeBusyProvider"]),
        getFreeBusyIntervals(calId, start, end, types, listener) {
          const out = [];
          if (calId.toLowerCase() === "mailto:carol@example.test") {
            out.push(new cal.provider.FreeBusyInterval(calId, Ci.calIFreeBusyInterval.BUSY, cal.createDateTime(args[0]), cal.createDateTime(args[1])));
          }
          listener.onResult(null, out);
          return null;
        },
      };
      cal.freeBusyService.addProvider(provider);
      return true;""", [time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(at(9))), time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(at(10)))])

    # ---- Open Shared Calendar ----
    env.ui("click", selector="#nav-calendar")
    env.ui("calendarDate", y=DAY.year, m=DAY.month, d=DAY.day)
    env.wait_ui("calendar", lambda r: any(e["title"] == "Dentist" for e in r["events"]), timeout=60)
    env.ui("click", selector="#rb-open-calendar")
    env.ui("menu", label="Open Shared Calendar…")
    env.wait_ui("count", lambda n: n == 1, selector=".modal #shared-name", timeout=10)
    env.ui("type", selector=".modal #shared-name", value="bob@example.test")
    env.ui("button", label="OK")
    c = env.wait_ui("calendar", lambda r: any(x["shared"] for x in r["calendars"]), timeout=40)
    sh = [x for x in c["calendars"] if x["shared"]]
    g.check(len(sh) == 1 and sh[0]["shared"] == "bob@example.test" and "Bob's Calendar" in sh[0]["name"], "Open Shared Calendar: Bob's calendar opens", sh)
    g.check(sh[0]["readOnly"], "read-only: Bob lets Alice read it, not change it", sh[0])
    g.check("Shared Calendars" in c["groups"] and "My Calendars" in c["groups"], "listed under Shared Calendars", c["groups"])
    c = env.wait_ui("calendar", lambda r: any(e["title"] == "Bob busy" for e in r["events"]), timeout=60)
    g.check(next(e for e in c["events"] if e["title"] == "Bob busy")["calendar"] == sh[0]["name"], "his appointments in the calendar")

    env.ui("click", selector="#rb-open-calendar")
    env.ui("menu", label="Open Shared Calendar…")
    env.wait_ui("count", lambda n: n == 1, selector=".modal #shared-name", timeout=10)
    env.ui("type", selector=".modal #shared-name", value="carol@example.test")
    env.ui("button", label="OK")
    err = env.wait_ui("text", lambda r: r, selector="#shared-error", timeout=40)
    g.check("carol@example.test" in err[0], "Carol shares nothing: SG Mail says so", err)
    env.ui("button", label="OK")
    c = env.ui("calendar")
    g.check(len([x for x in c["calendars"] if x["shared"]]) == 1, "and opens nothing")

    # ---- the Scheduling Assistant ----
    env.ui("newEvent", start=at(10) * 1000, end=at(10, 30) * 1000, meeting=True,
           attendees="Bob Builder <bob@example.test>; Carol Danvers <carol@example.test>; Dave <dave@example.test>")
    env.wait_ui("dump", lambda r: r["meeting"], target="event", timeout=40)
    env.ui("type", target="event", selector="#title", value="Planning")
    env.ui("click", target="event", selector="#rb-show-scheduling")
    s = env.wait_ui("schedule", lambda r: len(r["rows"]) == 4 and all(x["known"] or x["email"] == "dave@example.test" for x in r["rows"])
                    and len(rows(r)["carol@example.test"]["busy"]) == 1, target="event", timeout=60)
    r = rows(s)
    g.check(r["alice@example.test"]["organizer"] and r["alice@example.test"]["busy"] == [["13:00", "14:00", "busy"]],
            "Alice (organizer): busy from her own calendar", r["alice@example.test"])
    g.check(r["bob@example.test"]["busy"] == [["10:00", "11:00", "busy"]], "Bob: busy from his calendar she has open; his Free time is not busy", r["bob@example.test"])
    g.check(r["carol@example.test"]["busy"] == [["09:00", "10:00", "busy"]] and r["carol@example.test"]["sources"] == ["server"],
            "Carol: busy from her calendar server's free/busy", r["carol@example.test"])
    g.check(not r["dave@example.test"]["known"] and next(x for x in s["drawn"] if x["email"] == "dave@example.test")["unknown"],
            "Dave: no information (hatched)", r["dave@example.test"])
    g.check(s["meeting"][:2] == ["10:00", "10:30"], "the meeting over them, 10:00", s["meeting"])
    time.sleep(1)
    handles = env.m.command("WebDriver:GetWindowHandles")
    handles = handles["value"] if isinstance(handles, dict) else handles
    main = env.m.command("WebDriver:GetWindowHandle")
    main = main["value"] if isinstance(main, dict) else main
    other = [x for x in handles if x != main]
    if other:
        env.m.command("WebDriver:SwitchToWindow", {"handle": other[-1]})
        env.screenshot(os.path.join(SHOTS, "sg-mail-scheduling-light.png"))
        env.m.command("WebDriver:SwitchToWindow", {"handle": main})

    env.ui("click", target="event", selector="#sa-autopick")
    s = env.wait_ui("schedule", lambda x: x["meeting"][0] != "10:00", target="event", timeout=20)
    g.check(s["meeting"][:2] == ["11:00", "11:30"], "AutoPick Next: 11:00, the next time all are free (Bob until 11)", s["meeting"])
    env.ui("drag", target="event", selector="#sa-scroll .sa-timeline", px=15 * 84 + 10, py=45, dx=0, dy=0)
    s = env.wait_ui("schedule", lambda x: x["meeting"][0] == "15:00", target="event", timeout=10)
    g.check(s["meeting"][:2] == ["15:00", "15:30"], "a click in the grid moves it there", s["meeting"])
    e = env.ui("dump", target="event")
    g.check(e["start"].endswith("15:00") and e["end"].endswith("15:30"), "the meeting's Start and End follow", (e["start"], e["end"]))
    env.ui("click", target="event", selector="#rb-save-close")
    ok = wait(lambda: any("SUMMARY:Planning" in x and f"DTSTART:{DAY.strftime('%Y%m%d')}T150000Z" in x.replace("\r\n ", "")
                          for x in env.caldav_events()), 40)
    g.check(ok, "Send: the meeting saved at 15:00", [x[:300] for x in env.caldav_events()])

    # ---- the shared calendar removed ----
    env.ui("contextmenu", selector='.cal-item[title*="bob@example.test"]')
    env.ui("menu", label="Remove Calendar")
    env.ui("button", label="Remove")
    c = env.wait_ui("calendar", lambda r: not any(x["shared"] for x in r["calendars"]), timeout=20)
    g.check("Shared Calendars" not in c["groups"], "Remove Calendar: Bob's calendar no longer here", c["groups"])
finally:
    env.stop()
sys.exit(g.result())
