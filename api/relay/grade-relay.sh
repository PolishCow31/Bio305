#!/bin/zsh
# Bio 305 deep-grade relay. Drains pending grade jobs from the Worker, grades each with
# `claude -p`, posts the verdict back. Run on an interval by launchd (see the .plist).
# Needs env: BIO305_API (Worker base URL), BIO305_RELAY_SECRET. Single-pass + lockfile so
# overlapping launchd runs don't double-grade.

API="${BIO305_API:?set BIO305_API}"
SECRET="${BIO305_RELAY_SECRET:?set BIO305_RELAY_SECRET}"
CLAUDE="/Users/christian/.npm-global/bin/claude"
LOCK="/tmp/bio305-relay.lock"

[ -e "$LOCK" ] && exit 0
trap 'rm -f "$LOCK"' EXIT
touch "$LOCK"

jobs=$(curl -s -H "x-relay-secret: $SECRET" "$API/jobs")
[ -z "$jobs" ] && exit 0

print -r -- "$jobs" | python3 - "$API" "$SECRET" "$CLAUDE" <<'PY'
import sys, json, subprocess, urllib.request
api, secret, claude = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for j in data.get("jobs", []):
    prompt = ("You are grading a college Genetics short-answer question. Be fair but rigorous. "
        'Respond ONLY with compact JSON: {"verdict":"correct|partial|incorrect","score":<0..1>,"note":"<=1 sentence"}.\n\n'
        f"QUESTION:\n{j.get('question','')}\n\nMODEL ANSWER:\n{j.get('model_answer','')}\n\n"
        f"STUDENT ANSWER:\n{j.get('student_answer','')}\n")
    try:
        out = subprocess.run([claude, "-p", prompt], capture_output=True, text=True, timeout=150).stdout.strip()
        m = out[out.find("{"): out.rfind("}") + 1]
        v = json.loads(m)
        res = {"verdict": v.get("verdict"), "score": v.get("score"), "note": v.get("note")}
    except Exception as e:
        res = {"error": True, "note": str(e)[:140]}
    req = urllib.request.Request(f"{api}/jobs/{j['id']}/result",
        data=json.dumps(res).encode(),
        headers={"content-type": "application/json", "x-relay-secret": secret}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=20)
        print("graded", j["id"], res.get("verdict", res.get("error")))
    except Exception as e:
        print("post-fail", j["id"], e)
PY
