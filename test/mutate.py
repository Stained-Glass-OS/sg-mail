#!/usr/bin/env python3
"""SG Mail's mutation check: each mutant (test/mutants.json) breaks one
thing a gate guards -- a copy of the extension with one change -- and that
gate, run against the copy, must FAIL. A mutant its gate passes means the
gate does not guard what it says.

  test/mutate.py [GATE...]        (only these gates' mutants)
  SG_MUTANTS=name,name ...        (only these mutants)

Copyright (C) 2026 Stained Glass OS contributors
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)
AREA = os.environ.get("SG_AREA", "/var/tmp/sgmail")
mutants = json.load(open(os.path.join(HERE, "mutants.json")))
gates = [os.path.basename(g) for g in sys.argv[1:]]
only = set(filter(None, os.environ.get("SG_MUTANTS", "").split(",")))
rc = 0
for m in mutants:
    if gates and m["gate"] not in gates:
        continue
    if only and m["name"] not in only:
        continue
    work = os.path.join(AREA, "mutants", m["name"])
    shutil.rmtree(work, ignore_errors=True)
    shutil.copytree(os.path.join(SRC, "extension"), os.path.join(work, "extension"))
    path = os.path.join(work, "extension", m["file"])
    text = open(path).read()
    if text.count(m["find"]) != 1:
        print(f"MUTANT {m['name']}: the text to change is in {m['file']} {text.count(m['find'])} times, not once")
        rc = 1
        continue
    open(path, "w").write(text.replace(m["find"], m["replace"]))
    env = dict(os.environ, SG_NONET="1", SG_CWD=SRC, SG_MAIL_EXTENSION=os.path.join(work, "extension"))
    log = os.path.join(work, "gate.log")
    with open(log, "w") as f:
        # the checkout is seen elsewhere inside the root: the gate by its relative path
        r = subprocess.run(["sh", os.path.join(SRC, "build/inroot.sh"), "python3", "-u", os.path.join("test/gate", m["gate"])],
                           env=env, stdout=f, stderr=subprocess.STDOUT, timeout=900)
    lines = open(log).read().split("\n")
    fails = [l.strip() for l in lines if l.startswith("FAIL") or l.startswith("TimeoutError") or "Error:" in l[:40]][:3]
    ran = any(l.startswith("PASS") or l.startswith("FAIL") for l in lines)
    if not ran:
        print(f"BROKEN  {m['name']} ({m['gate']}): the gate did not run -- {log}")
        rc = 1
    elif r.returncode != 0:
        print(f"KILLED  {m['name']} ({m['gate']}): {fails[0] if fails else 'gate failed'}")
    else:
        print(f"SURVIVED {m['name']} ({m['gate']}): the gate passed with {m['why']} -- {log}")
        rc = 1
print("RESULT:", "PASS" if rc == 0 else "FAIL")
sys.exit(rc)
