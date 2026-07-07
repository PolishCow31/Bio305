#!/usr/bin/env python3
"""CyBio305 critic fleet — spawns claude -p critics with distinct lenses over the live decks,
merges their findings into data/system-health.json, which the site's Health panel renders.
Run ad hoc or via launchd (com.bio305.critics). Ongoing cadence: every 6h."""
import json, os, time
from concurrent.futures import ThreadPoolExecutor
import lib

def card_line(c):
    ans = c.get("a") or ((c.get("answer","") + " || " + c.get("worked","")).strip(" |"))
    return f'{c["id"]} [{c["type"]}/L{c.get("lecture","?")}] tags={",".join(c.get("tags",[]))} :: Q: {c.get("q","")[:180]} :: A: {ans[:220]}'

LENSES = [
  ("correctness",
   "You are a rigorous genetics professor auditing flashcards for FACTUAL ERRORS. Find cards whose answer is wrong, misleading, or imprecise enough to cost exam points. For problem cards, sanity-check the answer. Only report real errors."),
  ("relevance",
   "You are auditing whether these cards fit an intro molecular-genetics course (Unit 1: DNA structure, replication, transcription). Flag cards that are off-topic, generic trivia untied to the course, or oddly specific in a way that suggests reverse-engineering from one past exam rather than the curriculum."),
  ("tags",
   "You are auditing TAG quality for an adaptive study app. Using ONLY the taxonomy provided, flag cards whose tags are missing, too few (<2), wrong, or that omit an obvious cross-cutting skill tag (directionality, who-what-when, mechanism, technique, calculation, compare-contrast, figure-interpretation, exceptions). Suggest the fix."),
  ("balance",
   "You are auditing the deck for DUPLICATION and COVERAGE BALANCE. Flag near-duplicate cards (report both ids), and note any topic that is clearly over- or under-represented relative to its exam weight. Keep it high-signal."),
]

def run_lens(name, instruction, cards, tax):
    lines = "\n".join(card_line(c) for c in cards)
    taxblock = ("\nTAXONOMY (valid tag ids): " + ", ".join(t["id"] for t in tax)) if name=="tags" else ""
    prompt = (f"{instruction}{taxblock}\n\n"
      "Respond with ONLY compact JSON, no prose:\n"
      '{"findings":[{"severity":"high|warn|low|info","area":"<short>","cardId":"<id or omit>","msg":"<one sentence>","fix":"<optional one-sentence fix>"}]}\n'
      "Report at most 8 findings, highest-signal first. If the deck looks clean for your lens, return {\"findings\":[]}.\n\n"
      f"CARDS ({len(cards)}):\n{lines}")
    res = lib.claude_json(prompt, timeout=240)
    out = res.get("findings", []) if isinstance(res, dict) else (res if isinstance(res, list) else [])
    for f in out: f["lens"] = name
    lib.log("critic_lens", lens=name, findings=len(out))
    return out

def main():
    cards = lib.load_live_cards()
    tax = lib.taxonomy()
    if not cards:
        lib.log("critic_nocards"); return
    findings = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = [ex.submit(run_lens, n, ins, cards, tax) for n, ins in LENSES]
        for fu in futs:
            try: findings.extend(fu.result())
            except Exception as e: lib.log("critic_fail", err=str(e)[:120])
    # normalize severity + de-dupe identical msgs
    seen=set(); clean=[]
    for f in findings:
        key=(f.get("cardId"), (f.get("msg") or "")[:60])
        if key in seen: continue
        seen.add(key)
        sev=(f.get("severity") or "info").lower()
        if sev not in ("critical","high","warn","medium","low","info"): sev="info"
        f["severity"]=sev; clean.append(f)
    order={"critical":0,"high":1,"warn":2,"medium":3,"low":4,"info":5}
    clean.sort(key=lambda f: order.get(f["severity"],9))
    health = {"generatedAt": int(time.time()*1000),
              "stats": {"cards": len(cards), "critics": len(LENSES), "tags": len(tax)},
              "findings": clean}
    with open(os.path.join(lib.DATA, "system-health.json"), "w") as f:
        json.dump(health, f, indent=1, ensure_ascii=False)
    lib.log("critic_done", cards=len(cards), findings=len(clean))
    print(f"critic-fleet: {len(clean)} findings over {len(cards)} cards -> data/system-health.json")

if __name__ == "__main__":
    main()
