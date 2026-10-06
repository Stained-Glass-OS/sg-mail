"""Gate: Automatic Replies (out of office). Alice's mail server keeps rules
(Dovecot with ManageSieve and Sieve): File > Automatic Replies sets the reply
there, in her own Sieve script beside the rule she already had; Dovecot's
delivery then answers each sender once (not a mailing list), within the
time range, while SG Mail is not involved at all; the bar under the ribbon
says replies are on, and Turn off takes SG Mail's part out again, her own
rule left as it was. Bob's server offers no rules (no ManageSieve where SG
Mail looks): the dialog says SG Mail can answer from this computer only
while it runs, and it does -- once a sender, marked Auto-Submitted
(RFC 3834), no copy in Sent Items, never to bulk mail.

Mutants (test/mutants.json): ar-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import datetime
import os
import smtplib
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message, SMTP_PORT, SIEVE_PORT, USERS  # noqa: E402

g = Gate("autoreply")
env = Env("autoreply", with_caldav=False, accounts=("alice@example.test", "bob@example.test"), sieve=True)
ALICE = "Alice Example <alice@example.test>"
BOB = "Bob Builder <bob@example.test>"
CAROL = "Carol Autoconf <carol@autoconf.test>"
OWN_RULE = 'require ["fileinto"];\r\nif header :contains "subject" "[news]" {\r\n  fileinto "Newsletters";\r\n}\r\n'


def wait(fn, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def local(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M")


def open_dialog():
    env.ui("click", selector="#rt-file")
    env.ui("menu", label="Automatic Replies…")
    env.wait_ui("count", lambda n: n == 1, selector=".modal #ar-text", timeout=10)


def where():
    return env.wait_ui("text", lambda r: r and "Looking" not in r[0], selector=".modal #ar-where", timeout=40)[0]


def smtp_to(rcpt):
    return [m for m in env.smtp_messages() if rcpt in m["rcpt"]]


try:
    env.start_servers()
    # Alice already has a rule of her own on the server
    home = env.dovecot_home("alice@example.test")
    os.makedirs(os.path.join(home, "sieve"), exist_ok=True)
    with open(os.path.join(home, "sieve", "mine.sieve"), "w") as f:
        f.write(OWN_RULE)
    os.symlink("sieve/mine.sieve", os.path.join(home, ".dovecot.sieve"))
    env.append("Newsletters", message("x <x@x.test>", ALICE, "seed", text="x"))
    env.make_profile()
    env.start_thunderbird()
    env.wait_ui("ping", lambda r: r["ready"], timeout=90)
    env.trust_test_ca()
    env.wait_ui("mail", lambda r: r["folder"] is not None, timeout=60)

    # ---- on Alice's server ----
    open_dialog()
    w = where()
    g.check("only while SG Mail is running" in w, "nothing at the usual port (4190): the dialog says SG Mail would answer from here", w)
    env.ui("type", selector=".modal #ar-server", value=f"127.0.0.1:{SIEVE_PORT}")
    env.ui("click", selector=".modal button", text="Check")
    w = where()
    g.check(f"Your mail server (127.0.0.1:{SIEVE_PORT}) sends these replies" in w, "her rules server (ManageSieve, STARTTLS): replies set there", w)
    env.ui("click", selector=".modal #ar-on")
    env.ui("click", selector=".modal #ar-range")
    now = time.time()
    env.ui("type", selector=".modal #ar-start", value=local(now - 3600))
    env.ui("type", selector=".modal #ar-end", value=local(now + 7 * 86400))
    env.ui("type", selector=".modal #ar-text", value="I am out of the office until Monday.\nLee Gu helps with anything urgent.")
    env.ui("button", label="OK")
    script = wait(lambda: (lambda s: s if s and "vacation" in s else None)(env.sieve_script()), 30)
    g.check(script is not None and "I am out of the office until Monday." in script, "the reply is in her active Sieve script", script)
    g.check(script is not None and 'fileinto "Newsletters"' in script, "beside her own rule", script)
    b = env.wait_ui("autoReplies", lambda r: "AUTOMATIC REPLIES" in r["banner"], timeout=10)
    g.check("alice@example.test" in b["banner"] and "this computer" not in b["banner"], "the bar under the ribbon: replies on", b["banner"])

    rc, out = env.deliver_lda(message(CAROL, ALICE, "Lunch on Tuesday?", text="Are you free?"), sender="carol@autoconf.test")
    g.check(rc == 0, "(delivered by Dovecot)", out)
    r = wait(lambda: env.sieve_replies(), 20)
    g.check(r and len(r) == 1 and "<carol@autoconf.test>" in next((l for l in r[0].split("\n") if l.startswith("To:")), "") and "Subject: Automatic reply: Lunch on Tuesday?" in r[0]
            and "I am out of the office until Monday." in r[0], "Dovecot answers the sender (SG Mail not involved)", r[0][:600] if r else r)
    env.deliver_lda(message(CAROL, ALICE, "And Wednesday?", text="?"), sender="carol@autoconf.test")
    env.deliver_lda(message("Club <list@club.test>", ALICE, "Club news", text="news", extra_headers=[("List-Id", "<club.test>"), ("Precedence", "list")]), sender="list@club.test")
    rc, out = env.deliver_lda(message("Paper <paper@news.test>", ALICE, "[news] Weekly", text="w"), sender="paper@news.test")
    time.sleep(2)
    g.check(len(env.sieve_replies()) == 2, "once to each sender; never to a mailing list", [x[:200] for x in env.sieve_replies()])
    g.check(any(b"[news] Weekly" in raw for f, raw in env.mailbox("Newsletters")), "her own rule still files her newsletters")

    env.ui("click", selector="#autoreply-off")
    script = wait(lambda: (lambda s: s if s is not None and "vacation" not in s else None)(env.sieve_script()), 30)
    g.check(script is not None and script.replace("\r\n", "\n").strip() == OWN_RULE.replace("\r\n", "\n").strip(), "Turn off: her script as it was before", script)
    g.check(env.wait_ui("count", lambda n: n == 0, selector="#autoreply-bar", timeout=20) == 0, "and the bar gone")

    # ---- Bob: no rules server, answered from this computer ----
    open_dialog()
    accts = env.ui("text", selector=".modal #ar-account option")
    env.ui("selectOption", selector=".modal #ar-account", index=accts.index("bob@example.test"))
    w = where()
    g.check("only while SG Mail is running" in w, "Bob's server keeps no rules: the dialog says SG Mail answers from this computer while it runs", w)
    env.ui("click", selector=".modal #ar-on")
    env.ui("type", selector=".modal #ar-text", value="Bob is on holiday.")
    env.ui("button", label="OK")
    b = env.wait_ui("autoReplies", lambda r: "AUTOMATIC REPLIES" in r["banner"], timeout=10)
    g.check("bob@example.test" in b["banner"] and "only while SG Mail is running" in b["banner"], "the bar says so too", b["banner"])

    s = smtplib.SMTP("127.0.0.1", SMTP_PORT)
    s.login("carol@autoconf.test", USERS["carol@autoconf.test"][1])
    s.sendmail("carol@autoconf.test", ["bob@example.test"], message(CAROL, BOB, "Hello Bob", text="Got a minute?", msgid="<hb1@autoconf.test>"))
    s.quit()
    env.ui("key", selector="#message-list", key="F9")
    rep = wait(lambda: [m for m in smtp_to("carol@autoconf.test") if "Automatic reply: Hello Bob" in m["raw"]], 90)
    g.check(rep and "Bob is on holiday." in rep[0]["raw"] and "Auto-Submitted: auto-replied" in rep[0]["raw"] and "In-Reply-To: <hb1@autoconf.test>" in rep[0]["raw"],
            "SG Mail answers from this computer: marked Auto-Submitted, threaded", rep[0]["raw"][:700] if rep else None)
    s = smtplib.SMTP("127.0.0.1", SMTP_PORT)
    s.login("carol@autoconf.test", USERS["carol@autoconf.test"][1])
    s.sendmail("carol@autoconf.test", ["bob@example.test"], message(CAROL, BOB, "One more thing", text="Also..."))
    s.sendmail("news@shop.test", ["bob@example.test"], message("Shop <news@shop.test>", BOB, "Sale", text="50% off", extra_headers=[("List-Unsubscribe", "<mailto:u@shop.test>")]))
    s.quit()
    env.ui("key", selector="#message-list", key="F9")
    g.check(wait(lambda: sum(1 for f, raw in env.mailbox("INBOX", user="bob@example.test") if b"Sale" in raw or b"One more thing" in raw) == 2, 60), "(more mail for Bob)")
    time.sleep(8)
    auto = [m for m in env.smtp_messages() if "Automatic reply" in m["raw"]]
    g.check(len(auto) == 1, "once to each sender, never to bulk mail", [m["rcpt"] for m in auto])
    g.check(not any(b"Automatic reply" in raw for f, raw in env.mailbox("Sent", user="bob@example.test")), "no copy in Sent Items")
    time.sleep(1)
    env.screenshot(os.path.join(env.dir, "autoreply.png"))
    env.ui("click", selector="#autoreply-off")
    env.wait_ui("autoReplies", lambda r: not r["banner"], timeout=10)
    g.check(True, "Turn off")
finally:
    env.stop()
sys.exit(g.result())
