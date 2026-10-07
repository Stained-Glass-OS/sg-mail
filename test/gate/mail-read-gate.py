"""Gate: reading mail. Alice's IMAP account (the test Dovecot) with messages
of several days and a folder of her own: SG Mail's folder pane lists
Outlook's folders with unread counts, the message list groups by date
(Today, Yesterday, ... Older) with the first words of each message, the
reading pane shows HTML mail made safe (no script, no handlers, pictures
from the network held back until "Download pictures"), plain text mail, and
attachments; search finds a message in another folder; the Unread filter
shows only unread ones.

Mutants (test/mutants.json): mail-read-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message, midday_tz, HTTP_PORT  # noqa: E402

DAY = 86400
now = time.time()
g = Gate("mail-read")
# Thunderbird's clock in a zone where it is about noon now: "an hour ago" is
# today and "a day and an hour ago" yesterday at any hour the gate runs (in
# UTC, from midnight to 1 a.m. UTC both fell a day earlier and the date-group
# check failed -- the grouping itself, util.js dateGroup, is local-day right)
TZ, TZ_OFF = midday_tz()
TZ = os.environ.get("SG_MAIL_GATE_TZ", TZ)  # a zone of your choice (the failure: one just past midnight)
print(f"      Thunderbird's time zone: {TZ} (local hour ~{(time.gmtime().tm_hour + TZ_OFF) % 24})")
env = Env("mail-read", tz=TZ)
try:
    env.start_servers()
    tracker = f"http://127.0.0.1:{HTTP_PORT}/img/tracker.png"
    env.append("INBOX", message("Bob Builder <bob@example.test>", "Alice Example <alice@example.test>", "Quarterly numbers",
                                text="The budget for next quarter is attached.\nRegards, Bob", date=now - 3600,
                                attachments=[("budget.csv", "text/csv", b"item,amount\nrent,100\n")]), date=now - 3600)
    env.append("INBOX", message("Carol Danvers <carol@example.test>", "alice@example.test", "Newsletter with pictures",
                                html=f'<html><body><h2>Hello</h2><p onclick="alert(1)">Our <b>news</b> <img src="{tracker}" alt="t"></p>'
                                     '<script>document.title="pwned"</script><iframe src="http://127.0.0.1:18080/frame"></iframe>'
                                     '<a href="javascript:alert(2)">bad link</a></body></html>',
                                date=now - 1800), date=now - 1800)
    env.append("INBOX", message("Dan <dan@example.test>", "alice@example.test", "Yesterday's note", text="From yesterday.",
                                date=now - DAY - 3600), seen=True, date=now - DAY - 3600)
    env.append("INBOX", message("Erin <erin@example.test>", "alice@example.test", "An old message", text="Long ago.",
                                date=now - 120 * DAY), seen=True, flagged=True, date=now - 120 * DAY)
    env.append("Projects", message("Frank <frank@example.test>", "alice@example.test", "Kite budget review",
                                   text="Let us review the kite budget.", date=now - 2 * DAY), seen=True, date=now - 2 * DAY)
    env.make_profile()
    env.start_thunderbird()

    d = env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 4, timeout=90)
    tree = d["tree"]
    g.check("# alice@example.test" in tree, "the folder pane has Alice's account", tree)
    acct = tree[tree.index("# alice@example.test"):]
    favs = tree[:tree.index("# alice@example.test")]
    g.check(any(t.startswith("Inbox [2]") for t in favs), "her Inbox is among the Favorites", tree)
    for name in ("Inbox [2]", "Drafts []", "Sent Items []", "Deleted Items []", "Junk Email []", "Archive []"):
        g.check(any(t.startswith(name) for t in acct), f"folder pane: {name}", tree)
    g.check(any(t.startswith("Projects") for t in tree), "her own folder Projects is listed", tree)
    pos = lambda n: next(i for i, t in enumerate(acct) if t.startswith(n))
    g.check(pos("Inbox") < pos("Drafts") < pos("Sent Items") < pos("Deleted Items"),
            "Outlook's order: Inbox, Drafts, Sent Items, Deleted Items", tree)
    groups = [x["group"] for x in d["list"] if "group" in x]
    g.check(groups[:1] == ["Today"] and "Yesterday" in groups and groups[-1] in ("Older", "Last Month"), "date groups: Today ... Yesterday ... Older", groups)
    rows = [x for x in d["list"] if "id" in x]
    g.check([r["subject"] for r in rows][:2] == ["Newsletter with pictures", "Quarterly numbers"], "newest first", [r["subject"] for r in rows])
    unread = {r["subject"]: r["unread"] for r in rows}
    g.check(unread.get("Quarterly numbers") and not unread.get("Yesterday's note"), "unread ones are marked unread", unread)
    g.check(any(r["flagged"] for r in rows if r["subject"] == "An old message"), "the flagged one shows its flag")
    g.check(d["title"] == "Inbox - alice@example.test - SG Mail", "window title: folder - account - SG Mail", d["title"])
    d = env.wait_ui("mail", lambda r: any(x.get("preview", "").startswith("The budget for next quarter") for x in r["list"]), timeout=40)
    g.check(True, "the list shows the first words of a message")
    q = [x for x in d["list"] if x.get("subject") == "Quarterly numbers"][0]
    g.check(q["attachment"], "the message with an attachment shows the paper clip", q)

    # HTML mail, made safe
    env.ui("selectMessage", subject="Newsletter with pictures")
    d = env.wait_ui("mail", lambda r: r["reader"].get("subject") == "Newsletter with pictures" and "news" in r["reader"].get("text", ""), timeout=30)
    rd = d["reader"]
    html = rd["html"].lower()
    g.check("<script" not in html and "pwned" not in html, "no script in what is shown", rd["html"][:400])
    g.check("onclick" not in html, "no event handlers", rd["html"][:400])
    g.check("<iframe" not in html, "no frames", rd["html"][:400])
    g.check("javascript:" not in html, "no javascript: links", rd["html"][:400])
    g.check(rd["sandbox"] is not None and "allow-scripts" not in rd["sandbox"], "the frame may not run scripts", rd["sandbox"])
    g.check(rd["remoteBlocked"] and rd["remoteBar"], "pictures from the network held back, with the bar to download them", rd)
    time.sleep(2)
    g.check(not any("tracker.png" in h or "/frame" in h for h in env.hits), "nothing fetched from the network", env.hits)
    env.ui("click", selector="#rp-download-pictures")
    d = env.wait_ui("mail", lambda r: not r["reader"].get("remoteBar"), timeout=20)
    deadline = time.time() + 15
    while time.time() < deadline and not any("tracker.png" in h for h in env.hits):
        time.sleep(0.3)
    g.check(any("tracker.png" in h for h in env.hits), "Download pictures fetches them", env.hits)
    g.check(not any("/frame" in h for h in env.hits), "the frame still never loads", env.hits)
    d = env.wait_ui("mail", lambda r: any(x.get("subject") == "Newsletter with pictures" and not x["unread"] for x in r["list"]), timeout=20)
    g.check(True, "a message shown is marked read")
    deadline = time.time() + 20
    seen = False
    while time.time() < deadline and not seen:
        seen = any("\\Seen" in f for f, raw in env.mailbox("INBOX") if b"Newsletter with pictures" in raw)
        time.sleep(0.5)
    g.check(seen, "and read on the server (\\Seen)")

    # plain text with an attachment
    env.ui("selectMessage", subject="Quarterly numbers")
    d = env.wait_ui("mail", lambda r: r["reader"].get("subject") == "Quarterly numbers" and "budget" in r["reader"].get("text", ""), timeout=30)
    g.check("Regards, Bob" in d["reader"]["text"], "plain text shown", d["reader"]["text"][:200])
    g.check(d["reader"]["attachments"] == ["budget.csv"], "its attachment listed", d["reader"]["attachments"])

    # Unread filter (the Inbox has the Focused / Other tabs: Home > Filter Email)
    env.ui("click", selector="#rb-filter-email")
    env.ui("menu", label="Unread")
    d = env.wait_ui("mail", lambda r: "Yesterday's note" not in [x.get("subject") for x in r["list"]], timeout=10)
    g.check("An old message" not in [x.get("subject") for x in d["list"]], "Unread shows only unread messages", [x.get("subject") for x in d["list"]])
    g.check(d["status"].startswith("Filter applied"), "the status bar says a filter is applied", d["status"])
    env.ui("click", selector="#rb-filter-email")
    env.ui("menu", label="Clear Filter")

    # search the mailbox: a message in another folder
    env.ui("type", selector="#search", value="kite")
    env.ui("key", selector="#search", key="Enter")
    d = env.wait_ui("mail", lambda r: any(x.get("subject") == "Kite budget review" for x in r["list"]), timeout=40)
    subjects = [x.get("subject") for x in d["list"] if "id" in x]
    g.check(subjects == ["Kite budget review"], "search finds the message in Projects, and only it", subjects)
    env.ui("key", selector="#search", key="Escape")
    d = env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 4, timeout=30)
    g.check(True, "Escape ends the search")
    env.screenshot(os.path.join(env.dir, "mail-read.png"))
finally:
    env.stop()
sys.exit(g.result())
