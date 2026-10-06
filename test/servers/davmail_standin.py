#!/usr/bin/env python3
"""A stand-in for DavMail (sg-davmail) in SG Mail's gates, where no Microsoft
account can be reached: called as DavMail is (davmail.properties -notray
-server; the helper's SG_DAVMAIL), it reads the same settings and answers
on the same address the way DavMail does, with the Microsoft side replaced:

  - a sign-in gateway (settings without davmail.authenticator: DavMail's
    O365Interactive) answers its first request only once "the person has
    signed in": it shows a window (xmessage, title "DavMail stand-in
    sign-in") and waits for the gate to say yes or no (the files
    signin.approve / signin.deny beside the settings); yes: it keeps a
    "token" for that address and password in davmail.oauth.tokenFilePath
    (DavMail keeps its refresh token there, encrypted with the password);
    no: 503, as DavMail when the sign-in fails;
  - the service (davmail.authenticator=...O365StoredTokenAuthenticator)
    answers 503 "No valid refresh token found" without such a token, and
    otherwise passes CalDAV / CardDAV on to a real server (Radicale:
    SG_STANDIN_UPSTREAM, SG_STANDIN_UPSTREAM_AUTH), DavMail's paths
    (/users/EMAIL/calendar/, /users/EMAIL/contacts/) to Radicale's
    (/EMAIL/calendar/, /EMAIL/contacts/) and back;
  - both: 401 with DavMail's realm ("DavMail Gateway") without credentials
    or for another address than davmail.userWhiteList; only the address
    davmail.bindAddress names; every request noted in requests.log;
  - the service's IMAP and SMTP (davmail.imapPort, davmail.smtpPort, when
    set), as DavMail's: the same token check on LOGIN / AUTH, then IMAP
    passed on to Dovecot (SG_STANDIN_IMAP) and messages handed to the SMTP
    server (SG_STANDIN_SMTP), a copy put in Sent (davmail.smtpSaveInSent).

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import base64
import hashlib
import http.client
import http.server
import imaplib
import os
import re
import signal
import smtplib
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse

conf_path = next(a for a in sys.argv[1:] if not a.startswith("-"))
DIR = os.path.dirname(os.path.abspath(conf_path))
props = {}
for line in open(conf_path, encoding="latin-1"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        props[k.strip()] = v.strip()
PORT = int(props["davmail.caldavPort"])
BIND = props.get("davmail.bindAddress") or "0.0.0.0"
TOKENS = props.get("davmail.oauth.tokenFilePath", "")
WHITE = props.get("davmail.userWhiteList", "").lower()
SIGNIN = "davmail.authenticator" not in props and props.get("davmail.mode") == "O365Graph"
UP = urllib.parse.urlparse(os.environ.get("SG_STANDIN_UPSTREAM", "http://127.0.0.1:15232"))
UP_AUTH = "Basic " + base64.b64encode(os.environ.get("SG_STANDIN_UPSTREAM_AUTH", "").encode()).decode()
REALM = "DavMail Gateway"
signed_in = set()


def note(text):
    with open(os.path.join(DIR, "requests.log"), "a") as f:
        f.write(f"{'signin' if SIGNIN else 'service'} {text}\n")


def token_of(email, password):
    return "standin:" + hashlib.sha256(f"{email}\0{password}".encode()).hexdigest()


def tokens():
    out = {}
    if TOKENS and os.path.exists(TOKENS):
        for line in open(TOKENS):
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                out[k] = v
    return out


def keep_token(email, password):
    t = tokens()
    t[email] = token_of(email, password)
    old = os.umask(0o077)
    try:
        with open(TOKENS, "w") as f:
            f.write("#Oauth tokens\n" + "".join(f"{k}={v}\n" for k, v in t.items()))
    finally:
        os.umask(old)


def sign_in_window(email):
    """The person's sign-in: a window, and the gate's answer."""
    for n in ("signin.approve", "signin.deny"):
        try:
            os.remove(os.path.join(DIR, n))
        except FileNotFoundError:
            pass
    global WINDOW
    win = None
    try:
        win = WINDOW = subprocess.Popen(["xmessage", "-title", "DavMail stand-in sign-in", f"Sign in to Microsoft as {email} (stand-in)"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass
    note(f"window {email}")
    try:
        deadline = time.time() + 280
        while time.time() < deadline:
            if os.path.exists(os.path.join(DIR, "signin.approve")):
                return True
            if os.path.exists(os.path.join(DIR, "signin.deny")):
                return False
            time.sleep(0.2)
        return False
    finally:
        if win:
            win.terminate()


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def reply(self, code, body=b"", ctype="text/plain;charset=UTF-8", headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_any(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if self.command == "OPTIONS":
            return self.reply(200, headers={"Allow": "OPTIONS, PROPFIND, HEAD, GET, REPORT, PROPPATCH, PUT, DELETE, POST",
                                            "DAV": "1, calendar-access, calendar-schedule, calendar-auto-schedule, addressbook"})
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Basic "):
            note(f"{self.command} {self.path} 401")
            return self.reply(401, headers={"WWW-Authenticate": f'Basic realm="{REALM}"'})
        user, _, password = base64.b64decode(auth[6:]).decode().partition(":")
        user = user.lower()
        if WHITE and user != WHITE:
            note(f"{self.command} {self.path} 401 {user}")
            return self.reply(401, headers={"WWW-Authenticate": f'Basic realm="{REALM}"'})
        if SIGNIN:
            if (user, password) not in signed_in:
                if not sign_in_window(user):
                    note(f"{self.command} {self.path} 503 signin failed")
                    return self.reply(503, b"Authentication failed: User did not provide authentication code")
                keep_token(user, password)
                signed_in.add((user, password))
            note(f"{self.command} {self.path} 207")
            return self.reply(207, b'<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:"/>', "text/xml;charset=UTF-8")
        if tokens().get(user) != token_of(user, password):
            note(f"{self.command} {self.path} 503 no token")
            return self.reply(503, f"No valid refresh token found for {user}".encode())
        # DavMail's paths -> Radicale's, and back
        path = self.path
        if path.startswith("/users/"):
            path = path[len("/users"):]
        elif path.startswith("/principals/users/"):
            path = path[len("/principals/users"):]
        # and in what the client sends (a multiget's hrefs)
        body = body.replace(b">/users/", b">/").replace(b">http://127.0.0.1:%d/users/" % PORT, b">/")
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ("authorization", "host", "connection", "content-length", "accept-encoding")}
        headers["Authorization"] = UP_AUTH
        c = http.client.HTTPConnection(UP.hostname, UP.port, timeout=60)
        c.request(self.command, path, body, headers)
        r = c.getresponse()
        data = r.read()
        if r.status in (403, 404) and "/lists@" in path:
            # a group's address (Microsoft 365): no mailbox Graph serves
            return self.reply(404, b"MailboxNotEnabledForRESTAPI The mailbox is either inactive, soft-deleted, or is hosted on-premise.")
        if r.status == 403:
            # Microsoft (Graph), through DavMail: what one may not see is "not found"
            note(f"{self.command} {self.path} 404 not shared")
            return self.reply(404, b"ErrorItemNotFound The specified object was not found in the store.")
        # every mailbox's paths (one's own, and colleagues' shared calendars)
        data = re.sub(rb">/([^/<>]+(@|%40)[^/<>]+)/", rb">/users/\1/", data)
        out = {k: v for k, v in r.getheaders() if k.lower() in ("etag", "dav", "allow", "location", "sync-token")}
        if "location" in {k.lower() for k in out}:
            out = {k: (v.replace(f"/{user}/", f"/users/{user}/") if k.lower() == "location" else v) for k, v in out.items()}
        note(f"{self.command} {self.path} {r.status}")
        self.reply(r.status, data, r.getheader("Content-Type") or "text/plain", out)

    do_GET = do_PUT = do_DELETE = do_PROPFIND = do_REPORT = do_PROPPATCH = do_OPTIONS = do_POST = do_HEAD = do_MKCOL = do_MOVE = handle_any


# ---- IMAP and SMTP (the service only) --------------------------------------------------

def hostport(var, default):
    h, _, p = os.environ.get(var, default).rpartition(":")
    return h, int(p)


def upstream_user():
    u, _, pw = os.environ.get("SG_STANDIN_UPSTREAM_AUTH", "").partition(":")
    return u, pw


def token_ok(user, password):
    return tokens().get(user.lower()) == token_of(user.lower(), password)


def imap_args(rest):
    """LOGIN's two arguments: quoted strings or atoms."""
    out, i = [], 0
    while i < len(rest) and len(out) < 2:
        if rest[i] == " ":
            i += 1
        elif rest[i] == '"':
            j, buf = i + 1, ""
            while j < len(rest) and rest[j] != '"':
                if rest[j] == "\\":
                    j += 1
                buf += rest[j]
                j += 1
            out.append(buf)
            i = j + 1
        else:
            j = rest.find(" ", i)
            j = len(rest) if j < 0 else j
            out.append(rest[i:j])
            i = j
    return out


