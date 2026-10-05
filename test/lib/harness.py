"""SG Mail's gate harness: everything a gate needs, inside the test root
(build/inroot.sh, with no network but its own loopback, so nothing can reach
a real mail provider):

  - Dovecot (IMAP, 127.0.0.1:IMAP_PORT plain, IMAPS_PORT with a scratch CA)
    with the users alice@example.test and bob@example.test;
  - an SMTP server (aiosmtpd: AUTH PLAIN/LOGIN) that keeps every message it
    is given (smtp/N.eml) and delivers it to local users' inboxes;
  - Radicale (CalDAV, 127.0.0.1:CALDAV_PORT) with alice's calendar "Work";
  - a web server: the account-setup lookups (ISPDB, autoconfig), and
    pictures whose fetches it counts (the remote-content gates);
  - Xvfb, and Thunderbird with a scratch profile laid out as the sg-mail
    launcher lays it out (our extension, user.js), driven over Marionette.

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import base64
import email.utils
import http.client
import http.server
import imaplib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from marionette import Marionette  # noqa: E402

IMAP_PORT, IMAPS_PORT, SMTP_PORT, CALDAV_PORT, HTTP_PORT, MARIONETTE_PORT = 10143, 10993, 10025, 15232, 18080, 12828
USERS = {"alice@example.test": ("Alice Example", "alice-secret"), "bob@example.test": ("Bob Builder", "bob-secret"),
         "carol@autoconf.test": ("Carol Autoconf", "carol-secret")}
EXT_ID = "sg-mail@stained-glass-os.org"


def log(*a):
    print("[gate]", *a, flush=True)


def wait_port(port, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
            return True
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f"nothing listens on {port}")


class Hits(http.server.ThreadingHTTPServer):
    pass


def make_http(root, hits, extra):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def log_message(self, *a):
            pass

        def do_GET(self):
            hits.append(self.path)
            for prefix, fn in extra.items():
                if self.path.startswith(prefix):
                    code, ctype, body = fn(self.path)
                    self.send_response(code)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
            return super().do_GET()
    return H


class Env:
    def __init__(self, name, dark=False, extra_prefs=None, with_caldav=True, accounts=("alice@example.test",), keep=False):
        self.name = name
        self.dir = f"/var/tmp/sgmail/gates/{name}"
        if os.path.exists(self.dir):
            shutil.rmtree(self.dir)
        os.makedirs(self.dir)
        self.out = os.path.join(self.dir, "out")
        os.makedirs(self.out)
        self.procs = []
        self.hits = []
        self.dark = dark
        self.extra_prefs = extra_prefs or {}
        self.with_caldav = with_caldav
        self.accounts = accounts
        self.smtp_dir = os.path.join(self.dir, "smtp")
        os.makedirs(self.smtp_dir)
        self.http_routes = {}
        self.m = None

    # ---- servers ------------------------------------------------------------------------

    def start_servers(self):
        self.make_certs()
        self.start_dovecot()
        self.start_smtp()
        if self.with_caldav:
            self.start_radicale()
        self.start_http()

    def make_certs(self):
        d = os.path.join(self.dir, "pki")
        os.makedirs(d)
        run = lambda *a: subprocess.run(a, check=True, capture_output=True)
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", f"{d}/ca.key", "-out", f"{d}/ca.crt",
            "-days", "30", "-subj", "/CN=SG Mail Test CA")
        run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", f"{d}/server.key", "-out", f"{d}/server.csr", "-subj", "/CN=127.0.0.1")
        with open(f"{d}/ext.cnf", "w") as f:
            f.write("subjectAltName=IP:127.0.0.1,DNS:localhost\n")
        run("openssl", "x509", "-req", "-in", f"{d}/server.csr", "-CA", f"{d}/ca.crt", "-CAkey", f"{d}/ca.key", "-CAcreateserial",
            "-out", f"{d}/server.crt", "-days", "30", "-extfile", f"{d}/ext.cnf")
        self.pki = d

    def start_dovecot(self):
        d = os.path.join(self.dir, "dovecot")
        os.makedirs(d)
        shutil.copy(f"{self.pki}/server.crt", d)
        shutil.copy(f"{self.pki}/server.key", d)
        with open(f"{d}/users", "w") as f:
            for u, (_, pw) in USERS.items():
                f.write(f"{u}:{{PLAIN}}{pw}\n")
        conf = open(os.path.join(SRC, "test/servers/dovecot.conf.in")).read()
        import grp
        import pwd
        user = pwd.getpwuid(os.getuid()).pw_name
        group = grp.getgrgid(os.getgid()).gr_name
        for k, v in {"@DIR@": d, "@PORT@": str(IMAP_PORT), "@SPORT@": str(IMAPS_PORT), "@USER@": user, "@GROUP@": group,
                     "@UID@": str(os.getuid()), "@GID@": str(os.getgid()), "@DEBUG@": ""}.items():
            conf = conf.replace(k, v)
        with open(f"{d}/dovecot.conf", "w") as f:
            f.write(conf)
        self.procs.append(subprocess.Popen(["dovecot", "-c", f"{d}/dovecot.conf", "-F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        wait_port(IMAP_PORT)
        self.dovecot_dir = d

    def start_smtp(self):
        script = os.path.join(SRC, "test/servers/smtp_server.py")
        self.procs.append(subprocess.Popen([sys.executable, script, str(SMTP_PORT), self.smtp_dir, json.dumps({u: pw for u, (_, pw) in USERS.items()}), str(IMAP_PORT)],
                                           stdout=open(os.path.join(self.dir, "smtp.log"), "w"), stderr=subprocess.STDOUT))
        wait_port(SMTP_PORT)

    def start_radicale(self):
        d = os.path.join(self.dir, "radicale")
        os.makedirs(f"{d}/collections")
        with open(f"{d}/users", "w") as f:
            for u, (_, pw) in USERS.items():
                f.write(f"{u}:{pw}\n")
        with open(f"{d}/config", "w") as f:
            f.write(f"[server]\nhosts = 127.0.0.1:{CALDAV_PORT}\n[auth]\ntype = htpasswd\nhtpasswd_filename = {d}/users\nhtpasswd_encryption = plain\n"
                    f"[storage]\nfilesystem_folder = {d}/collections\n[logging]\nlevel = warning\n")
        self.procs.append(subprocess.Popen([sys.executable, "-m", "radicale", "--config", f"{d}/config"],
                                           stdout=open(os.path.join(self.dir, "radicale.log"), "w"), stderr=subprocess.STDOUT))
        wait_port(CALDAV_PORT)
        # alice's calendar "Work"
        body = ('<?xml version="1.0" encoding="utf-8"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
                '<D:set><D:prop><D:displayname>Work</D:displayname></D:prop></D:set></C:mkcalendar>')
        self.dav("MKCALENDAR", "/alice@example.test/work/", body)

    def dav(self, method, path, body="", user="alice@example.test", headers=None):
        c = http.client.HTTPConnection("127.0.0.1", CALDAV_PORT, timeout=20)
        auth = base64.b64encode(f"{user}:{USERS[user][1]}".encode()).decode()
        hd = {"Authorization": "Basic " + auth, "Content-Type": "application/xml; charset=utf-8"}
        hd.update(headers or {})
        c.request(method, path, body.encode() if isinstance(body, str) else body, hd)
        r = c.getresponse()
        data = r.read()
        return r.status, data.decode("utf-8", "replace")

    def caldav_events(self, user="alice@example.test", cal="work"):
        """The .ics objects in a CalDAV calendar, as the server keeps them."""
        d = os.path.join(self.dir, "radicale/collections/collection-root", user, cal)
        out = []
        if os.path.isdir(d):
            for n in sorted(os.listdir(d)):
                if n.endswith(".ics"):
                    out.append(open(os.path.join(d, n)).read())
        return out

    def start_http(self):
        root = os.path.join(self.dir, "www")
        os.makedirs(os.path.join(root, "img"))
        # a 1x1 PNG the remote-content gate's message points at
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
        for n in ("tracker.png", "logo.png"):
            open(os.path.join(root, "img", n), "wb").write(png)
        # the account-setup lookup (Thunderbird's ISPDB format) for autoconf.test
        os.makedirs(os.path.join(root, "ispdb"))
        with open(os.path.join(root, "ispdb", "autoconf.test"), "w") as f:
            f.write(f"""<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="autoconf.test">
    <domain>autoconf.test</domain>
    <displayName>Autoconf Test Mail</displayName>
    <incomingServer type="imap">
      <hostname>127.0.0.1</hostname><port>{IMAP_PORT}</port><socketType>plain</socketType>
      <authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>127.0.0.1</hostname><port>{SMTP_PORT}</port><socketType>plain</socketType>
      <authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>
