"""Gate: writing mail. SG Mail's message window: a new message (the ribbon's
New Email, and Ctrl+N), names completed from the address book, sent through
the account's SMTP server with a copy in Sent Items; Reply (Ctrl+R) quotes
the original under Outlook's header, threads it (In-Reply-To) and marks it
answered; Reply All addresses everyone but us; Forward carries the
attachments; Save (Ctrl+S) keeps a draft in Drafts; a mailto: link opens our
message window instead of Thunderbird's.

Mutants (test/mutants.json): compose-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message  # noqa: E402

g = Gate("compose")
env = Env("compose", with_caldav=False)


def wait(fn, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
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


def smtp_with(text, timeout=40):
    return wait(lambda: next((m for m in env.smtp_messages() if text in m["raw"]), None), timeout)


try:
    env.start_servers()
    env.append("INBOX", message("Bob Builder <bob@example.test>", "Alice Example <alice@example.test>", "Plans",
                                text="Shall we plan the trip on Friday?", cc="Carol Danvers <carol@example.test>",
                                msgid="<plans-1@example.test>"))
    env.append("INBOX", message("Carol Danvers <carol@example.test>", "alice@example.test", "Report",
                                text="The report is attached.", attachments=[("report.pdf", "application/pdf", b"%PDF-1.4 test report")]))
    env.make_profile()
    env.start_thunderbird()
    env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 2, timeout=90)
    # a contact in the address book, for completion
    env.chrome("""
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
      const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(Ci.nsIAbCard);
      card.displayName = "Dana Scully"; card.primaryEmail = "dana@example.test";
      book.addCard(card); return true;""")

    # ---- a new message
    env.ui("click", selector="#rb-new-email")
    d = compose_open()
    g.check(d["mode"] == "new" and d["from"] == "alice@example.test", "New Email opens a message from Alice", d)
    env.ui("type", target="compose", selector="#to", value="Dan")
    names = env.wait_ui("text", lambda r: r and any("dana@example.test" in t for t in r), target="compose", selector="#complete div", timeout=20)
    g.check(True, "typing a name offers the address book's match", names)
    env.ui("key", target="compose", selector="#to", key="Enter")
    d = env.wait_ui("dump", lambda r: "dana@example.test" in r["to"], target="compose", timeout=10)
    g.check(d["to"].startswith("Dana Scully <dana@example.test>"), "Enter takes it", d["to"])
    env.ui("type", target="compose", selector="#subject", value="Meeting notes")
    env.ui("type", target="compose", selector="#editor", value="Here are the notes from today.")
    d = env.ui("dump", target="compose")
    g.check(d["title"] == "Meeting notes - Message (HTML)", "the window is titled by its subject", d["title"])
    env.ui("click", target="compose", selector="#send")
    m = smtp_with("Meeting notes")
    g.check(m is not None, "Send hands it to the SMTP server")
    if m:
        g.check(m["auth"] == "alice@example.test" and m["rcpt"] == ["dana@example.test"], "as Alice, to Dana", (m["auth"], m["rcpt"]))
        raw = m["raw"]
        g.check("From: Alice Example <alice@example.test>" in raw, "From is Alice", raw[:600])
        g.check("multipart/alternative" in raw and "text/html" in raw and "text/plain" in raw, "HTML with a plain-text alternative", raw[:800])
        g.check("Here are the notes from today." in raw, "the text is in it")
    g.check(compose_gone(), "the message window closes once sent")
    sent = wait(lambda: [r for f, r in env.mailbox("Sent") if b"Meeting notes" in r], 30)
    g.check(bool(sent), "a copy is in Sent Items on the server")

    # ---- Ctrl+N
    env.ui("key", selector="#message-list", key="n", ctrl=True)
    d = compose_open()
    g.check(d["mode"] == "new", "Ctrl+N opens a new message")
    env.ui("close", target="compose")
    g.check(compose_gone(), "an untouched message closes without asking")

    # ---- Reply
    env.ui("selectMessage", subject="Plans")
    env.ui("key", selector="#message-list", key="r", ctrl=True)
    d = compose_open(lambda r: r["mode"] == "reply")
    g.check(d["subject"] == "RE: Plans", "Reply: RE: subject", d["subject"])
    g.check(d["to"] == "Bob Builder <bob@example.test>" and not d["cc"], "to the sender only", (d["to"], d["cc"]))
    g.check("From: Bob Builder <bob@example.test>" in d["body"] and "Subject: Plans" in d["body"] and "Shall we plan the trip on Friday?" in d["body"],
            "the original quoted under Outlook's header", d["body"])
    env.ui("type", target="compose", selector="#editor", value="Friday works for me.", append=True)
    env.ui("send", target="compose")
    m = smtp_with("RE: Plans")
    g.check(m is not None and "In-Reply-To: <plans-1@example.test>" in m["raw"], "the reply is threaded (In-Reply-To)", m["raw"][:900] if m else None)
    answered = wait(lambda: any("\\Answered" in f for f, r in env.mailbox("INBOX") if b"Subject: Plans" in r), 30)
    g.check(bool(answered), "the original is marked answered on the server")

    # ---- Reply All
    env.ui("selectMessage", subject="Plans")
    env.ui("key", selector="#message-list", key="r", ctrl=True, shift=True)
    d = compose_open(lambda r: r["mode"] == "replyAll")
    g.check(d["to"] == "Bob Builder <bob@example.test>" and d["cc"] == "Carol Danvers <carol@example.test>", "Reply All: the sender, and the others in Cc, not Alice", (d["to"], d["cc"]))
    env.ui("close", target="compose")
    if not compose_gone(5):
        env.ui("button", target="compose", label="Don't Save")
    compose_gone()

    # ---- Forward with the attachment
    env.ui("selectMessage", subject="Report")
    env.ui("click", selector="#rb-forward")
    d = compose_open(lambda r: r["mode"] == "forward" and r["attachments"])
    g.check(d["subject"] == "FW: Report" and d["attachments"] == ["report.pdf"], "Forward: FW: subject and the attachment", d)
    env.ui("type", target="compose", selector="#to", value="bob@example.test")
    env.ui("send", target="compose")
    m = smtp_with("FW: Report")
    g.check(m is not None and 'filename="report.pdf"' in m["raw"].replace("filename=report.pdf", 'filename="report.pdf"'), "the attachment goes with it", m["raw"][-600:] if m else None)

    # ---- a draft
    env.ui("click", selector="#rb-new-email")
    compose_open()
    env.ui("type", target="compose", selector="#subject", value="Unfinished thoughts")
    env.ui("type", target="compose", selector="#editor", value="To be continued.")
    env.ui("key", target="compose", selector="#editor", key="s", ctrl=True)
    draft = wait(lambda: [r for f, r in env.mailbox("Drafts") if b"Unfinished thoughts" in r], 30)
    g.check(bool(draft), "Ctrl+S saves it in Drafts on the server")
    g.check(not any("Unfinished thoughts" in m["raw"] for m in env.smtp_messages()), "a draft is not sent")
    env.ui("close", target="compose")
    compose_gone()

    # ---- a mailto: link (Thunderbird's own message window -> ours)
    env.chrome("""
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      MailServices.compose.OpenComposeWindowWithURI(null, Services.io.newURI("mailto:bob@example.test?subject=From%20a%20link&body=Hello%20Bob"), null);
      return true;""")
    d = compose_open(lambda r: r["subject"] == "From a link", timeout=40)
    g.check(d["to"] == "bob@example.test" and "Hello Bob" in d["body"], "a mailto: link opens SG Mail's message window, filled in", d)
    tb_compose = env.chrome("""return [...Services.wm.getEnumerator("msgcompose")].length;""")
    g.check(tb_compose == 0, "and Thunderbird's own message window is gone", tb_compose)
    env.screenshot(os.path.join(env.dir, "compose-main.png"))
finally:
    env.stop()
sys.exit(g.result())