class Imap(socketserver.StreamRequestHandler):
    def handle(self):
        w = lambda t: (self.wfile.write(t.encode() + b"\r\n"), self.wfile.flush())
        w("* OK IMAP4rev1 DavMail stand-in ready")
        while True:
            line = self.rfile.readline()
            if not line:
                return
            text = line.decode(errors="replace").rstrip("\r\n")
            tag, _, rest = text.partition(" ")
            cmd, _, args = rest.partition(" ")
            cmd = cmd.upper()
            if cmd == "CAPABILITY":
                w("* CAPABILITY IMAP4rev1 IDLE MOVE SPECIAL-USE UIDPLUS")
                w(f"{tag} OK CAPABILITY completed")
            elif cmd == "NOOP":
                w(f"{tag} OK NOOP completed")
            elif cmd == "LOGOUT":
                w("* BYE")
                w(f"{tag} OK LOGOUT completed")
                return
            elif cmd == "LOGIN":
                user, password = (imap_args(args) + ["", ""])[:2]
                # "OWN/OTHER": another mailbox (shared, delegated) with one's
                # own sign-in, as DavMail's IMAP takes it
                own, _, other = user.partition("/")
                if WHITE and own.lower() != WHITE or not token_ok(own, password):
                    note(f"IMAP LOGIN {user} NO")
                    w(f"{tag} NO LOGIN failed: no valid refresh token found for {own}")
                    continue
                note(f"IMAP LOGIN {user} OK")
                return self.splice(tag, other.lower() or None)
            else:
                w(f"{tag} BAD command unrecognized or not allowed before LOGIN")

    def splice(self, tag, other=None):
        up = socket.create_connection(hostport("SG_STANDIN_IMAP", "127.0.0.1:10143"))
        f = up.makefile("rb")
        f.readline()
        u, pw = upstream_user()
        if other:
            # the other mailbox's own login upstream (SG_STANDIN_MAILBOXES:
            # {"address": "password"}): only the ones "shared" with one
            import json
            boxes = json.loads(os.environ.get("SG_STANDIN_MAILBOXES", "{}"))
            if other not in boxes:
                note(f"IMAP mailbox {other} NO")
                self.wfile.write(f"{tag} NO LOGIN failed: no access to {other}\r\n".encode())
                self.wfile.flush()
                return
            u, pw = other, boxes[other]
        up.sendall(f'x1 LOGIN "{u}" "{pw}"\r\n'.encode())
        while True:
            l = f.readline()
            if not l or l.startswith(b"x1 "):
                break
        self.wfile.write(f"{tag} OK LOGIN completed\r\n".encode())
        self.wfile.flush()
        client = self.connection

        # both ways through the buffered readers (what they hold already first)
        def pump(reader, dst, src_sock):
            try:
                while True:
                    b = reader.read1(65536)
                    if not b:
                        break
                    dst.sendall(b)
            except OSError:
                pass
            for s_ in (src_sock, dst):
                try:
                    s_.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        t = threading.Thread(target=pump, args=(f, client, up), daemon=True)
        t.start()
        pump(self.rfile, up, client)
        t.join(5)


