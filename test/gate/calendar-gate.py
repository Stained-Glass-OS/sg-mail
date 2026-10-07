"""Gate: the calendar. Alice's CalDAV calendar (Radicale) and the local
Calendar SG Mail makes when there is none: the Calendar module (navigation
bar), Day / Work Week / Week / Month (Ctrl+Alt+1..4) with the events of the
server in them, a new appointment (saved to the CalDAV server, with its
location and reminder), a weekly recurring one (RRULE; its occurrences in
Month), an all-day event, changing one, deleting one, a meeting request
(sent to the attendee as an iCalendar REQUEST), .ics import, and a reminder
as a desktop notification.

Mutants (test/mutants.json): calendar-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import datetime
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate  # noqa: E402

g = Gate("calendar")
env = Env("calendar")
UTC = datetime.timezone.utc


def ms(y, mo, d, h=0, mi=0):
    return int(datetime.datetime(y, mo, d, h, mi, tzinfo=UTC).timestamp() * 1000)


def wait(fn, timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def caldav_with(text, present=True, timeout=40):
    return wait(lambda: (any(text in e for e in env.caldav_events())) == present, timeout)


def event_window(timeout=40):
    return env.wait_ui("dump", lambda r: True, target="event", timeout=timeout)


def save_event(title, calendar="Work", location=None):
    event_window()
    env.ui("type", target="event", selector="#title", value=title)
    if location:
        env.ui("type", target="event", selector="#location", value=location)
    env.ui("selectCalendarInEvent", target="event", name=calendar)
    env.ui("save", target="event")


DENTIST = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SG Mail gate//EN
BEGIN:VEVENT
UID:dentist-1@example.test
DTSTAMP:20261001T080000Z
DTSTART:20261013T100000Z
DTEND:20261013T110000Z
SUMMARY:Dentist
LOCATION:Main Street 5
END:VEVENT
END:VCALENDAR
"""
HOLIDAY = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SG Mail gate//EN
BEGIN:VEVENT
UID:holiday-1@example.test
DTSTAMP:20261001T080000Z
DTSTART;VALUE=DATE:20261016
DTEND;VALUE=DATE:20261017
SUMMARY:Company holiday
END:VEVENT
END:VCALENDAR
"""

try:
    env.start_servers()
    st, _ = env.dav("PUT", "/alice@example.test/work/dentist-1.ics", DENTIST, headers={"Content-Type": "text/calendar"})
    g.check(st in (201, 204), "(the server has Alice's Dentist appointment)", st)
    env.make_profile()
    env.start_thunderbird(hold_calendar=True)
    env.caldav_id = env.add_caldav_calendar()
    env.wait_ui("ping", lambda r: r["ready"], timeout=60)

    env.ui("click", selector="#nav-calendar")
    d = env.wait_ui("calendar", lambda r: any(c["name"] == "Work" for c in r["calendars"]), timeout=60)
    names = sorted(c["name"] for c in d["calendars"])
    g.check(names == ["Work"], "Alice's CalDAV calendar is listed (and no local one is added beside it)", names)
    title = env.ui("ping")["title"]
    g.check(title == "Calendar - SG Mail", "the window says Calendar", title)
    env.ui("calendarDate", y=2026, m=10, d=13)
    d = env.wait_ui("calendar", lambda r: any(e["title"] == "Dentist" for e in r["events"]), timeout=90)
    g.check(d["view"] == "workweek" and d["title"] == "October 12 – 16, 2026", "Work Week: Monday to Friday", d["title"])
    g.check("Dentist" in " ".join(d["drawn"]), "the server's appointment is drawn", d["drawn"])

    for key, view, want in (("1", "day", "Tuesday, October 13, 2026"), ("3", "week", None), ("4", "month", "October 2026"), ("2", "workweek", "October 12 – 16, 2026")):
        env.ui("key", key=key, ctrl=True, alt=True, selector="#module-calendar")
        d = env.wait_ui("calendar", lambda r: r["view"] == view, timeout=15)
        if want:
            g.check(d["title"] == want, f"Ctrl+Alt+{key}: {view} ({want})", d["title"])
        else:
            g.check(d["title"].startswith("October 1") and d["title"].endswith("2026"), f"Ctrl+Alt+{key}: week", d["title"])
        g.check(any("Dentist" in x for x in d["drawn"]), f"{view} shows the appointment", d["drawn"])

    # a new appointment, to the CalDAV server
    env.ui("newEvent", start=ms(2026, 10, 14, 12), end=ms(2026, 10, 14, 13))
    save_event("Team lunch", location="Cafeteria")
    g.check(caldav_with("SUMMARY:Team lunch"), "a new appointment is saved on the CalDAV server")
    ev = next((e for e in env.caldav_events() if "Team lunch" in e), "")
    g.check("LOCATION:Cafeteria" in ev and "DTSTART:20261014T120000Z" in ev.replace("\r", ""), "with its place and time", ev[:500])
    g.check("BEGIN:VALARM" in ev and "TRIGGER" in ev, "and a reminder", ev[:800])
    d = env.wait_ui("calendar", lambda r: any(e["title"] == "Team lunch" for e in r["events"]), timeout=30)
    g.check(True, "and drawn in the week")

    # weekly, four times
    env.ui("newEvent", start=ms(2026, 10, 13, 9), end=ms(2026, 10, 13, 9, 30))
    event_window()
    env.ui("setRecurrence", target="event", freq="weekly", interval=1, count=4, until=None, byday=["TU"])
    save_event("Standup")
    g.check(caldav_with("SUMMARY:Standup"), "a recurring appointment is saved")
    ev = next((e for e in env.caldav_events() if "Standup" in e), "")
    g.check("RRULE:FREQ=WEEKLY" in ev and "COUNT=4" in ev and "BYDAY=TU" in ev, "weekly on Tuesdays, four times (RRULE)", ev[:600])
    env.ui("calendarView", view="month")
    d = env.wait_ui("calendar", lambda r: len([e for e in r["events"] if e["title"] == "Standup"]) >= 3, timeout=30)
    n = len([e for e in d["events"] if e["title"] == "Standup"])
    g.check(n == 4, "Month shows its occurrences: October 13, 20, 27 and November 3 (the last row)", n)

    # all day, imported from a file
    env.ui("importIcs", calendar="Work", ics=HOLIDAY)
    g.check(caldav_with("SUMMARY:Company holiday"), ".ics import puts its events in the calendar")
    d = env.wait_ui("calendar", lambda r: any(e["title"] == "Company holiday" and e["allDay"] for e in r["events"]), timeout=30)
    g.check(True, "an all-day event")

    # change one
    env.ui("calendarView", view="workweek")
    env.wait_ui("calendar", lambda r: any(e["title"] == "Team lunch" for e in r["events"]), timeout=20)
    env.ui("openEvent", title="Team lunch")
    d = event_window()
    g.check(d["title"] == "Team lunch" and d["windowTitle"] == "Team lunch - Appointment", "an appointment opens in its window", d)
    env.ui("type", target="event", selector="#title", value="Team lunch (moved)")
    env.ui("save", target="event")
    g.check(caldav_with("SUMMARY:Team lunch (moved)"), "a change reaches the server")

    # delete one
    env.wait_ui("calendar", lambda r: any(e["title"] == "Dentist" for e in r["events"]), timeout=20)
    env.ui("calendarSelect", title="Dentist")
    env.ui("key", key="Delete", selector="#module-calendar")
    g.check(caldav_with("SUMMARY:Dentist", present=False), "Delete removes it from the server")

    # a meeting: the invitation goes to the attendee
    env.ui("newEvent", start=ms(2026, 10, 15, 14), end=ms(2026, 10, 15, 15), meeting=True)
    event_window()
    env.ui("type", target="event", selector="#attendees", value="Bob Builder <bob@example.test>")
    save_event("Design review")
    m = wait(lambda: next((x for x in env.smtp_messages() if "Design review" in x["raw"]), None), 60)
    g.check(m is not None, "a meeting request is sent")
    if m:
        raw = m["raw"].replace("\r", "")
        g.check(m["rcpt"] == ["bob@example.test"], "to the attendee", m["rcpt"])
        g.check("text/calendar" in raw and "METHOD:REQUEST" in raw, "as an iCalendar REQUEST", raw[:1500])
        g.check("ATTENDEE" in raw and "bob@example.test" in raw and "ORGANIZER" in raw and "alice@example.test" in raw, "naming organizer and attendee")
    g.check(caldav_with("SUMMARY:Design review"), "and the meeting is in Alice's calendar")

    # a reminder: a desktop notification
    soon = int((time.time() + 100) * 1000)
    env.ui("newEvent", start=soon, end=soon + 1800 * 1000)
    event_window()
    env.ui("setReminder", target="event", minutes=1)
    save_event("Call the bank")
    d = env.wait_ui("calendar", lambda r: any(n["kind"] == "reminder" and n["title"] == "Call the bank" for n in r["notifications"]), timeout=120)
    g.check(True, "its reminder comes as a desktop notification")
    env.ui("calendarDate", y=2026, m=10, d=13)
    time.sleep(2)
    env.screenshot(os.path.join(env.dir, "calendar.png"))
finally:
    env.stop()
sys.exit(g.result())
