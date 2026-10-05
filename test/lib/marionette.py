"""A small Marionette client: the gates drive Thunderbird's chrome with it
(add the test servers' logins, look at windows, run our page's functions
when the profile keeps extensions in the main process).

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import json
import socket
import time


class MarionetteError(Exception):
    pass


class Marionette:
    def __init__(self, host="127.0.0.1", port=2828, timeout=60):
        deadline = time.time() + timeout
        while True:
            try:
                self.sock = socket.create_connection((host, port), timeout=5)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)
        self.sock.settimeout(120)
        self.buf = b""
        self.msgid = 0
        self._recv()  # hello
        self.command("WebDriver:NewSession", {"capabilities": {}})
        self.command("Marionette:SetContext", {"value": "chrome"})

    def _recv(self):
        while b":" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise MarionetteError("connection closed")
            self.buf += chunk
        n, rest = self.buf.split(b":", 1)
        n = int(n)
        while len(rest) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise MarionetteError("connection closed")
            rest += chunk
        self.buf = rest[n:]
        return json.loads(rest[:n].decode("utf-8"))

    def command(self, name, params=None):
        self.msgid += 1
        data = json.dumps([0, self.msgid, name, params or {}]).encode("utf-8")
        self.sock.sendall(str(len(data)).encode() + b":" + data)
        while True:
            msg = self._recv()
            if isinstance(msg, list) and msg[0] == 1 and msg[1] == self.msgid:
                if msg[2]:
                    raise MarionetteError(json.dumps(msg[2])[:2000])
                return msg[3]

    def js(self, script, args=None, timeout_ms=60000):
        """Run an async chrome script: it gets `args` and must call
        `resolve(value)` (the last argument), as WebDriver:ExecuteAsyncScript."""
        self.command("WebDriver:SetTimeouts", {"script": timeout_ms})
        wrapped = ("const resolve = arguments[arguments.length - 1];"
                   "const args = arguments[0];"
                   "(async () => {" + script + "})().then(v => resolve({ok: v}), e => resolve({error: String(e) + '\\n' + (e && e.stack || '')}));")
        res = self.command("WebDriver:ExecuteAsyncScript", {"script": wrapped, "args": [args]})
        value = res.get("value") if isinstance(res, dict) else res
        if isinstance(value, dict) and "error" in value:
            raise MarionetteError(value["error"])
        return value.get("ok") if isinstance(value, dict) else value

    def quit(self):
        try:
            self.command("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
