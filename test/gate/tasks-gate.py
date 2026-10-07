"""Gate: Tasks and the To-Do List. Ctrl+4 shows Tasks: the To-Do List has
the tasks of the calendars (here a CalDAV calendar's, a task already on the
server among them, overdue) and the flagged mail, grouped by when they are
due. "Type a new task" adds one due today; New Task's window sets the due
day, status, priority and notes -- each a VTODO on the CalDAV server. Mark
Complete completes a task (COMPLETED on the server; out of the Active view,
in Completed) and, for flagged mail, clears the flag on the IMAP server.
Follow Up > Tomorrow gives flagged mail its due day; Mail's Follow Up >
This Week flags a message into the list. The To-Do Bar beside the mail
lists what is due and takes new tasks; it is remembered. Delete deletes a
task from the server.

Mutants (test/mutants.json): tasks-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import datetime
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message  # noqa: E402

g = Gate("tasks")
env = Env("tasks")
SHOTS = os.environ.get("SG_MAIL_SHOTS") or os.path.join(env.dir, "shots")
os.makedirs(SHOTS, exist_ok=True)
ALICE = "Alice Example <alice@example.test>"


def wait(fn, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def todo(summary):
    """The VTODO with this SUMMARY on the CalDAV server, unfolded."""
    for ics in env.caldav_events():
        text = ics.replace("\r\n ", "").replace("\n ", "")
        if "BEGIN:VTODO" in text and f"SUMMARY:{summary}" in text:
            return text
    return None


def flags(subject, box="INBOX"):
    for f, raw in env.mailbox(box):
        if f"\r\nSubject: {subject}\r\n".encode() in b"\r\n" + raw:
            return f
    return None


def items(d):
    return {x["title"]: x for x in d["items"]}


def day(offset=0):
    d = datetime.date.today() + datetime.timedelta(days=offset)
    return d.strftime("%Y%m%d"), d.isoformat()


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
    # a task already on the server, due yesterday
    y, _ = day(-1)
    ics = ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//gate//EN\r\nBEGIN:VTODO\r\nUID:venue-1\r\nDTSTAMP:20260101T000000Z\r\n"
           f"SUMMARY:Book the venue\r\nDUE;VALUE=DATE:{y}\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n")
    st, _ = env.dav("PUT", "/alice@example.test/work/venue-1.ics", ics, headers={"Content-Type": "text/calendar; charset=utf-8"})
    g.check(st in (201, 204), "(a task on the CalDAV server)", st)
    env.append("INBOX", message("Pradeep Gupta <pradeep@example.test>", ALICE, "Invoice 77", text="Please pay by Friday."), flagged=True)
    env.append("INBOX", message("Lee Gu <lee@example.test>", ALICE, "Slides for Monday", text="Can you review them?"))
    env.make_profile()
    env.start_thunderbird(hold_calendar=True)
    env.caldav_id = env.add_caldav_calendar()
    env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 1, timeout=90)

    env.ui("key", selector="#message-list", key="4", ctrl=True)
    d = env.wait_ui("tasks", lambda r: "Book the venue" in items(r) and "Invoice 77" in items(r), timeout=60)
    it = items(d)
    g.check(d["scope"] == "todo" and "To-Do List" in env.ui("text", selector="#tk-title")[0], "Ctrl+4: Tasks, the To-Do List")
    g.check(it["Book the venue"]["kind"] == "task" and it["Book the venue"]["group"] == "Overdue", "the server's task, overdue", it["Book the venue"])
    g.check(it["Invoice 77"]["kind"] == "mail" and it["Invoice 77"]["group"] == "No Date", "flagged mail in the To-Do List", it["Invoice 77"])

    # ---- Type a new task ----
    env.ui("type", selector="#tk-new", value="Call the printer company")
    env.ui("key", selector="#tk-new", key="Enter")
    t = wait(lambda: todo("Call the printer company"))
    g.check(t is not None and f"DUE;VALUE=DATE:{day(0)[0]}" in t, "Type a new task: a task due today, on the CalDAV server", t)
    d = env.wait_ui("tasks", lambda r: "Call the printer company" in items(r), timeout=30)
    g.check(items(d)["Call the printer company"]["group"] == "Today", "listed under Today")

    # ---- New Task ----
    env.ui("click", selector="#rb-new-task")
    env.wait_ui("count", lambda n: n == 1, selector=".modal #tk-f-title", timeout=10)
    env.ui("type", selector=".modal #tk-f-title", value="Write the report")
    env.ui("type", selector=".modal #tk-f-due", value=day(1)[1])
    env.ui("selectOption", selector=".modal #tk-f-status", index=1)
    env.ui("selectOption", selector=".modal #tk-f-priority", index=2)
    env.ui("type", selector=".modal #tk-f-notes", value="Numbers from finance.")
    env.ui("button", label="Save & Close")
    t = wait(lambda: todo("Write the report"))
    g.check(t is not None and f"DUE;VALUE=DATE:{day(1)[0]}" in t and "STATUS:IN-PROCESS" in t and "PRIORITY:1" in t and "DESCRIPTION:Numbers from finance." in t,
            "New Task: due tomorrow, In Progress, High, its notes -- on the server", t)
    d = env.wait_ui("tasks", lambda r: "Write the report" in items(r), timeout=30)
    g.check(items(d)["Write the report"]["group"] == "Tomorrow", "listed under Tomorrow")
    g.check("In Progress" in d["detail"] and "High" in d["detail"], "its details beside the list", d["detail"][:300])
    time.sleep(1)
    env.screenshot(os.path.join(SHOTS, "sg-mail-tasks-light.png"))

    # ---- Mark Complete ----
    env.ui("click", selector='.tk-row[data-key$="|venue-1"]')
    env.ui("click", selector="#rb-mark-complete")
    t = wait(lambda: (lambda x: x if x and "STATUS:COMPLETED" in x else None)(todo("Book the venue")))
    g.check(t is not None and "COMPLETED:" in t and "PERCENT-COMPLETE:100" in t, "Mark Complete: COMPLETED on the server", t)
    d = env.wait_ui("tasks", lambda r: "Book the venue" not in items(r), timeout=30)
    g.check(True, "and out of the Active list")
    env.ui("click", selector="#tk-filter")
    env.ui("menu", label="Completed")
    d = env.wait_ui("tasks", lambda r: r["filter"] == "completed", timeout=10)
    g.check(list(items(d)) == ["Book the venue"] and items(d)["Book the venue"]["completed"], "Completed: the task done", list(items(d)))
    env.ui("click", selector="#tk-filter")
    env.ui("menu", label="Active")

    # ---- flagged mail: Follow Up and Mark Complete ----
    env.ui("click", selector='.tk-row[data-key^="m:"]')
    env.ui("click", selector="#rb-fu-tomorrow")
    d = env.wait_ui("tasks", lambda r: items(r).get("Invoice 77", {}).get("group") == "Tomorrow", timeout=20)
    g.check(True, "Follow Up > Tomorrow: the flagged message due tomorrow")
    env.ui("click", selector="#rb-mark-complete")
    g.check(wait(lambda: "\\Flagged" not in (flags("Invoice 77") or "\\Flagged")), "Mark Complete on flagged mail: the flag cleared on the server", flags("Invoice 77"))
    env.wait_ui("tasks", lambda r: "Invoice 77" not in items(r), timeout=20)

    # ---- Mail: Follow Up > This Week ----
    env.ui("click", selector="#nav-mail")
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-focused-inbox")
    env.wait_ui("mail", lambda r: r["focused"] is None, timeout=20)
    env.ui("selectMessage", subject="Slides for Monday")
    env.ui("click", selector='.ribbon-tab[data-tab="home"]')
    env.ui("click", selector="#rb-follow-up .caret")
    env.ui("menu", label="This Week")
    g.check(wait(lambda: "\\Flagged" in (flags("Slides for Monday") or "")), "Mail's Follow Up > This Week flags the message")
    d = env.wait_ui("tasks", lambda r: "Slides for Monday" in items(r), timeout=30)
    g.check(items(d)["Slides for Monday"]["due"] is not None, "into the To-Do List, due this week", items(d)["Slides for Monday"])

    # ---- the To-Do Bar ----
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-todo-bar")
    env.ui("menu", label="Tasks")
    d = env.wait_ui("tasks", lambda r: r["todoBar"] and "Write the report" in r["todoBar"], timeout=20)
    g.check(env.ui("rect", selector="#todo-bar")["shown"] and env.ui("rect", selector="#todo-bar")["left"] > env.ui("rect", selector="#reading-pane")["left"],
            "View > To-Do Bar: the tasks beside the mail", d["todoBar"])
    env.ui("type", selector="#todo-new", value="Order toner")
    env.ui("key", selector="#todo-new", key="Enter")
    g.check(wait(lambda: todo("Order toner")), "a task typed in the To-Do Bar")
    env.wait_ui("tasks", lambda r: "Order toner" in (r["todoBar"] or []), timeout=20)
    restart()
    d = env.wait_ui("tasks", lambda r: r["todoBar"] and "Order toner" in r["todoBar"], timeout=60)
    g.check(env.ui("rect", selector="#todo-bar")["shown"], "the To-Do Bar is remembered")
    env.ui("click", selector="#nav-calendar")
    g.check(not env.ui("rect", selector="#todo-bar")["shown"], "(it is the mail's: not beside the calendar)")
    env.ui("click", selector="#nav-mail")

    # ---- Delete ----
    env.ui("click", selector="#nav-tasks")
    env.wait_ui("tasks", lambda r: "Call the printer company" in items(r), timeout=30)
    key = next(k["key"] for k in env.ui("tasks")["items"] if k["title"] == "Call the printer company")
    env.ui("click", selector=f'.tk-row[data-key="{key}"]')
    env.ui("key", selector="#tk-list", key="Delete")
    env.ui("button", label="Delete")
    g.check(wait(lambda: todo("Call the printer company") is None), "Delete: the task gone from the server")
finally:
    env.stop()
sys.exit(g.result())
