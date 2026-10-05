#!/usr/bin/env python3
"""check-schema: every function and event the experiment's schema promises
is implemented in parent.js (a name missing there fails only when called).

  tools/check-schema.py schema.json parent.js

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import json
import re
import sys

schema = json.load(open(sys.argv[1]))
code = open(sys.argv[2]).read()
missing = []
for ns in schema:
    for f in ns.get("functions", []):
        if not re.search(r"\basync\s+%s\s*\(" % re.escape(f["name"]), code):
            missing.append(f["name"])
    for e in ns.get("events", []):
        if not re.search(r"\b%s:\s*new ExtensionCommon\.EventManager" % re.escape(e["name"]), code):
            missing.append(e["name"])
if missing:
    print("schema names parent.js does not implement:", ", ".join(missing))
    sys.exit(1)
