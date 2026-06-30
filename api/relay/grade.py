#!/usr/bin/env python3
# Bio 305 deep-grade worker. Reads the /jobs JSON from stdin; grades each via `claude -p`;
# posts the verdict back. Invoked by grade-relay.sh:  print -r -- "$jobs" | python3 grade.py API SECRET CLAUDE
import sys, json, subprocess, urllib.request

api, secret, claude = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

for j in data.get("jobs", []):
    prompt = ("You are grading a college Genetics short-answer question. Be fair but rigorous. "
        'Respond with ONLY compact JSON, no prose: {"verdict":"correct|partial|incorrect","score":<0..1>,"note":"<=1 sentence why"}.\n\n'
        f"QUESTION:\n{j.get('question','')}\n\nMODEL ANSWER:\n{j.get('model_answer','')}\n\n"
        f"STUDENT ANSWER:\n{j.get('student_answer','')}\n")
    try:
        out = subprocess.run([claude, "-p", prompt], capture_output=True, text=True, timeout=150).stdout.strip()
        m = out[out.find("{"): out.rfind("}") + 1]
        v = json.loads(m)
        res = {"verdict": v.get("verdict"), "score": v.get("score"), "note": v.get("note")}
    except Exception as e:
        res = {"error": True, "note": str(e)[:140]}
    try:
        req = urllib.request.Request(api + "/jobs/" + j["id"] + "/result",
            data=json.dumps(res).encode(),
            headers={"content-type": "application/json", "x-relay-secret": secret,
                     "User-Agent": "Mozilla/5.0 (Macintosh) bio305-relay/1.0"}, method="POST")
        urllib.request.urlopen(req, timeout=20)
        print("graded", j["id"], res.get("verdict", res.get("error")))
    except Exception as e:
        print("post-fail", j["id"], e)
