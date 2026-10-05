#!/usr/bin/env python3
"""trademark-check: SG Mail never names itself, or anything of ours, with
Microsoft's marks. Fails on "Outlook" or "Windows" (whole words) in the text
a person can see: our pages and scripts outside comments, the desktop entry,
the AppStream metadata and the package description. Comments may compare.

  tools/trademark-check.py PATH...

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import os
import re
import sys

# naming Microsoft's own mail service to say we connect to it is fine:
# "Outlook.com" (the service), never "Outlook" for anything of ours
WORD = re.compile(r"(?<![A-Za-z0-9_])(Outlook(?!\.com)|Windows)(?![A-Za-z0-9_])")


def strip_comments(text, ext):
    if ext in (".js", ".css", ".json"):
        text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
        text = re.sub(r"(^|[^:\"'\\])//[^\n]*", r"\1", text)
    if ext in (".html", ".xml"):
        text = re.sub(r"<!--.*?-->", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    if ext in (".desktop", ".js", "") or os.path.basename(ext) == "control":
        text = re.sub(r"(?m)^\s*#.*$", "", text)
    return text


def main(paths):
    bad = 0
    files = []
    for p in paths:
        if os.path.isdir(p):
            for d, _, names in os.walk(p):
                files += [os.path.join(d, n) for n in names]
        else:
            files.append(p)
    for f in files:
        ext = os.path.splitext(f)[1]
        if ext not in (".js", ".html", ".css", ".json", ".desktop", ".xml", "") or f.endswith(".svg"):
            continue
        try:
            text = open(f, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(strip_comments(text, ext).split("\n"), 1):
            if WORD.search(line):
                print(f"{f}:{n}: {line.strip()[:160]}")
                bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
