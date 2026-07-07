#!/usr/bin/env python3
"""CyBio305 folder-watch generator — hashes every file under ~/Desktop/Bio305/Unit*/Lec*/,
and when NEW or CHANGED source material appears, drafts cards with `claude -p` + a skeptic
pass, and stages the survivors in engine/pending-cards.json for review (the Health panel
surfaces the pending count). Does NOT auto-inject into live study decks.
Run with --seed to just record current hashes (no generation). launchd: com.bio305.contentwatch, hourly."""
import json, os, re, sys, time, glob
import lib

MANIFEST = os.path.join(lib.ENGINE, "watch.manifest.json")
PENDING  = os.path.join(lib.ENGINE, "pending-cards.json")
# file kinds worth regenerating from (skip the huge slide PDFs — text extraction is unreliable here)
SRC_RE = re.compile(r"Lec(\d+)(T\.md|R\.pdf|D\.pdf|HW\.pdf)$", re.I)

def scan():
    out = {}
    for path in glob.glob(os.path.join(lib.UNITS, "Unit *", "Lec*", "*")):
        if os.path.isfile(path) and SRC_RE.search(os.path.basename(path)):
            out[path] = lib.md5(path)
    # also the pre-extracted readings the generators actually prefer
    for path in glob.glob(os.path.join(lib.READINGS, "L*-reading.md")):
        out[path] = lib.md5(path)
    return out

def lecture_of(path):
    m = re.search(r"Lec(\d+)|/L(\d+)-reading", path)
    return int(m.group(1) or m.group(2)) if m else None

def load_json(p, default):
    try: return json.load(open(p))
    except Exception: return default

def gen_for_lecture(lec, changed_paths):
    # prefer the clean markdown sources for this lecture
    srcs = [p for p in changed_paths if p.endswith(".md")]
    srcs += [p for p in glob.glob(os.path.join(lib.READINGS, f"L{lec}-reading.md"))]
    srcs = list(dict.fromkeys(srcs))[:3]
    if not srcs:
        lib.log("watch_nosrc", lec=lec); return []
    corpus = "\n\n".join(f"===== {os.path.basename(s)} =====\n{lib.read(s, 24000)}" for s in srcs)
    tax = ", ".join(lib.tag_ids())
    style = lib.read(lib.STYLE, 4000)
    gen_prompt = (
      f"Author 8 genetics study cards for CyBio305 (BIO 305 Lecture {lec}) STRICTLY from the source text below "
      "(this semester's material — do not add outside topics). Mix recall/concept flip cards and 1-2 typed worked "
      "problems (type:problem with q, worked, answer — verify the answer). Match this instructor's exam style but "
      f"NOT as multiple choice:\n{style}\n\nUse ONLY these tag ids (2-5 per card): {tax}\n\n"
      'Respond with ONLY JSON: {"cards":[{"type","topic","diff","target_s","src","q","a"(recall/concept) OR '
      '"worked"+"answer"(problem),"tags":[...]}]}\n\nSOURCES:\n' + corpus)
    gen = lib.claude_json(gen_prompt, timeout=280)
    cards = gen.get("cards", []) if isinstance(gen, dict) else (gen if isinstance(gen, list) else [])
    if not cards:
        lib.log("watch_gen_empty", lec=lec); return []
    # adversarial skeptic pass
    sk_prompt = (
      f"You are an adversarial skeptic. These {len(cards)} candidate cards were drafted for BIO 305 Lecture {lec} "
      "from the assigned material. KILL any card that is off-topic for the lecture, factually wrong, or (for problems) "
      "has an answer you cannot independently confirm. Fix small errors. Ensure 2-5 valid tags each from: " + tax + ".\n"
      'Return ONLY JSON {"cards":[...survivors, corrected...]}. Fewer, bulletproof cards beats more shaky ones.\n\n'
      + json.dumps(cards))
    sk = lib.claude_json(sk_prompt, timeout=280)
    survivors = sk.get("cards", []) if isinstance(sk, dict) else (sk if isinstance(sk, list) else [])
    allowed = set(lib.tag_ids())
    for c in survivors:
        c["tags"] = lib.valid_tags(c.get("tags"), allowed) or ["foundations"]
        c["_lecture"] = lec; c["_source"] = "folder-watch"; c["_addedAt"] = int(time.time()*1000)
    lib.log("watch_generated", lec=lec, drafted=len(cards), survivors=len(survivors))
    return survivors

def main():
    seed = "--seed" in sys.argv
    cur = scan()
    prev = load_json(MANIFEST, {})
    changed = [p for p, h in cur.items() if prev.get(p) != h]
    lib.log("watch_scan", files=len(cur), changed=len(changed), seed=seed)
    if seed or not prev:
        json.dump(cur, open(MANIFEST, "w"), indent=1)
        print(f"watch: seeded manifest with {len(cur)} files (no generation)"); return
    if not changed:
        print("watch: no changes"); return
    # group changed files by lecture
    bylec = {}
    for p in changed:
        lc = lecture_of(p)
        if lc: bylec.setdefault(lc, []).append(p)
    pend = load_json(PENDING, {"updatedAt": 0, "cards": []})
    seen_q = {lib.dedup_key(c) for c in pend["cards"]}
    added = 0
    for lec, paths in sorted(bylec.items()):
        for c in gen_for_lecture(lec, paths):
            k = lib.dedup_key(c)
            if k in seen_q: continue
            seen_q.add(k); pend["cards"].append(c); added += 1
    pend["updatedAt"] = int(time.time()*1000)
    json.dump(pend, open(PENDING, "w"), indent=1, ensure_ascii=False)
    json.dump(cur, open(MANIFEST, "w"), indent=1)
    print(f"watch: {added} new pending cards from {len(bylec)} lecture(s) -> engine/pending-cards.json")

if __name__ == "__main__":
    main()
