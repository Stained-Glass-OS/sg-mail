"""Gate: the calendar by the mouse, as Outlook's. In Work Week an
appointment dragged to another day and time, made longer by its bottom edge
and earlier by its top edge; an occurrence of a weekly series dragged: SG
Mail asks "Just this one / The entire series / Cancel" (Cancel changes
nothing; this one: an exception, the series untouched; the series: it all
moves, to its new weekday); an all-day event moved and stretched in the
all-day row; a meeting of Alice's dragged: "Send Update" mails Bob the new
time; in Month an appointment dragged to a day of the next week and
stretched to the day after; time dragged out in the grid (or days in Month)
and typed on: a new appointment in place (Escape drops one); Enter on picked
time opens the appointment window with that time; and one drag with the real
pointer (xdotool). Every change is checked on the CalDAV server (Radicale).

Mutants (test/mutants.json): caldrag-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate  # noqa: E402

g = Gate("caldrag")
env = Env("caldrag")
SLOT = 24           # px: half an hour in the day grid


def wait(fn, timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def ics(uid, summary, start, end, extra=""):
    return ("BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//SG Mail gate//EN\nBEGIN:VEVENT\n"
            f"UID:{uid}\nDTSTAMP:20261001T080000Z\n{start}\n{end}\nSUMMARY:{summary}\n{extra}END:VEVENT\nEND:VCALENDAR\n")


EVENTS = {
    "planning": ics("planning@example.test", "Planning", "DTSTART:20261013T100000Z", "DTEND:20261013T110000Z"),
    "sync": ics("sync@example.test", "Weekly sync", "DTSTART:20261007T140000Z", "DTEND:20261007T143000Z", "RRULE:FREQ=WEEKLY;COUNT=8;BYDAY=WE\n"),
    "offsite": ics("offsite@example.test", "Offsite", "DTSTART;VALUE=DATE:20261015", "DTEND;VALUE=DATE:20261016"),
    "review": ics("review@example.test", "Review meeting", "DTSTART:20261016T090000Z", "DTEND:20261016T100000Z",
                  "ORGANIZER;CN=Alice Example:mailto:alice@example.test\n"
                  "ATTENDEE;CN=Alice Example;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:alice@example.test\n"
                  "ATTENDEE;CN=Bob Builder;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:bob@example.test\nSEQUENCE:0\n"),
    "month": ics("month@example.test", "Budget talk", "DTSTART:20261020T080000Z", "DTEND:20261020T090000Z"),
    "pointer": ics("pointer@example.test", "Pointer test", "DTSTART:20261012T090000Z", "DTEND:20261012T093000Z"),
}


def vevents(summary=None, uid=None):
    """The VEVENT blocks on the server, of one event (by UID or SUMMARY)."""
    out = []
    for text in env.caldav_events():
        text = text.replace("\r\n ", "").replace("\r", "")
        for b in re.findall(r"BEGIN:VEVENT\n(.*?)END:VEVENT", text, re.S):
            if (uid and f"UID:{uid}\n" in b) or (summary and f"SUMMARY:{summary}\n" in b):
                out.append(b)
    return out


def prop(block, name):
    m = re.search(rf"^{name}(;[^:\n]*)?:(.*)$", block, re.M)
    return m.group(2).strip() if m else None


def has(uid, checks, timeout=40):
    """Wait until the event's master VEVENT has these property values."""
    def ok():
        for b in vevents(uid=uid):
            if "RECURRENCE-ID" in b:
                continue
            if all(prop(b, k) == v for k, v in checks.items()):
                return b
        return None
    return wait(ok, timeout)


def ev_sel(kind="grid"):
    return {"grid": "#module-calendar .tg-col .ev", "allday": "#module-calendar .tg-allcell .ev", "month": "#module-calendar .mg-ev"}[kind]


def drawn(title, kind="grid"):
    return env.wait_ui("count", lambda n: n > 0, selector=ev_sel(kind) + f'[title^="{title}"]', timeout=40)


def answer(label, timeout=20):
    env.wait_ui("count", lambda n: n > 0, selector=".modal .btn", timeout=timeout)
    title = env.ui("text", selector=".modal .modal-title")
    env.ui("button", label=label)
    return title[0] if title else ""


def col(day):
    """The day grid's column of an October day (Work Week, 12-16)."""
    return f'#module-calendar .tg-col[data-day="{env.dayms[day]}"]'


