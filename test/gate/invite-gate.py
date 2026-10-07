"""Gate: a meeting request received. Bob invites Alice (an iCalendar
REQUEST by mail): SG Mail's reading pane shows the meeting's time and place
with Accept, Tentative and Decline; Accept puts it in her calendar and
sends Bob the answer (an iCalendar REPLY, PARTSTAT=ACCEPTED). With two calendars it
could go in, the reading pane offers the choice (the account's first)
instead of Thunderbird's dialog. A second
invitation declined: Bob gets PARTSTAT=DECLINED.

Mutants (test/mutants.json): invite-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message  # noqa: E402

g = Gate("invite")
env = Env("invite")


def request(uid, summary, start, end):
    return f"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SG Mail gate//EN
METHOD:REQUEST
BEGIN:VEVENT
UID:{uid}
DTSTAMP:20261001T080000Z
DTSTART:{start}
DTEND:{end}
SUMMARY:{summary}
LOCATION:Room 4
ORGANIZER;CN=Bob Builder:mailto:bob@example.test
ATTENDEE;CN=Bob Builder;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:bob@example.test
ATTENDEE;CN=Alice Example;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;ROLE=REQ-PARTICIPANT:mailto:alice@example.test
SEQUENCE:0
END:VEVENT
END:VCALENDAR
"""


def wait(fn, timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


try:
    env.start_servers()
    env.append("INBOX", message("Bob Builder <bob@example.test>", "Alice Example <alice@example.test>", "Invitation: Budget planning",
                                text="Please join the budget planning.", calendar=(request("budget-1@example.test", "Budget planning", "20261020T130000Z", "20261020T140000Z"), "REQUEST")))
    env.append("INBOX", message("Bob Builder <bob@example.test>", "Alice Example <alice@example.test>", "Invitation: Late call",
                                text="A late call.", calendar=(request("late-1@example.test", "Late call", "20261021T200000Z", "20261021T210000Z"), "REQUEST")))
    env.make_profile()
    env.start_thunderbird(hold_calendar=True)
    env.caldav_id = env.add_caldav_calendar()
    env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 2, timeout=90)
    env.ui("click", selector="#nav-calendar")
    env.wait_ui("calendar", lambda r: any(c["name"] == "Work" for c in r["calendars"]), timeout=60)
    env.ui("click", selector="#nav-mail")
    # a second calendar it could go in (this computer's): Thunderbird would
    # stop to ask in a dialog; SG Mail's reading pane offers the choice
    env.chrome("""
      const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
      if (!cal.manager.getCalendars().some(c => c.type == "storage" && !c.getProperty("disabled"))) {
        const c = cal.manager.createCalendar("storage", Services.io.newURI("moz-storage-calendar://"));
        c.name = "Calendar"; c.setProperty("imip.identity.key", "id1"); cal.manager.registerCalendar(c);
      }
      return true;""")

    env.ui("selectMessage", subject="Invitation: Budget planning")
    try:
        d = env.wait_ui("mail", lambda r: r["reader"].get("invite") is not None, timeout=40)
    except TimeoutError as e:
        g.check(False, "the reading pane shows the meeting request", str(e)[-300:])
        raise
    inv = d["reader"]["invite"]
    g.check(inv["method"] == "REQUEST", "the reading pane knows it for a meeting request", inv)
    g.check(all(a in inv["actions"] for a in ("accept", "tentative", "decline")), "with Accept, Tentative and Decline", inv["actions"])
    choice = env.ui("text", selector="#invite-calendar option")
    g.check(choice[:1] == ["Work"] and "Calendar" in choice, "two calendars: the reading pane offers both, the account's first", choice)
    shown = env.ui("text", selector="#rp-invite")
    g.check(shown and "Room 4" in shown[0], "it shows where the meeting is", shown)
    env.ui("click", selector="#invite-accept")
    m = wait(lambda: next((x for x in env.smtp_messages() if "Budget planning" in x["raw"] and "METHOD:REPLY" in x["raw"].replace("\r", "")), None), 60)
    g.check(m is not None, "Accept sends Bob an iCalendar REPLY")
    if m:
        raw = m["raw"].replace("\r\n ", "").replace("\r", "")
        g.check(m["rcpt"] == ["bob@example.test"], "to the organizer", m["rcpt"])
        g.check("PARTSTAT=ACCEPTED" in raw and "alice@example.test" in raw, "saying Alice accepted", raw[-900:])
    g.check(wait(lambda: any("SUMMARY:Budget planning" in e for e in env.caldav_events()), 40), "the meeting is in Alice's calendar")
    env.ui("click", selector="#nav-calendar")
    env.ui("calendarDate", y=2026, m=10, d=20)
    d = env.wait_ui("calendar", lambda r: any(e["title"] == "Budget planning" for e in r["events"]), timeout=40)
    ev = [e for e in d["events"] if e["title"] == "Budget planning"][0]
    g.check(ev["myStatus"] == "ACCEPTED", "as accepted", ev)
    env.screenshot(os.path.join(env.dir, "invite-calendar.png"))
    env.ui("click", selector="#nav-mail")

    env.ui("selectMessage", subject="Invitation: Late call")
    env.wait_ui("mail", lambda r: (r["reader"].get("invite") or {}).get("actions"), timeout=40)
    env.screenshot(os.path.join(env.dir, "invite.png"))
    env.ui("click", selector="#invite-decline")
    m = wait(lambda: next((x for x in env.smtp_messages() if "Late call" in x["raw"] and "METHOD:REPLY" in x["raw"].replace("\r", "")), None), 60)
    g.check(m is not None and "PARTSTAT=DECLINED" in m["raw"].replace("\r\n ", ""), "Decline answers DECLINED", m["raw"][-600:] if m else None)
finally:
    env.stop()
sys.exit(g.result())