class Smtp(socketserver.StreamRequestHandler):
    def handle(self):
        w = lambda t: (self.wfile.write(t.encode() + b"\r\n"), self.wfile.flush())
        w("220 DavMail stand-in SMTP ready")
        user = None
        mail_from, rcpts = None, []
        while True:
            line = self.rfile.readline()
            if not line:
                return
            text = line.decode(errors="replace").rstrip("\r\n")
            cmd = text.split(" ", 1)[0].upper()
            arg = text[len(cmd):].strip()
            if cmd in ("EHLO", "HELO"):
                w("250-DavMail stand-in")
                w("250-AUTH PLAIN LOGIN")
                w("250 8BITMIME")
            elif cmd == "AUTH":
                mech, _, init = arg.partition(" ")
                if mech.upper() == "PLAIN":
                    if not init:
                        w("334 ")
                        init = self.rfile.readline().decode().strip()
                    parts = base64.b64decode(init).decode().split("\0")
                    u, p = parts[1], parts[2]
                elif mech.upper() == "LOGIN":
                    w("334 VXNlcm5hbWU6")
                    u = base64.b64decode(self.rfile.readline().strip()).decode()
                    w("334 UGFzc3dvcmQ6")
                    p = base64.b64decode(self.rfile.readline().strip()).decode()
                else:
                    w("504 unrecognized authentication type")
                    continue
                if (WHITE and u.lower() != WHITE) or not token_ok(u, p):
                    note(f"SMTP AUTH {u} NO")
                    w("535 authentication failed: no valid refresh token")
                else:
                    note(f"SMTP AUTH {u} OK")
                    user = u
                    w("235 authentication successful")
            elif cmd == "MAIL":
                if not user:
                    w("530 authentication required")
                    continue
                mail_from, rcpts = arg.split(":", 1)[1].strip().split(" ")[0].strip("<>"), []
                w("250 OK")
            elif cmd == "RCPT":
                rcpts.append(arg.split(":", 1)[1].strip().split(" ")[0].strip("<>"))
                w("250 OK")
            elif cmd == "DATA":
                w("354 end data with <CR><LF>.<CR><LF>")
                data = b""
                while True:
                    l = self.rfile.readline()
                    if l in (b".\r\n", b".\n", b""):
                        break
                    data += l[1:] if l.startswith(b"..") else l
                u, pw = upstream_user()
                h, p = hostport("SG_STANDIN_SMTP", "127.0.0.1:10025")
                with smtplib.SMTP(h, p, timeout=30) as up:
                    up.login(u, pw)
                    up.sendmail(mail_from, rcpts, data)
                # Exchange keeps the copy in Sent Items (davmail.smtpSaveInSent)
                ih, ip = hostport("SG_STANDIN_IMAP", "127.0.0.1:10143")
                c = imaplib.IMAP4(ih, ip)
                c.login(u, pw)
                c.create("Sent")
                c.append("Sent", r"(\Seen)", None, data)
                c.logout()
                note(f"SMTP DATA {mail_from} -> {','.join(rcpts)}")
                w("250 OK queued")
            elif cmd == "RSET":
                mail_from, rcpts = None, []
                w("250 OK")
            elif cmd == "NOOP":
                w("250 OK")
            elif cmd == "QUIT":
                w("221 bye")
                return
            else:
                w("502 command not implemented")


class Threaded(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


if not SIGNIN:
    for key, handler in (("davmail.imapPort", Imap), ("davmail.smtpPort", Smtp)):
        if props.get(key):
            srv_ = Threaded((BIND, int(props[key])), handler)
            threading.Thread(target=srv_.serve_forever, daemon=True).start()
            note(f"{key} listening {BIND}:{props[key]}")

WINDOW = None


def ended(*_):
    # ended (SG Mail's Cancel): DavMail's window goes with it
    if WINDOW:
        WINDOW.terminate()
    os._exit(0)


signal.signal(signal.SIGTERM, ended)
srv = http.server.ThreadingHTTPServer((BIND, PORT), H)
note(f"listening {BIND}:{PORT}")
print(f"DavMail stand-in listening on {BIND}:{PORT}", flush=True)
srv.serve_forever()
