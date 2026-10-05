"""Gate: SG Mail's window and Thunderbird underneath. The main window is
ours alone (Thunderbird's toolbars, spaces bar and tab strip hidden), titled
"<folder> - <account> - SG Mail", light or dark as the system is; a person
with no calendar gets a local Calendar; File > Add Account is Thunderbird's
own account setup, which finds a provider's settings by its lookup
(ISPDB-style autoconfig, here a local stand-in) and makes the account,
which SG Mail's folder pane then shows; Thunderbird knows how to sign in to
Microsoft (Outlook.com, Microsoft 365) and Google mail with their own login
pages (OAuth2 with Mozilla's registration: nothing to register for SG Mail).
Screenshots of the main window, the calendar and the message window, light
and dark, are left in the gate's directory.

Mutants (test/mutants.json): look-*.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import Env, Gate, message, USERS  # noqa: E402

g = Gate("look")
SHOTS = os.environ.get("SG_MAIL_SHOTS", "/var/tmp/sgmail/screenshots")
os.makedirs(SHOTS, exist_ok=True)


def lum(rgb):
    nums = [int(x) for x in rgb.replace("rgba", "").replace("rgb", "").strip("()").split(",")[:3]]
    return sum(nums) / 3


def seed(env):
    now = time.time()
    msgs = [
        ("Megan Bowen <megan@example.test>", "Quarterly business review", "Hi Alice, the slides for Thursday's review are attached. Can you add the sales figures?", 0.2, True, [("QBR-slides.pdf", "application/pdf", b"%PDF-1.4")]),
        ("Lee Gu <lee@example.test>", "Lunch on Friday?", "There is a new place on Main Street. Twelve thirty?", 1.5, False, []),
        ("IT Service Desk <it@example.test>", "Your password will expire soon", "Your password expires in 7 days. Change it from the portal.", 3, False, []),
        ("Isaiah Langer <isaiah@example.test>", "Re: Kite festival volunteers", "Count me in for Saturday morning. I can bring the big kite.", 26, True, []),
        ("Pradeep Gupta <pradeep@example.test>", "Invoice 2026-114", "Please find the October invoice attached.", 30, True, [("invoice-2026-114.pdf", "application/pdf", b"%PDF-1.4")]),
        ("Nestor Wilke <nestor@example.test>", "Team offsite agenda", "Draft agenda for the offsite: morning planning, afternoon hike.", 100, True, []),
        ("Joni Sherman <joni@example.test>", "Welcome to the team!", "We are glad to have you with us. Your first week schedule is below.", 400, True, []),
    ]
    for frm, subj, text, hours, seen, att in msgs:
        t = now - hours * 3600
        env.append("INBOX", message(frm, "Alice Example <alice@example.test>", subj, text=text, date=t, attachments=att), seen=seen, flagged=subj.startswith("Invoice"), date=t)
    env.append("Projects", message("Lee Gu <lee@example.test>", "alice@example.test", "Kite plans", text="x"), seen=True)


def shots(env, tag):
    env.wait_ui("mail", lambda r: len([x for x in r["list"] if "id" in x]) >= 7, timeout=90)
    env.ui("selectMessage", subject="Quarterly business review")
    env.wait_ui("mail", lambda r: r["reader"].get("subject") == "Quarterly business review" and "slides" in r["reader"].get("text", ""), timeout=30)
    env.wait_ui("mail", lambda r: sum(1 for x in r["list"] if x.get("preview")) >= 5, timeout=40)
    time.sleep(1.5)
    env.screenshot(os.path.join(SHOTS, f"sg-mail-{tag}.png"))
    bg = env.ui("style", selector="body", prop="backgroundColor")
    env.ui("click", selector="#nav-calendar")
    env.ui("calendarDate", y=2026, m=10, d=7)
    env.wait_ui("calendar", lambda r: len(r["events"]) >= 3, timeout=60)
    time.sleep(1)
    env.screenshot(os.path.join(SHOTS, f"sg-mail-calendar-{tag}.png"))
    env.ui("click", selector="#nav-mail")
    env.ui("selectMessage", subject="Lunch on Friday?")
    env.ui("key", selector="#message-list", key="r", ctrl=True)
    env.wait_ui("dump", lambda r: r["subject"] == "RE: Lunch on Friday?", target="compose", timeout=30)
    env.ui("type", target="compose", selector="#editor", value="Sounds good, see you at 12:30.", append=True)
    time.sleep(1)
    handles = env.m.command("WebDriver:GetWindowHandles")
    handles = handles["value"] if isinstance(handles, dict) else handles
    main = env.m.command("WebDriver:GetWindowHandle")
    main = main["value"] if isinstance(main, dict) else main
    other = [h for h in handles if h != main]
    if other:
        env.m.command("WebDriver:SwitchToWindow", {"handle": other[-1]})
        env.screenshot(os.path.join(SHOTS, f"sg-mail-compose-{tag}.png"))
        env.m.command("WebDriver:SwitchToWindow", {"handle": main})
    env.ui("close", target="compose")
    time.sleep(1)
    try:
        env.ui("button", target="compose", label="Don't Save", timeout_ms=5000)
    except Exception:
        pass
    return bg


EVENTS = [("Team standup", 9, 9.5), ("Design review", 11, 12), ("Lunch with Lee", 12.5, 13.5), ("Customer call", 15, 16)]


def calendar_events(env):
    import datetime
    for i, (t, s, e) in enumerate(EVENTS):
        day = datetime.datetime(2026, 10, 5 + (i % 3) + (1 if i == 3 else 0), tzinfo=datetime.timezone.utc)
        ics = ("BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//gate//EN\nBEGIN:VEVENT\n"
               f"UID:look-{i}@example.test\nDTSTAMP:20261001T080000Z\n"
               f"DTSTART:{(day + datetime.timedelta(hours=s)).strftime('%Y%m%dT%H%M%SZ')}\n"
               f"DTEND:{(day + datetime.timedelta(hours=e)).strftime('%Y%m%dT%H%M%SZ')}\nSUMMARY:{t}\nEND:VEVENT\nEND:VCALENDAR\n")
        env.dav("PUT", f"/alice@example.test/work/look-{i}.ics", ics, headers={"Content-Type": "text/calendar"})


# ---- light, with the window checks -------------------------------------------------------
env = Env("look")
try:
    env.start_servers()
    seed(env)
    calendar_events(env)
    env.make_profile()
    env.start_thunderbird()
    env.caldav_id = env.add_caldav_calendar()
    env.wait_ui("ping", lambda r: r["ready"], timeout=60)
    chrome = env.chrome("""
      const w = Services.wm.getMostRecentWindow("mail:3pane");
      const d = w.document;
      const shown = id => { const e = d.getElementById(id); return !!e && e.getBoundingClientRect().height > 0 && w.getComputedStyle(e).display !== "none"; };
      return { title: d.title, toolbox: shown("navigation-toolbox"), spaces: shown("spacesToolbar"), status: shown("status-bar"),
               own: d.documentElement.hasAttribute("sgmail-own"), quitDisabled: d.getElementById("key_quitApplication")?.getAttribute("disabled") };""")
    g.check(chrome["own"] and not chrome["toolbox"] and not chrome["spaces"] and not chrome["status"],
            "the main window is SG Mail's alone: Thunderbird's toolbars, spaces bar and tabs hidden", chrome)
    bg = shots(env, "light")
    g.check(lum(bg) > 200, "light: a light window", bg)
    title = env.chrome("""return Services.wm.getMostRecentWindow("mail:3pane").document.title;""")
    g.check(title == "Inbox - alice@example.test - SG Mail", "the window's title: Inbox - alice@example.test - SG Mail", title)

    # File > Add Account: Thunderbird's account setup, with the provider lookup
    env.ui("click", selector="#rt-file")
    env.ui("menu", label="Add Account…")
    tab = env.chrome("""
      const w = Services.wm.getMostRecentWindow("mail:3pane");
      for (let i = 0; i < 50; i++) {
        const t = w.document.getElementById("tabmail").currentTabInfo;
        if (t.browser && t.browser.currentURI.spec == "about:accountsetup" && t.browser.contentDocument?.getElementById("email")) break;
        await new Promise(r => w.setTimeout(r, 200));
      }
      const d = w.document;
      return { url: d.getElementById("tabmail").currentTabInfo.browser?.currentURI.spec, own: d.documentElement.hasAttribute("sgmail-own"),
               tabs: d.getElementById("navigation-toolbox").getBoundingClientRect().height > 0 };""")
    g.check(tab["url"] == "about:accountsetup", "File > Add Account opens Thunderbird's account setup", tab)
    g.check(not tab["own"] and tab["tabs"], "with the tab strip back to return to SG Mail", tab)
    found = env.chrome("""
      const w = Services.wm.getMostRecentWindow("mail:3pane");
      const b = w.document.getElementById("tabmail").currentTabInfo.browser;
      const d = b.contentDocument, cw = b.contentWindow;
      const set = (id, v) => { const e = d.getElementById(id); e.focus(); e.value = v; e.dispatchEvent(new cw.Event("input", {bubbles: true})); };
      set("realname", args.name); set("email", args.email); set("password", args.pw);
      d.getElementById("continueButton").click();
      for (let i = 0; i < 150; i++) {
        const host = d.querySelector("#incomingHostname, #incomingHostnameDisplay");
        const ok = d.getElementById("createButton");
        if (ok && !ok.hidden && !ok.disabled && d.getElementById("protocolIMAP")?.checked !== undefined) break;
        await new Promise(r => w.setTimeout(r, 200));
      }
      return { text: d.body.innerText.slice(0, 3000), create: !!d.getElementById("createButton") && !d.getElementById("createButton").hidden };""",
        {"name": "Carol Autoconf", "email": "carol@autoconf.test", "pw": USERS["carol@autoconf.test"][1]}, timeout_ms=90000)
    g.check(any("/ispdb/autoconf.test" in h for h in env.hits), "the account setup asks the provider lookup (ISPDB) for autoconf.test", env.hits)
    g.check("127.0.0.1" in found["text"] and "IMAP" in found["text"], "and finds its IMAP and SMTP settings", found["text"][:1500])
    made = env.chrome("""
      const w = Services.wm.getMostRecentWindow("mail:3pane");
      const b = w.document.getElementById("tabmail").currentTabInfo.browser;
      const d = b.contentDocument;
      d.getElementById("createButton").click();
      for (let i = 0; i < 40; i++) {
        // plain-text servers on this machine: Thunderbird asks to confirm the risk
        const dlg = d.getElementById("insecureDialog");
        if (dlg && dlg.open) {
          const risk = d.getElementById("acknowledgeWarning");
          risk.checked = true;
          risk.dispatchEvent(new b.contentWindow.Event("change", {bubbles: true}));
          d.getElementById("insecureConfirmButton").click();
        }
        const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
        if (MailServices.accounts.allIdentities.some(i => i.email == "carol@autoconf.test")) return true;
        await new Promise(r => w.setTimeout(r, 500));
      }
      return d.body.innerText.slice(0, 2000);""", timeout_ms=60000)
    g.check(made is True, "the account is made", made)
    if made is True:
        env.chrome("""const w = Services.wm.getMostRecentWindow("mail:3pane");
          const tm = w.document.getElementById("tabmail");
          const t = tm.tabInfo.find(t => t.browser && t.browser.currentURI.spec == "about:accountsetup"); if (t) tm.closeTab(t); return true;""")
        d = env.wait_ui("mail", lambda r: "# carol@autoconf.test" in r["tree"], timeout=60)
        g.check(True, "and SG Mail's folder pane shows it")

    # Microsoft and Google: Thunderbird's own sign-in (no client id of ours)
    prov = env.chrome("""
      const { OAuth2Providers } = ChromeUtils.importESModule("resource:///modules/OAuth2Providers.sys.mjs");
      const out = {};
      for (const host of ["outlook.office365.com", "smtp.office365.com", "imap.gmail.com"]) {
        const d = OAuth2Providers.getHostnameDetails(host, "imap") || OAuth2Providers.getHostnameDetails(host);
        out[host] = d ? { issuer: d.issuer || d[0], scope: JSON.stringify(d) } : null;
      }
      const ms = OAuth2Providers.getIssuerDetails("login.microsoftonline.com");
      out.microsoft = ms ? { client: !!ms.clientId, auth: ms.authorizationEndpoint, redirect: ms.redirectionEndpoint } : null;
      return out;""")
    g.check((prov.get("outlook.office365.com") or {}).get("issuer") == "login.microsoftonline.com" and
            "IMAP.AccessAsUser.All" in str((prov.get("outlook.office365.com") or {}).get("scope")),
            "Thunderbird signs in to Microsoft mail (OAuth2, IMAP.AccessAsUser.All)", prov)
    g.check((prov.get("microsoft") or {}).get("client") and "login.microsoftonline.com" in str((prov.get("microsoft") or {}).get("auth")),
            "with its own registered client at login.microsoftonline.com", prov.get("microsoft"))
    g.check((prov.get("imap.gmail.com") or {}).get("issuer") == "accounts.google.com", "and to Google mail", prov.get("imap.gmail.com"))
finally:
    env.stop()

# ---- no calendar of her own: a local Calendar -----------------------------------------------
env = Env("look-local", with_caldav=False)
try:
    env.start_servers()
    env.make_profile()
    env.start_thunderbird()
    env.wait_ui("ping", lambda r: r["ready"], timeout=60)
    env.ui("click", selector="#nav-calendar")
    d = env.wait_ui("calendar", lambda r: len(r["calendars"]) >= 1, timeout=40)
    g.check([c["name"] for c in d["calendars"]] == ["Calendar"] and not d["calendars"][0]["readOnly"],
            "with no calendar to write in, SG Mail makes a local Calendar", d["calendars"])
finally:
    env.stop()

# ---- dark ---------------------------------------------------------------------------------
env = Env("look-dark", dark=True)
try:
    env.start_servers()
    seed(env)
    calendar_events(env)
    env.make_profile()
    env.start_thunderbird()
    env.caldav_id = env.add_caldav_calendar()
    bg = shots(env, "dark")
    g.check(lum(bg) < 60, "dark: a dark window when the system is dark", bg)
finally:
    env.stop()
print("screenshots:", " ".join(sorted(os.listdir(SHOTS))))
sys.exit(g.result())
