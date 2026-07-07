/* Bio 305 sync-core — pure, dependency-free SRS scheduler + CRDT merge.
   Shared by store.js (live grading) and the node test harness (behavior-preservation +
   convergence proofs). No browser globals: `byId` and `EXAM_I` are passed in; DAY is a
   universal constant. Every function here is pure so the deployed math is what gets tested.

   Merge model: each card's hist[] (event list) is the source of truth. Derived SRS state and
   tag weights are recomputed by replaying the merged events -> two devices always converge. */
(function(root){
  "use strict";
  const DAY = 86400000;
  // Tag-weight tuning (single source of truth; store.js delegates its live bumpTags here).
  const TAG_DEF=1.0, TAG_MISS=0.6, TAG_HARD=0.15, TAG_MAX=4.0, TAG_FLOOR=0.45;

  // Flip-card scheduler (Anki 1-4). Mutates+returns s. Identical to the pre-refactor grade()
  // math except `due` is computed from the event ts (== now at live grade-time).
  function applyFlip(s, g, ts, EXAM_I){
    if(g===1){ s.lapses++; s.ease=Math.max(1.3,s.ease-0.2); s.ivl=0; s.due=ts+45*1000; }
    else{
      if(g===2){ s.ease=Math.max(1.3,s.ease-0.15); s.ivl = s.reps===0?1:Math.max(1,s.ivl*1.2); }
      else if(g===3){ s.ivl = s.reps===0?1:Math.max(1,s.ivl*s.ease); }
      else if(g===4){ s.ease+=0.05; s.ivl = s.reps===0?2:Math.max(2,s.ivl*s.ease*1.3); }
      s.reps++;
      const capDays = Math.max(1, Math.ceil((EXAM_I-ts)/DAY));   // exam-aware: never past Exam I
      s.ivl = Math.min(s.ivl, capDays);
      s.due = ts + s.ivl*DAY;
    }
    s.seen=true; return s;
  }
  // Problem scheduler. Identical to pre-refactor logProblem() except due from ts.
  function applyProblem(s, correct, ts, EXAM_I){
    s.seen=true; s.reps++; if(!correct) s.lapses++;
    const capDays = Math.max(1, Math.ceil((EXAM_I-ts)/DAY));
    s.ivl = correct ? Math.min(capDays, s.reps===1?2:Math.max(2,(s.ivl||2)*2)) : 0;
    s.due = correct ? ts+s.ivl*DAY : ts+60*1000;
    return s;
  }
  const kindOf = (id, ev, byId) => ev.kind || (byId[id] && byId[id].type==="problem" ? "problem":"flip");

  // Total event ordering: ts, then device, then grade. A total order (not just ts) is what makes
  // the merge commutative even when two devices stamp the same millisecond.
  const evCmp = (a,b)=> a.ts-b.ts
    || ((a.dev||"")<(b.dev||"")?-1:(a.dev||"")>(b.dev||"")?1:0)
    || (a.grade||0)-(b.grade||0);

  // Replay a card's merged event stream -> derived SRS state (hist is authoritative).
  function replayCard(id, events, byId, EXAM_I){
    const s = {reps:0,lapses:0,ease:2.3,ivl:0,due:0,seen:false,hist:[]};
    const evs = events.slice().sort(evCmp);
    evs.forEach(ev=>{
      if(kindOf(id,ev,byId)==="problem") applyProblem(s, ev.correct, ev.ts, EXAM_I);
      else applyFlip(s, ev.grade, ev.ts, EXAM_I);
    });
    s.hist = evs; return s;
  }

  // Apply one grade's tag-weight bump in place. Used by live grading AND recompute.
  function bumpTagInto(tagW, tags, g){
    (tags||[]).forEach(t=>{
      let w = tagW[t]==null ? TAG_DEF : tagW[t];
      if(g<=1)       w = Math.min(TAG_MAX, w + TAG_MISS);
      else if(g===2) w = Math.min(TAG_MAX, w + TAG_HARD);
      else if(g===3) w = w + (TAG_DEF  - w)*0.18;
      else           w = w + (TAG_FLOOR - w)*0.25;
      tagW[t] = Math.round(w*1000)/1000;
    });
    return tagW;
  }
  // Recompute all tag weights by replaying bumpTagInto over the GLOBAL event stream in ts order.
  function recomputeTagW(srsMap, byId){
    const evs=[];
    for(const id in srsMap){ (srsMap[id].hist||[]).forEach(e=>evs.push({id,e})); }
    evs.sort((a,b)=>evCmp(a.e,b.e));
    const tagW={};
    evs.forEach(({id,e})=>{ const card=byId[id]; if(card&&card.tags) bumpTagInto(tagW, card.tags, e.grade); });
    return tagW;
  }

  // Dedup key: dev-stamped events are globally unique; legacy events (no dev) are single-origin
  // so a ts+grade fallback is safe.
  // Include grade so two distinct same-device/same-ms events can't collapse into one (no-loss).
  const evKey = e => (e.dev||"L")+":"+e.ts+":"+e.grade;

  // Merge two states into a convergent result. Commutative + idempotent (an OR-set of events
  // + deterministic fold = a CRDT). Union events per card -> replay; union sessions; LWW settings;
  // recompute tagW from merged events (or keep the non-empty side if decks aren't loaded yet).
  function mergeState(a, b, byId, cardsLen, EXAM_I){
    a=a||{}; b=b||{};
    const out={ srs:{}, sessions:[], settings:{}, tagW:{}, schema:2 };
    const ids=new Set([...Object.keys(a.srs||{}), ...Object.keys(b.srs||{})]);
    ids.forEach(id=>{
      const ha=(a.srs&&a.srs[id]&&a.srs[id].hist)||[], hb=(b.srs&&b.srs[id]&&b.srs[id].hist)||[];
      const seen={}, merged=[];
      ha.concat(hb).forEach(e=>{ if(!e || !isFinite(e.ts)) return;   // drop malformed events (no NaN due)
        const k=evKey(e); if(!seen[k]){ seen[k]=1; merged.push(e); } });
      out.srs[id]=replayCard(id, merged, byId||{}, EXAM_I);
    });
    const sseen={};   // dedup EXACT duplicates (same session synced back); keep every distinct one
    (a.sessions||[]).concat(b.sessions||[]).forEach(x=>{ const k=JSON.stringify(x); if(!sseen[k]){ sseen[k]=1; out.sessions.push(x); } });
    out.sessions.sort((x,y)=> x.ts-y.ts || (JSON.stringify(x)<JSON.stringify(y)?-1:1));   // total order -> commutative
    // settings: LWW by updatedAt, with a deterministic content tiebreak on equal stamps (commutative).
    const sa=a.settings||{}, sb=b.settings||{}, ua=sa.updatedAt||0, ub=sb.updatedAt||0;
    const winner = ub>ua ? sb : ua>ub ? sa : (JSON.stringify(sb)>JSON.stringify(sa) ? sb : sa);
    out.settings = Object.assign({}, winner);
    out.tagW = cardsLen ? recomputeTagW(out.srs, byId||{})
             : (Object.keys(a.tagW||{}).length ? a.tagW : (b.tagW||{}));
    return out;
  }

  const API = { DAY, TAG_DEF, TAG_MISS, TAG_HARD, TAG_MAX, TAG_FLOOR,
    applyFlip, applyProblem, kindOf, replayCard, bumpTagInto, recomputeTagW, evKey, mergeState };
  if(typeof module!=="undefined" && module.exports) module.exports = API;   // node (tests)
  root.SyncCore = API;                                                       // browser
})(typeof globalThis!=="undefined" ? globalThis : this);
