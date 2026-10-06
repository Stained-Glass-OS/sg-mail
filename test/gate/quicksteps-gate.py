"""Gate: Quick Steps. The Home tab has the classic ones: Move to: ?, To
Manager, Team Email, Done, Reply & Delete, and Create New. A step that
needs a folder or an address asks for it the first time (First Time Setup)
and then runs at once: Move to a folder (named after it from then on, the
message read and moved on the server), To Manager (a forward to the
address given), Done (flag cleared, read, moved), Reply & Delete (the reply
opens with the original read into it, the original goes to Deleted Items,
and the reply still sends). Create New: a step of one's own (Categorize and
Flag here) with its key, Ctrl+Shift+3, which runs it. Manage Quick Steps:
one deleted. All remembered when SG Mail starts again.

Mutants (test/mutants.json): qs-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message  # noqa: E402

g = Gate("quicksteps")
env = Env("quicksteps", with_caldav=False)
ALICE = "Alice Example <alice@example.test>"


def wait(fn, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def flags(subject, box="INBOX"):
    for f, raw in env.mailbox(box):
        if f"\r\nSubject: {subject}\r\n".encode() in b"\r\n" + raw:
            return f
    return None


def compose_open(cond=lambda r: True, timeout=40):
    return env.wait_ui("dump", cond, target="compose", timeout=timeout)


def compose_gone(timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            env.ui("dump", target="compose", timeout_ms=4000)
        except Exception:
            return True
        time.sleep(0.5)
    return False


def close_compose():
    env.ui("close", target="compose")
    if not compose_gone(5):
        env.ui("button", target="compose", label="Don't Save")
    compose_gone()


def labels():
    return [t.strip() for t in env.ui("text", selector='.ribbon-group[data-group="Quick Steps"] .rb-label') if t.strip()]


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
    now = time.time()
    for i, (frm, subj, seen, flagged) in enumerate([
            ("Nestor Wilke <nestor@example.test>", "Old news", False, False),
            ("Lee Gu <lee@example.test>", "Bug 42", False, False),
            ("Megan Bowen <megan@example.test>", "Weekly report", True, False),
            ("Megan Bowen <megan@example.test>", "Status?", True, False),
            ("Lee Gu <lee@example.test>", "Fix the printer", False, True),
            ("Joni Sherman <joni@example.test>", "Team lunch", True, False)]):
        t = now - 600 * (i + 1)
        env.append("INBOX", message(frm, ALICE, subj, text=f"{subj}: text.", date=t, msgid=f"<qs{i}@x.test>"), seen=seen, flagged=flagged, date=t)
    env.append("Projects", message("Lee Gu <lee@example.test>", ALICE, "Kickoff", text="x"), seen=True)
    env.make_profile()
    env.start_thunderbird()
    env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 1, timeout=90)
    env.ui("click", selector='.ribbon-tab[data-tab="view"]')
    env.ui("click", selector="#rb-focused-inbox")
    env.wait_ui("mail", lambda r: r["focused"] is None and len([x for x in r["list"] if "id" in x]) == 6, timeout=30)
    env.ui("click", selector='.ribbon-tab[data-tab="home"]')
    g.check(labels() == ["Move to: ?", "To Manager", "Team Email", "Done", "Reply & Delete", "Create New"],
            "Home > Quick Steps: the classic ones and Create New", labels())

    # ---- Move to: ? (First Time Setup, then at once) ----
    env.ui("selectMessage", subject="Old news")
    env.ui("click", selector="#rb-qs-move")
    env.wait_ui("count", lambda n: n == 1, selector=".modal .qs-folder", timeout=10)
    g.check(env.ui("text", selector=".modal .modal-title") == ["First Time Setup"], "the first time: First Time Setup asks for the folder")
    opts = env.ui("text", selector=".modal .qs-folder option")
    proj = next(i for i, t in enumerate(opts) if t.startswith("Projects"))
    env.ui("selectOption", selector=".modal .qs-folder", index=proj)
    env.ui("button", label="Save")
    g.check(wait(lambda: flags("Old news", "Projects") is not None and flags("Old news") is None),
            "then it runs: the message moves to Projects on the server")
    g.check("\\Seen" in (flags("Old news", "Projects") or ""), "and is read (the step's second action)", flags("Old news", "Projects"))
    g.check("Projects" in labels() and "Move to: ?" not in labels(), "the step is named after its folder", labels())
    env.ui("selectMessage", subject="Bug 42")
    env.ui("click", selector="#rb-qs-move")
    g.check(wait(lambda: flags("Bug 42", "Projects") is not None), "used again: no questions, it moves")
    g.check(env.ui("count", selector=".modal") == 0, "(no dialog the second time)")

    # ---- To Manager ----
    env.ui("selectMessage", subject="Weekly report")
    env.ui("click", selector="#rb-qs-manager")
    env.wait_ui("count", lambda n: n == 1, selector=".modal .qs-to", timeout=10)
    env.ui("type", selector=".modal .qs-to", value="Pat Boss <pat@example.test>")
    env.ui("button", label="Save")
    d = compose_open(lambda r: r["mode"] == "forward" and r["to"])
    g.check(d["subject"] == "FW: Weekly report" and d["to"] == "Pat Boss <pat@example.test>", "To Manager: a forward to the manager", (d["subject"], d["to"]))
    close_compose()

    # ---- Reply & Delete ----
    env.ui("selectMessage", subject="Status?")
    env.ui("click", selector="#rb-qs-replydelete")
    d = compose_open(lambda r: r["mode"] == "reply" and "Status?: text." in r["body"])
    g.check(d["subject"] == "RE: Status?" and "Megan Bowen" in d["to"], "Reply & Delete: the reply, the original quoted in it", (d["subject"], d["to"]))
    g.check(wait(lambda: flags("Status?", "Trash") is not None and flags("Status?") is None), "and the original goes to Deleted Items")
    env.ui("type", target="compose", selector="#editor", value="All on track.", append=True)
    env.ui("send", target="compose")
    sent = wait(lambda: next((m for m in env.smtp_messages() if "RE: Status?" in m["raw"]), None), 40)
    g.check(sent is not None and "In-Reply-To: <qs3@x.test>" in sent["raw"], "the reply sends (threaded) though its original moved", sent["raw"][:400] if sent else None)

    # ---- Done ----
    env.ui("selectMessage", subject="Fix the printer")
    env.ui("click", selector="#rb-qs-done")
    env.wait_ui("count", lambda n: n == 1, selector=".modal .qs-folder", timeout=10)
    opts = env.ui("text", selector=".modal .qs-folder option")
    env.ui("selectOption", selector=".modal .qs-folder", index=next(i for i, t in enumerate(opts) if t.startswith("Archive")))
    env.ui("button", label="Save")
    f = wait(lambda: flags("Fix the printer", "Archive"))
    g.check(f is not None and "\\Seen" in f and "\\Flagged" not in f, "Done: the flag cleared, read, moved to Archive", f)

    # ---- Create New, with its key ----
    env.ui("click", selector="#rb-qs-create")
    env.wait_ui("count", lambda n: n == 1, selector=".modal #qs-name", timeout=10)
    env.ui("type", selector=".modal #qs-name", value="Important and flagged")
    types = env.ui("text", selector=".modal .qs-type option")
    env.ui("selectOption", selector=".modal .qs-type", index=types.index("Categorize message"))
    tags = env.ui("text", selector=".modal .qs-tag option")
    env.ui("selectOption", selector=".modal .qs-tag", index=tags.index("Important"))
    env.ui("click", selector=".modal #qs-add")
    types = env.ui("text", selector=".modal .qs-action:nth-child(2) .qs-type option")
    env.ui("selectOption", selector=".modal .qs-type", index=types.index("Flag message"), nth=1)
    keys = env.ui("text", selector=".modal #qs-key option")
    env.ui("selectOption", selector=".modal #qs-key", index=keys.index("Ctrl+Shift+3"))
    env.ui("button", label="Finish")
    env.wait_ui("count", lambda n: n == 0, selector=".modal", timeout=10)
    g.check("Important and flagged" in labels(), "Create New: the new step on the ribbon", labels())
    env.ui("selectMessage", subject="Team lunch")
    env.ui("key", selector="#message-list", key="#", code="Digit3", ctrl=True, shift=True)
    f = wait(lambda: (lambda x: x if x and "$label1" in x and "\\Flagged" in x else None)(flags("Team lunch")))
    g.check(f is not None, "Ctrl+Shift+3 runs it: categorized Important and flagged on the server", flags("Team lunch"))

    # ---- Manage Quick Steps: one deleted ----
    env.ui("click", selector="#rb-qs-manage")
    env.ui("menu", label="Manage Quick Steps…")
    env.wait_ui("count", lambda n: n >= 5, selector=".modal .qs-row", timeout=10)
    env.ui("click", selector='.modal .qs-row[data-id="team"] button[title="Delete"]')
    env.ui("button", label="OK")
    g.check("Team Email" not in labels(), "Manage Quick Steps: Team Email deleted", labels())

    restart()
    env.ui("click", selector='.ribbon-tab[data-tab="home"]')
    l = labels()
    g.check("Projects" in l and "Important and flagged" in l and "Team Email" not in l and "To Manager" in l,
            "after a restart: the steps as they were left", l)
    st = env.ui("quickSteps")
    mgr = next(s for s in st if s["name"] == "To Manager")
    g.check(mgr["actions"][0]["to"] == "Pat Boss <pat@example.test>", "To Manager keeps the manager's address", mgr)
    time.sleep(1)
    env.screenshot(os.path.join(env.dir, "quicksteps.png"))
finally:
    env.stop()
sys.exit(g.result())