""")
        def ispdb(path):
            f = os.path.join(root, "ispdb", os.path.basename(path.split("?")[0]))
            if os.path.exists(f):
                return 200, "text/xml", open(f, "rb").read()
            return 404, "text/plain", b"not found"
        self.http_routes["/ispdb/"] = ispdb
        srv = Hits(("127.0.0.1", HTTP_PORT), make_http(root, self.hits, self.http_routes))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.http = srv
        self.www = root

    # ---- mail ---------------------------------------------------------------------------

    def imap(self, user="alice@example.test"):
        c = imaplib.IMAP4("127.0.0.1", IMAP_PORT)
        c.login(user, USERS[user][1])
        return c

    def append(self, mailbox, raw, user="alice@example.test", seen=False, flagged=False, date=None):
        c = self.imap(user)
        if mailbox != "INBOX":
            c.create(mailbox)
            c.subscribe(mailbox)
        flags = " ".join(x for x in ((r"\Seen" if seen else ""), (r"\Flagged" if flagged else "")) if x)
        t = imaplib.Time2Internaldate(date or time.time())
        typ, data = c.append(mailbox, f"({flags})" if flags else None, t, raw if isinstance(raw, bytes) else raw.encode())
        c.logout()
        if typ != "OK":
            raise RuntimeError(f"APPEND {mailbox}: {data}")

    def mailbox(self, mailbox, user="alice@example.test"):
        """[(flags, raw)] of a mailbox on the server."""
        c = self.imap(user)
        typ, _ = c.select(f'"{mailbox}"', readonly=True)
        out = []
        if typ == "OK":
            typ, data = c.search(None, "ALL")
            for num in data[0].split():
                typ, msg = c.fetch(num, "(FLAGS RFC822)")
                flags = msg[0][0].decode()
                out.append((flags, msg[0][1]))
        c.logout()
        return out

    def smtp_messages(self):
        out = []
        for n in sorted(os.listdir(self.smtp_dir), key=lambda x: int(x.split(".")[0]) if x.split(".")[0].isdigit() else 0):
            if n.endswith(".json"):
                out.append(json.load(open(os.path.join(self.smtp_dir, n))))
        return out

    # ---- Thunderbird -------------------------------------------------------------------------------

    def profile_prefs(self):
        p = {
            "marionette.port": MARIONETTE_PORT,
            "mail.biff.show_alert": False,
            "calendar.alarms.show": False,
            "calendar.alarms.playsound": False,
            "mail.server.default.check_new_mail": True,
            "mail.server.default.check_time": 1,
            "mail.server.default.autosync_offline_stores": False,
            "mailnews.auto_config_url": f"http://127.0.0.1:{HTTP_PORT}/ispdb/",
            "mailnews.auto_config.fetchFromExchange.enabled": False,
            "mail.accounthub.enabled": False,
            "calendar.timezone.local": "UTC",
            "calendar.timezone.useSystemTimezone": False,
            "intl.regional_prefs.use_os_locales": False,
            "general.useragent.locale": "en-US",
            "intl.locale.requested": "en-US",
            "browser.cache.disk.enable": False,
            "ui.systemUsesDarkTheme": 1 if self.dark else 0,
            "layout.css.prefers-color-scheme.content-override": 0 if self.dark else 1,
            "browser.theme.content-theme": 0 if self.dark else 1,
            "browser.theme.toolbar-theme": 0 if self.dark else 1,
            "security.enterprise_roots.enabled": False,
            "network.connectivity-service.enabled": False,
            "network.captive-portal-service.enabled": False,
            "devtools.console.stdout.content": True,
            "devtools.console.stdout.chrome": True,
            "browser.dom.window.dump.enabled": True,
        }
        for k in os.environ.get("SG_GATE_DROP", "").split(","):
            p.pop(k, None)
        n = 0
        accts, servers, smtps, ids = [], [], [], []
        for user in self.accounts:
            n += 1
            name, _ = USERS[user]
            accts.append(f"account{n}")
            p.update({
                f"mail.account.account{n}.identities": f"id{n}",
                f"mail.account.account{n}.server": f"server{n}",
                f"mail.server.server{n}.hostname": "127.0.0.1",
                f"mail.server.server{n}.port": IMAP_PORT,
                f"mail.server.server{n}.type": "imap",
                f"mail.server.server{n}.userName": user,
                f"mail.server.server{n}.name": user,
                f"mail.server.server{n}.socketType": 0,
                f"mail.server.server{n}.authMethod": 3,
                f"mail.server.server{n}.check_new_mail": True,
                f"mail.server.server{n}.check_time": 1,
                f"mail.server.server{n}.login_at_startup": False,      # the gate adds the passwords first
                f"mail.server.server{n}.use_idle": True,
                f"mail.server.server{n}.offline_download": False,
                f"mail.identity.id{n}.fullName": name,
                f"mail.identity.id{n}.useremail": user,
                f"mail.identity.id{n}.smtpServer": f"smtp{n}",
                f"mail.identity.id{n}.valid": True,
                f"mail.identity.id{n}.fcc_folder": f"imap://{user.replace('@', '%40')}@127.0.0.1/Sent",
                f"mail.identity.id{n}.draft_folder": f"imap://{user.replace('@', '%40')}@127.0.0.1/Drafts",
                f"mail.identity.id{n}.archive_folder": f"imap://{user.replace('@', '%40')}@127.0.0.1/Archive",
                f"mail.identity.id{n}.reply_on_top": 1,
                f"mail.smtpserver.smtp{n}.hostname": "127.0.0.1",
                f"mail.smtpserver.smtp{n}.port": SMTP_PORT,
                f"mail.smtpserver.smtp{n}.try_ssl": 0,
                f"mail.smtpserver.smtp{n}.authMethod": 3,
                f"mail.smtpserver.smtp{n}.username": user,
            })
            smtps.append(f"smtp{n}")
        if self.accounts:
            p["mail.accountmanager.accounts"] = ",".join(accts)
            p["mail.accountmanager.defaultaccount"] = "account1"
            p["mail.smtpservers"] = ",".join(smtps)
            p["mail.smtp.defaultserver"] = "smtp1"
        p.update(self.extra_prefs)
        return p

    def make_profile(self):
        """The profile as /usr/bin/sg-mail lays it out (launcher/sg-mail),
        with the test servers' passwords already kept in it (a first,
        account-less start stores them: with them missing, Thunderbird would
        ask for them)."""
        prof = os.path.join(self.dir, "profile")
        os.makedirs(os.path.join(prof, "extensions"))
        self.profile = prof
        with open(os.path.join(prof, "user.js"), "w") as f:
            f.write(f'user_pref("marionette.port", {MARIONETTE_PORT});\nuser_pref("mail.provider.suppress_dialog_on_startup", true);\n'
                    'user_pref("mail.shell.checkDefaultClient", false);\nuser_pref("mailnews.start_page.enabled", false);\n')
        self.start_thunderbird(seed=True)
        self.m.quit()
        self.m = None
        self.tb.wait(30)
        self.xvfb.terminate()
        self.xvfb.wait(5)
        ext = os.environ.get("SG_MAIL_EXTENSION") or os.path.join(SRC, "extension")
        if ext.endswith(".xpi"):
            shutil.copy(ext, os.path.join(prof, "extensions", EXT_ID + ".xpi"))
        else:
            with open(os.path.join(prof, "extensions", EXT_ID), "w") as f:
                f.write(ext + "\n")
        base = open(os.path.join(SRC, "launcher/user.js")).read()
        with open(os.path.join(prof, "user.js"), "w") as f:
            f.write(base)
            for k, v in self.profile_prefs().items():
                f.write(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n")
        self.profile = prof
        return prof

    def start_thunderbird(self, mutant_env=None, seed=False):
        self.xvfb = subprocess.Popen(["Xvfb", ":91", "-screen", "0", "1600x1000x24", "-nolisten", "tcp"], stderr=subprocess.DEVNULL)
        time.sleep(0.8)
        self.procs.append(self.xvfb)
        env = dict(os.environ, DISPLAY=":91", SG_MAIL_TEST_OUT=self.out, MOZ_CRASHREPORTER_DISABLE="1", TZ="UTC", LANG="C.UTF-8",
                   XDG_RUNTIME_DIR=os.path.join(self.dir, "run"), HOME=os.path.join(self.dir, "home"))
        os.makedirs(env["XDG_RUNTIME_DIR"], mode=0o700, exist_ok=True)
        os.makedirs(env["HOME"], exist_ok=True)
        env.update(mutant_env or {})
        self.tb = subprocess.Popen(["thunderbird"] + (os.environ.get("SG_TB_ARGS", "--name sg-mail --class SG-Mail").split()) + ["--marionette", "-remote-allow-system-access",
                                    "--profile", self.profile, "--no-remote"], env=env,
                                   stdout=open(os.path.join(self.dir, "thunderbird.log"), "w"), stderr=subprocess.STDOUT)
        self.procs.append(self.tb)
        self.m = Marionette(port=MARIONETTE_PORT, timeout=90)
        if not seed:
            return
        # the test servers' passwords, as Thunderbird would keep them once typed
        self.m.js("""
          for (const [origin, realm, user, pw] of args) {
            const l = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
            l.init(origin, null, realm || origin, user, pw, "", "");
            try { await Services.logins.addLoginAsync(l); } catch (e) {}
          }
          return true;""", [[f"imap://127.0.0.1", None, u, pw] for u, (_, pw) in USERS.items()] +
                  [[f"smtp://127.0.0.1", None, u, pw] for u, (_, pw) in USERS.items()] +
                  [[f"http://127.0.0.1:{CALDAV_PORT}", "Radicale - Password Required", u, pw] for u, (_, pw) in USERS.items()])

    def add_caldav_calendar(self, name="Work", path="/alice@example.test/work/", color="#0f6cbd", identity="id1"):
        """Alice's CalDAV calendar, registered once her password is known
        (registered in prefs at start it would ask for it first)."""
        return self.m.js("""
          const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
          const c = cal.manager.createCalendar("caldav", Services.io.newURI(args.uri));
          c.name = args.name;
          c.setProperty("color", args.color);
          c.setProperty("username", "alice@example.test");
          c.setProperty("imip.identity.key", args.identity);
          c.setProperty("cache.enabled", true);
          cal.manager.registerCalendar(c);
          return c.id;""", {"uri": f"http://127.0.0.1:{CALDAV_PORT}{path}", "name": name, "color": color, "identity": identity})

    def start(self, mutant_env=None):
        self.start_servers()
        self.make_profile()
        self.start_thunderbird(mutant_env)
        if self.with_caldav and self.accounts:
            self.caldav_id = self.add_caldav_calendar()
        return self

    # ---- our window ------------------------------------------------------------------------------------

    def ui(self, cmd, target="main", timeout_ms=60000, **args):
        """Ask one of SG Mail's windows (main, compose, event) to do a test
        command (ui/js/testhook.js) and return its answer."""
        return self.m.js("""
          return await new Promise((resolve, reject) => {
            const id = "sgq-" + Math.random();
            const timer = setTimeout(() => {
              Services.obs.removeObserver(obs, "sgmail-test-reply");
              reject(new Error("no window answered " + args.cmd + " (" + args.target + ")"));
            }, args.timeout);
            const obs = (subject, topic, data) => {
              const r = JSON.parse(data);
              if (r.id !== id) return;
              clearTimeout(timer);
              Services.obs.removeObserver(obs, "sgmail-test-reply");
              r.error ? reject(new Error(r.error)) : resolve(r.value);
            };
            Services.obs.addObserver(obs, "sgmail-test-reply");
            Services.obs.notifyObservers(null, "sgmail-test-run", JSON.stringify({ id, cmd: args.cmd, args: args.args, target: args.target }));
          });
        """, {"cmd": cmd, "args": args, "target": target, "timeout": timeout_ms - 2000}, timeout_ms + 5000)

    def wait_ui(self, cmd, cond, target="main", timeout=40, **args):
        """Repeat a command until cond(answer) holds; the last answer."""
        deadline = time.time() + timeout
        last = err = None
        while time.time() < deadline:
            try:
                last = self.ui(cmd, target, timeout_ms=15000, **args)
                if cond(last):
                    return last
            except Exception as e:  # the window is not there yet
                err = e
            time.sleep(0.5)
        raise TimeoutError(f"{cmd}: not as expected in {timeout}s; last: {json.dumps(last)[:2000] if last is not None else err}")

    def dump(self, name, timeout=30, cond=None):
        """Wait for out/NAME (written by our page) and, if given, cond(data)."""
        path = os.path.join(self.out, name)
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            if os.path.exists(path):
                try:
                    last = json.load(open(path))
                    if cond is None or cond(last):
                        return last
                except (ValueError, OSError):
                    pass
            time.sleep(0.3)
        raise TimeoutError(f"{name}: not as expected in {timeout}s; last: {json.dumps(last)[:1500] if last else None}")

    def chrome(self, script, args=None, timeout_ms=60000):
        return self.m.js(script, args, timeout_ms)

    def screenshot(self, path, window="main"):
        """The window, as Marionette takes it (chrome scope: the whole window)."""
        if window != "main":
            self.m.command("WebDriver:SwitchToWindow", {"handle": window})
        res = self.m.command("WebDriver:TakeScreenshot", {"full": False, "hash": False})
        data = res["value"] if isinstance(res, dict) else res
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        return path

    def stop(self):
        if getattr(self, "http", None):
            self.http.shutdown()
            self.http.server_close()
            self.http = None
        if self.m:
            self.m.quit()
            time.sleep(1)
        for p in reversed(self.procs):
            try:
                p.terminate()
                p.wait(5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass


def message(frm, to, subject, text=None, html=None, date=None, msgid=None, attachments=(), extra_headers=(), cc=None, calendar=None):
    """An RFC 5322 message, as a server would hold it."""
    from email.message import EmailMessage
    m = EmailMessage()
    m["From"] = frm
    m["To"] = to
    if cc:
        m["Cc"] = cc
    m["Subject"] = subject
    m["Date"] = email.utils.formatdate(date or time.time(), localtime=False)
    m["Message-ID"] = msgid or email.utils.make_msgid(domain="example.test")
    for k, v in extra_headers:
        m[k] = v
    if text is not None:
        m.set_content(text)
    if html is not None:
        if text is None:
            m.set_content(html, subtype="html")
        else:
            m.add_alternative(html, subtype="html")
    if calendar is not None:
        ics, method = calendar
        if m.is_multipart() or text is not None:
            m.add_alternative(ics, subtype="calendar", params={"method": method})
        else:
            m.set_content(ics, subtype="calendar", params={"method": method})
    for name, ctype, data in attachments:
        main, sub = ctype.split("/")
        m.add_attachment(data, maintype=main, subtype=sub, filename=name)
    return m.as_bytes()


class Gate:
    """Counts checks; prints PASS/FAIL lines and the result."""

    def __init__(self, name):
        self.name = name
        self.failed = 0
        self.passed = 0

    def check(self, ok, what, detail=""):
        if ok:
            self.passed += 1
            print(f"PASS  {what}", flush=True)
        else:
            self.failed += 1
            print(f"FAIL  {what}" + (f"\n      {detail}" if detail else ""), flush=True)
        return ok

    def result(self):
        ok = self.failed == 0 and self.passed > 0
        print(f"RESULT: {'PASS' if ok else 'FAIL'} ({self.name}: {self.passed} passed, {self.failed} failed)", flush=True)
        return 0 if ok else 1
