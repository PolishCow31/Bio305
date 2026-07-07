#!/usr/bin/env python3
"""Integrate generation-workflow survivor cards into the live decks.
Usage: python3 integrate_cards.py <workflow-output-file.json>
Parses {result:{L1:[],L2:[],L3:[]}}, assigns ids, dedups vs existing + each other,
validates tags, writes data/L{n}.json, authors content/L{n}.md, flips L3 live in units.json."""
import json, os, re, sys
import lib

def load_result(path):
    o = json.load(open(path))
    # workflow output file is pretty-printed {summary,result:{...}} ; or a bare {L1,L2,L3}
    return o.get("result", o) if isinstance(o, dict) else {}

def clean_card(c, allowed):
    t = c.get("type")
    if t not in ("recall","concept","problem"): t = "concept"
    card = {"type": t, "topic": (c.get("topic") or "general")[:60],
            "diff": int(c.get("diff") or 2), "target_s": int(c.get("target_s") or 12),
            "src": c.get("src") or "", "q": (c.get("q") or "").strip()}
    if t == "problem":
        card["worked"] = (c.get("worked") or "").strip()
        card["answer"] = (c.get("answer") or "").strip()
    else:
        card["a"] = (c.get("a") or c.get("answer") or "").strip()
    tags = lib.valid_tags(c.get("tags"), allowed)
    if len(tags) < 1: tags = ["foundations"]
    card["tags"] = tags[:5]
    return card

def md_block(c):
    head = f'### {c["id"]} · {c["type"]} · {c["topic"]} · diff {c["diff"]} · t:{c["target_s"]}s · src: {c["src"]}'
    tags = f'`tags:` {", ".join(c["tags"])}'
    if c["type"] == "problem":
        body = f'**Q:** {c["q"]}\n\n**Worked:** {c.get("worked","")}\n\n**Answer:** {c.get("answer","")}'
    else:
        body = f'**Q:** {c["q"]}\n\n**A:** {c.get("a","")}'
    return f'{head}\n{tags}\n\n{body}\n'

def integrate(lec, cards, allowed):
    fname = f"L{lec}.json"; path = os.path.join(lib.DATA, fname)
    existing = json.load(open(path)) if os.path.exists(path) else []
    ex_ids = [c["id"] for c in existing]
    seen_q = {lib.dedup_key(c) for c in existing}
    added = []
    for raw in cards:
        c = clean_card(raw, allowed)
        if not c["q"] or len(c["q"]) < 8: continue
        k = lib.dedup_key(c)
        if k in seen_q: continue
        seen_q.add(k)
        c["id"] = lib.next_id(lec, c["type"], ex_ids)
        ex_ids.append(c["id"]); added.append(c)
    merged = existing + added
    json.dump(merged, open(path, "w"), indent=1, ensure_ascii=False)
    return merged, added

def author_doc(lec, merged):
    """(Re)write content/L{n}.md as the human-readable source of truth from the cards."""
    docpath = os.path.join(lib.CONTENT, f"L{lec}.md")
    # Don't clobber a rich hand-written L1/L2 doc; only (re)generate the card-bank section for L3+ or if absent.
    if lec >= 3 or not os.path.exists(docpath):
        title = {1:"Introduction & DNA",2:"Replication",3:"Transcription & RNA Processing"}.get(lec, f"Lecture {lec}")
        header = (f"# L{lec} — {title} · card bank\n\n"
                  f"Auto-assembled from the generation workflow (skeptic-verified against this semester's "
                  f"readings/lecture/discussion). {len(merged)} cards. Schema: see HANDOFF.\n\n---\n\n")
        body = "\n".join(md_block(c) for c in merged)
        open(docpath, "w").write(header + body)
        return docpath
    return None

def flip_live(lec):
    upath = os.path.join(lib.DATA, "units.json")
    units = json.load(open(upath))
    for u in units:
        for L in u.get("lectures", []):
            if L.get("n") == lec:
                L["status"] = "live"; L["file"] = f"L{lec}.json"
    json.dump(units, open(upath, "w"), indent=1, ensure_ascii=False)

def main():
    if len(sys.argv) < 2:
        print("usage: integrate_cards.py <workflow-output.json>"); sys.exit(1)
    result = load_result(sys.argv[1])
    allowed = set(lib.tag_ids())
    summary = {}
    for lec in (1, 2, 3):
        cards = result.get(f"L{lec}") or []
        if not cards: continue
        merged, added = integrate(lec, cards, allowed)
        doc = author_doc(lec, merged)
        if lec == 3 and added: flip_live(3)
        summary[f"L{lec}"] = {"added": len(added), "total": len(merged), "doc": bool(doc)}
        lib.log("integrate", lec=lec, added=len(added), total=len(merged))
    print(json.dumps(summary, indent=1))

if __name__ == "__main__":
    main()
