#!/usr/bin/env python3
"""CyBio305 content-engine shared helpers.
Persistent routines (critic-fleet, watch-folders) share these. All generation shells to
`claude -p` (covered by the Max subscription; no API key). No secrets live here."""
import os, re, json, subprocess, hashlib, time

HOME     = os.path.expanduser("~")
SITE     = os.path.join(HOME, "Sites/Bio305")
DATA     = os.path.join(SITE, "data")
ENGINE   = os.path.join(SITE, "engine")
PROJ     = os.path.join(HOME, "Desktop/Bio305/-CyBio305")
CONTENT  = os.path.join(PROJ, "content")
READINGS = os.path.join(PROJ, "readings")
UNITS    = os.path.join(HOME, "Desktop/Bio305")            # holds "Unit 1/Lec3/..." etc.
CLAUDE   = os.path.join(HOME, ".npm-global/bin/claude")
LOG      = os.path.join(ENGINE, "gen-log.jsonl")
STYLE    = os.path.join(CONTENT, "exam-style-guide.md")

def log(event, **kw):
    rec = {"ts": int(time.time()*1000), "event": event}; rec.update(kw)
    try:
        with open(LOG, "a") as f: f.write(json.dumps(rec) + "\n")
    except Exception: pass
    print(f"[{event}] " + " ".join(f"{k}={v}" for k, v in kw.items()), flush=True)

def read(path, limit=None):
    try:
        with open(path) as f: t = f.read()
        return t[:limit] if limit else t
    except Exception: return ""

def claude_json(prompt, timeout=240, tries=2):
    """Run `claude -p`, return the first JSON value found (dict/list), or None."""
    for attempt in range(tries):
        try:
            out = subprocess.run([CLAUDE, "-p", prompt], capture_output=True, text=True,
                                 timeout=timeout).stdout.strip()
            # tolerate ```json fences and leading prose
            out = re.sub(r"^```(json)?|```$", "", out.strip(), flags=re.M).strip()
            # 1) try the whole cleaned string (handles {"findings":[...]} correctly)
            try: return json.loads(out)
            except Exception: pass
            # 2) fall back to the LONGEST balanced {..} or [..] span
            cands = []
            for opn, cls in (("{", "}"), ("[", "]")):
                i, j = out.find(opn), out.rfind(cls)
                if 0 <= i < j: cands.append(out[i:j+1])
            for c in sorted(cands, key=len, reverse=True):
                try: return json.loads(c)
                except Exception: continue
        except subprocess.TimeoutExpired:
            log("claude_timeout", attempt=attempt)
        except Exception as e:
            log("claude_error", attempt=attempt, err=str(e)[:120])
        time.sleep(2)
    return None

def taxonomy():
    tg = json.loads(read(os.path.join(DATA, "tags.json")) or '{"tags":[]}')
    return tg.get("tags", [])

def tag_ids():
    return [t["id"] for t in taxonomy()]

def units_json():
    return json.loads(read(os.path.join(DATA, "units.json")) or "[]")

def live_lectures():
    out = []
    for u in units_json():
        for L in u.get("lectures", []):
            if L.get("status") == "live" and L.get("file"): out.append(L)
    return out

def load_deck(fname):
    return json.loads(read(os.path.join(DATA, fname)) or "[]")

def load_live_cards():
    cards = []
    for L in live_lectures():
        for c in load_deck(L["file"]):
            c["lecture"] = L["n"]; cards.append(c)
    return cards

def md5(path):
    try:
        with open(path, "rb") as f: return hashlib.md5(f.read()).hexdigest()
    except Exception: return None

def valid_tags(ids, allowed=None):
    allowed = set(allowed or tag_ids())
    return [t for t in (ids or []) if t in allowed]

def next_id(lecture, kind, existing_ids):
    """L{n}-{R|C|P}NNN, first free number for that prefix."""
    pre = f"L{lecture}-{'R' if kind=='recall' else 'C' if kind=='concept' else 'P'}"
    nums = [int(m.group(1)) for cid in existing_ids
            for m in [re.match(re.escape(pre) + r"(\d+)$", cid)] if m]
    n = (max(nums) + 1) if nums else 1
    return f"{pre}{n:03d}"

def dedup_key(card):
    q = re.sub(r"[^a-z0-9]", "", (card.get("q") or "").lower())
    return q[:60]
