"""SG Mail's test SMTP server (aiosmtpd): AUTH PLAIN/LOGIN against the
gate's users, no TLS. Every message it is given is kept (DIR/N.eml with its
envelope in DIR/N.json) and delivered to the inboxes of the gate's own users
(IMAP APPEND to the test Dovecot), so a sent message can be received.

  smtp_server.py PORT DIR USERS_JSON IMAP_PORT

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import asyncio
import imaplib
import json
import os
import sys
import time

from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult, LoginPassword

PORT, DIR, USERS, IMAP_PORT = int(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3]), int(sys.argv[4])
counter = [0]


def authenticator(server, session, envelope, mechanism, auth_data):
    if isinstance(auth_data, LoginPassword):
        user = auth_data.login.decode()
        if USERS.get(user) == auth_data.password.decode():
            return AuthResult(success=True, auth_data=user)
    return AuthResult(success=False, handled=False)


class Handler:
    async def handle_DATA(self, server, session, envelope):
        counter[0] += 1
        n = counter[0]
        raw = envelope.original_content or envelope.content
        with open(os.path.join(DIR, f"{n}.eml"), "wb") as f:
            f.write(raw)
        with open(os.path.join(DIR, f"{n}.json"), "w") as f:
            json.dump({"n": n, "from": envelope.mail_from, "rcpt": envelope.rcpt_tos,
                       "auth": session.auth_data if isinstance(session.auth_data, str) else None,
                       "raw": raw.decode("utf-8", "replace")}, f)
        for rcpt in envelope.rcpt_tos:
            if rcpt in USERS:
                try:
                    c = imaplib.IMAP4("127.0.0.1", IMAP_PORT)
                    c.login(rcpt, USERS[rcpt])
                    c.append("INBOX", None, imaplib.Time2Internaldate(time.time()), raw)
                    c.logout()
                except Exception as e:
                    print("delivery to", rcpt, "failed:", e, flush=True)
        print("received", n, envelope.mail_from, envelope.rcpt_tos, flush=True)
        return "250 OK"


controller = Controller(Handler(), hostname="127.0.0.1", port=PORT, authenticator=authenticator,
                        auth_required=True, auth_require_tls=False)
controller.start()
print("listening", PORT, flush=True)
try:
    asyncio.get_event_loop().run_forever() if False else time.sleep(10 ** 7)
finally:
    controller.stop()