try:
    env.start_servers()
    for k, v in EVENTS.items():
        st, _ = env.dav("PUT", f"/alice@example.test/work/{k}.ics", v, headers={"Content-Type": "text/calendar"})
        assert st in (201, 204), st
    env.make_profile()
    env.start_thunderbird(hold_calendar=True)
    env.caldav_id = env.add_caldav_calendar()
    env.wait_ui("ping", lambda r: r["ready"], timeout=60)
    env.ui("click", selector="#nav-calendar")
    env.wait_ui("calendar", lambda r: any(c["name"] == "Work" for c in r["calendars"]), timeout=60)
    env.ui("calendarView", view="workweek")
    env.ui("calendarDate", y=2026, m=10, d=13)
    env.wait_ui("calendar", lambda r: {"Planning", "Weekly sync", "Offsite", "Review meeting", "Pointer test"} <= {e["title"] for e in r["events"]}, timeout=90)
    import datetime
    env.dayms = {d: int(datetime.datetime(2026, 10, d, tzinfo=datetime.timezone.utc).timestamp() * 1000) for d in range(1, 32)}

    # ---- move: Tuesday 10:00 -> Wednesday 11:00 ----
    drawn("Planning")
    env.ui("drag", selector=ev_sel() + '[title^="Planning"]', fy=0.3, to={"selector": col(14), "fy": 0, "py": 10.3 * 2 * SLOT + 2 * SLOT})
    b = has("planning@example.test", {"DTSTART": "20261014T110000Z", "DTEND": "20261014T120000Z"})
    g.check(b is not None, "an appointment dragged to Wednesday, an hour later: 11:00-12:00 on the server", vevents(uid="planning@example.test"))
    d = env.wait_ui("calendar", lambda r: any(e["title"] == "Planning" and e["start"] == env.dayms[14] + 11 * 3600000 for e in r["events"]), timeout=20)
    g.check(True, "and drawn there")

    # ---- resize: the bottom edge half an hour down, the top edge half an hour up ----
    drawn("Planning")
    env.ui("drag", selector=ev_sel() + '[title^="Planning"]', inner=".ev-handle.end", dy=SLOT)
    g.check(has("planning@example.test", {"DTSTART": "20261014T110000Z", "DTEND": "20261014T123000Z"}) is not None,
            "its bottom edge dragged: it ends at 12:30, its start kept", vevents(uid="planning@example.test"))
    env.wait_ui("calendar", lambda r: any(e["title"] == "Planning" and e["end"] == env.dayms[14] + 12.5 * 3600000 for e in r["events"]), timeout=20)
    env.ui("drag", selector=ev_sel() + '[title^="Planning"]', inner=".ev-handle.start", dy=-SLOT)
    g.check(has("planning@example.test", {"DTSTART": "20261014T103000Z", "DTEND": "20261014T123000Z"}) is not None,
            "its top edge dragged: it starts at 10:30, its end kept", vevents(uid="planning@example.test"))

    # ---- an occurrence of a weekly series: the prompt ----
    drawn("Weekly sync")
    env.ui("drag", selector=ev_sel() + '[title^="Weekly sync"]', fy=0.5, to={"selector": col(15), "fy": 0, "py": 14.25 * 2 * SLOT})
    t = answer("Cancel")
    g.check(t == "Change Repeating Item", "dragging an occurrence of a series asks: this one or the series", t)
    time.sleep(2)
    b = vevents(uid="sync@example.test")
    g.check(len(b) == 1 and prop(b[0], "DTSTART") == "20261007T140000Z", "Cancel changes nothing", b)
    drawn("Weekly sync")
    env.ui("drag", selector=ev_sel() + '[title^="Weekly sync"]', fy=0.5, to={"selector": col(15), "fy": 0, "py": 14.25 * 2 * SLOT})
    answer("Just this one")

    def exception():
        for x in vevents(uid="sync@example.test"):
            if prop(x, "RECURRENCE-ID") == "20261014T140000Z":
                return x
        return None
    x = wait(exception)
    g.check(x is not None and prop(x, "DTSTART") == "20261015T140000Z" and prop(x, "DTEND") == "20261015T143000Z",
            "Just this one: that occurrence moves to Thursday (an exception to the series)", vevents(uid="sync@example.test"))
    m = has("sync@example.test", {"DTSTART": "20261007T140000Z"}, 5)
    g.check(m is not None and "BYDAY=WE" in (prop(m, "RRULE") or ""), "the series stays on Wednesdays at 14:00", vevents(uid="sync@example.test"))
    d = env.wait_ui("calendar", lambda r: any(e["title"] == "Weekly sync" and e["start"] == env.dayms[15] + 14 * 3600000 for e in r["events"]), timeout=20)
    g.check(not any(e["title"] == "Weekly sync" and e["start"] == env.dayms[14] + 14 * 3600000 for e in d["events"]), "drawn on Thursday, not Wednesday")

    # the entire series, a week later: Wednesday the 21st -> Thursday, an hour later
    env.ui("calendarDate", y=2026, m=10, d=20)
    env.wait_ui("calendar", lambda r: any(e["title"] == "Weekly sync" for e in r["events"]), timeout=30)
    drawn("Weekly sync")
    env.ui("drag", selector=ev_sel() + '[title^="Weekly sync"]', fy=0.5, to={"selector": col(22), "fy": 0, "py": 15.25 * 2 * SLOT})
    answer("The entire series")
    m = has("sync@example.test", {"DTSTART": "20261008T150000Z", "DTEND": "20261008T153000Z"})
    g.check(m is not None, "The entire series: it all moves a day and an hour (from the 8th, 15:00)", vevents(uid="sync@example.test"))
    g.check(m is not None and "BYDAY=TH" in (prop(m, "RRULE") or "") and "COUNT=8" in (prop(m, "RRULE") or ""),
            "a weekly series follows to Thursdays, its count kept", m)
    d = env.wait_ui("calendar", lambda r: any(e["title"] == "Weekly sync" and e["start"] == env.dayms[22] + 15 * 3600000 for e in r["events"]), timeout=20)
    g.check(True, "and is drawn on Thursday at 15:00")

    # ---- all day: stretched to Friday, then moved two days back ----
    env.ui("calendarDate", y=2026, m=10, d=13)
    drawn("Offsite", "allday")
    env.ui("drag", selector=ev_sel("allday") + '[title^="Offsite"]', inner=".ev-handle.end",
           to={"selector": f'#module-calendar .tg-allcell[data-day="{env.dayms[16]}"]', "fx": 0.5})
    g.check(has("offsite@example.test", {"DTSTART": "20261015", "DTEND": "20261017"}) is not None,
            "an all-day event's right end dragged to Friday: two days", vevents(uid="offsite@example.test"))
    env.wait_ui("calendar", lambda r: any(e["title"] == "Offsite" and e["end"] == env.dayms[17] for e in r["events"]), timeout=20)
    drawn("Offsite", "allday")
    env.ui("drag", selector=ev_sel("allday") + '[title^="Offsite"]', index=0, fx=0.3,
           to={"selector": f'#module-calendar .tg-allcell[data-day="{env.dayms[13]}"]', "fx": 0.5})
    g.check(has("offsite@example.test", {"DTSTART": "20261013", "DTEND": "20261015"}) is not None,
            "moved in the all-day row: Tuesday and Wednesday", vevents(uid="offsite@example.test"))

    # ---- a meeting of Alice's: Send Update ----
    drawn("Review meeting")
    env.ui("drag", selector=ev_sel() + '[title^="Review meeting"]', fy=0.4, dy=2 * SLOT)
    t = answer("Send Update")
    g.check(t == "Send Update", "dragging a meeting she organizes asks to send the attendees an update", t)
    g.check(has("review@example.test", {"DTSTART": "20261016T100000Z", "DTEND": "20261016T110000Z"}) is not None, "the meeting moves to 10:00")
    mail = wait(lambda: next((x for x in env.smtp_messages() if "Review meeting" in x["raw"] and "20261016T100000Z" in x["raw"].replace("\r\n ", "")), None), 60)
    g.check(mail is not None and mail["rcpt"] == ["bob@example.test"] and "METHOD:REQUEST" in mail["raw"],
            "Bob is mailed the new time (an iCalendar REQUEST)", [x["rcpt"] for x in env.smtp_messages()])

    # ---- drag to create: 13:00-14:30 on Monday, typed in place ----
    env.ui("drag", selector=col(12), fy=0, py=13 * 2 * SLOT + 4, to={"selector": col(12), "fy": 0, "py": 14 * 2 * SLOT + 4})
    env.ui("key", selector="#module-calendar", key="Q")
    env.wait_ui("count", lambda n: n == 1, selector="#module-calendar .ev-draft .ev-input", timeout=10)
    g.check(env.ui("value", selector=".ev-draft .ev-input") == "Q", "time dragged out and typed on: a new appointment, written in place")
    env.ui("type", selector=".ev-draft .ev-input", value="Quick sync")
    env.ui("key", selector=".ev-draft .ev-input", key="Enter")
    b = wait(lambda: vevents(summary="Quick sync"))
    g.check(bool(b) and prop(b[0], "DTSTART") == "20261012T130000Z" and prop(b[0], "DTEND") == "20261012T143000Z",
            "Enter saves it for the time dragged: 13:00-14:30", b)
    # Escape drops one
    env.ui("drag", selector=col(13), fy=0, py=16 * 2 * SLOT + 4, to={"selector": col(13), "fy": 0, "py": 16 * 2 * SLOT + 8})
    env.ui("key", selector="#module-calendar", key="X")
    env.wait_ui("count", lambda n: n == 1, selector="#module-calendar .ev-draft .ev-input", timeout=10)
    env.ui("type", selector=".ev-draft .ev-input", value="Not this")
    env.ui("key", selector=".ev-draft .ev-input", key="Escape")
    time.sleep(2)
    g.check(not vevents(summary="Not this") and env.ui("count", selector=".ev-draft") == 0, "Escape drops it")
    # Enter on picked time: the appointment window, for that time
    env.ui("drag", selector=col(16), fy=0, py=8 * 2 * SLOT + 4, to={"selector": col(16), "fy": 0, "py": 8 * 2 * SLOT + SLOT + 4})
    env.ui("key", selector="#module-calendar", key="Enter")
    w = env.wait_ui("dump", lambda r: True, target="event", timeout=30)
    g.check(w.get("start") == "2026-10-16 08:00" and w.get("end") == "2026-10-16 09:00",
            "Enter on picked time opens a new appointment for 8:00-9:00", {k: w.get(k) for k in ("start", "end", "windowTitle")})
    env.ui("close", target="event")
    time.sleep(1)

    # ---- the real pointer (X events, xdotool): Pointer test 9:00 -> 10:00 ----
    env.ui("calendarView", view="day")
    env.ui("calendarDate", y=2026, m=10, d=12)
    drawn("Pointer test")
    X = dict(os.environ, DISPLAY=":91")
    env.chrome("""const w = Services.wm.getMostRecentWindow("mail:3pane"); w.focus(); return true;""")
    p = env.ui("screenPoint", selector=ev_sel() + '[title^="Pointer test"]', fy=0.5)
    sh = lambda *a: subprocess.run(["xdotool", *map(str, a)], env=X, capture_output=True)
    sh("mousemove", p["x"], p["y"]); time.sleep(0.3)
    sh("mousedown", 1); time.sleep(0.2)
    for i in range(1, 9):
        sh("mousemove", p["x"], p["y"] + i * 6); time.sleep(0.08)
    sh("mouseup", 1)
    g.check(has("pointer@example.test", {"DTSTART": "20261012T100000Z", "DTEND": "20261012T103000Z"}) is not None,
            "a real mouse drag (X pointer events) moves it an hour", vevents(uid="pointer@example.test"))

    # ---- Month: to a day of the next week, then stretched ----
    env.ui("calendarView", view="month")
    env.ui("calendarDate", y=2026, m=10, d=20)
    drawn("Budget talk", "month")
    env.ui("drag", selector=ev_sel("month") + '[title^="Budget talk"]', fx=0.3,
           to={"selector": f'#module-calendar .mg-day[data-day="{env.dayms[29]}"]', "fx": 0.5, "fy": 0.6})
    g.check(has("month@example.test", {"DTSTART": "20261029T080000Z", "DTEND": "20261029T090000Z"}) is not None,
            "Month: dragged to Thursday of the next week, its time kept", vevents(uid="month@example.test"))
    env.wait_ui("calendar", lambda r: any(e["title"] == "Budget talk" and e["start"] == env.dayms[29] + 8 * 3600000 for e in r["events"]), timeout=20)
    drawn("Budget talk", "month")
    env.ui("drag", selector=ev_sel("month") + '[title^="Budget talk"]', inner=".ev-handle.end",
           to={"selector": f'#module-calendar .mg-day[data-day="{env.dayms[30]}"]', "fx": 0.5, "fy": 0.6})
    g.check(has("month@example.test", {"DTSTART": "20261029T080000Z", "DTEND": "20261030T090000Z"}) is not None,
            "its right end dragged to Friday: it ends there", vevents(uid="month@example.test"))
    # days dragged out in Month and typed on: an all-day event
    env.ui("drag", selector=f'#module-calendar .mg-day[data-day="{env.dayms[26]}"]', fy=0.8,
           to={"selector": f'#module-calendar .mg-day[data-day="{env.dayms[28]}"]', "fy": 0.8})
    env.ui("key", selector="#module-calendar", key="C")
    env.wait_ui("count", lambda n: n == 1, selector="#module-calendar .ev-draft .ev-input", timeout=10)
    env.ui("type", selector=".ev-draft .ev-input", value="Conference")
    env.ui("key", selector=".ev-draft .ev-input", key="Enter")
    b = wait(lambda: vevents(summary="Conference"))
    g.check(bool(b) and prop(b[0], "DTSTART") == "20261026" and prop(b[0], "DTEND") == "20261029",
            "Month: three days dragged out and typed on: an all-day event over them", b)
    time.sleep(1.5)
    env.screenshot(os.path.join(env.dir, "caldrag.png"))
finally:
    env.stop()
sys.exit(g.result())
