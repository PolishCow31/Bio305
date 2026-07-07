/* Bio 305 — store: data, SRS scheduling, stats, local grading. Vanilla, localStorage-backed.
   Designed so a cloud sync layer can later read/write the same `state` blob. */
const Store = (function(){
  const KEY = "bio305.v1";
  const EXAM_I = new Date(2026,6,20).getTime();   // Mon Jul 20 2026 (month is 0-based)
  const DAY = 86400000;
  // Adaptive tag-weight baseline; the miss/hard/decay params live in sync-core (bumpTagInto),
  // single-sourced so live grading and merge-replay can never drift.
  const TAG_DEF=1.0;
  // Sync timing: poll while visible, throttle pushes well under the KV write cap.
  const POLL_INTERVAL=10000, PUSH_MIN=20000;
  // Stable per-device id: makes every event globally unique so the merge can dedup precisely.
  const DEV = (()=>{ try{ let d=localStorage.getItem("bio305.dev");
    if(!d){ d="d"+Math.random().toString(36).slice(2,10)+Date.now().toString(36); localStorage.setItem("bio305.dev",d); }
    return d; }catch(e){ return "d-mem"; } })();
  let cards = [], units = [], byId = {};
  let tagList = [], tagIndex = {}, health = null;   // taxonomy + critic-fleet findings
  let state = load();   // { srs:{id:{...hist:[{ts,lat,grade,correct,dev,kind}]}}, sessions:[], settings:{updatedAt}, tagW:{}, schema }
  let _suppressPush = false, dirty = false;

  function load(){
    try{ const s = JSON.parse(localStorage.getItem(KEY)); if(s&&s.srs){ return migrate(s); } }catch(e){}
    return { srs:{}, sessions:[], settings:{theme:"dark",updatedAt:Date.now()}, tagW:{}, schema:2 };
  }
  // Non-destructive migration to schema 2 (adds sync scaffolding; never rewrites events).
  // Legacy events lack dev/kind: dedup falls back to a legacy key (they're single-origin) and
  // replay infers kind from the card once decks are loaded, so no event needs mutating here.
  function migrate(s){
    if(!s.tagW) s.tagW={};
    if(!s.settings) s.settings={theme:"dark"};
    if(s.settings.updatedAt==null) s.settings.updatedAt=Date.now();
    if(s.schema!==2) s.schema=2;
    return s;
  }
  function save(){ try{ localStorage.setItem(KEY, JSON.stringify(state)); }catch(e){}
    // A non-suppressed save is a LOCAL change -> mark dirty + schedule a push. Remote-absorption
    // saves are wrapped in _suppressPush, so they never schedule a push (the no-echo rule).
    if(!_suppressPush){ dirty=true; if(cloudConfigured()) schedulePush(); } }

  async function init(){
    // Always fetch content fresh (no-store) so a newly-live lecture / added cards show immediately;
    // the service worker's network-first handler still serves these from cache when offline.
    const NS = {cache:"no-store"};
    units = await fetch("data/units.json",NS).then(r=>r.json());
    // taxonomy (optional but expected) + critic-fleet findings (optional)
    try{ const tg = await fetch("data/tags.json",NS).then(r=>r.json()); tagList = tg.tags||[]; tagList.forEach(t=>tagIndex[t.id]=t); }catch(e){ tagList=[]; }
    try{ health = await fetch("data/system-health.json",NS).then(r=>r.ok?r.json():null); }catch(e){ health=null; }
    // Load EVERY live lecture's deck via units.json's file mapping — not just L1.
    const live = units.flatMap(u=>u.lectures).filter(l=>l.status==="live" && l.file);
    const decks = await Promise.all(live.map(l =>
      fetch("data/"+l.file,NS).then(r=>r.json()).then(cs=>{ cs.forEach(c=>c.lecture=l.n); return cs; })
    ));
    cards = decks.flat();
    byId = {};
    cards.forEach(c=>{ if(!c.tags) c.tags=[]; byId[c.id]=c; });
    return true;
  }
  // ---- adaptive tag weights ----
  function tw(id){ if(state.tagW[id]==null) state.tagW[id]=TAG_DEF; return state.tagW[id]; }
  function bumpTags(card, g){                       // g: 1=again/wrong 2=hard 3=good 4=easy
    if(card) SyncCore.bumpTagInto(state.tagW, card.tags||[], g);   // delegate -> single source of truth
  }
  function tagBoost(card){ const ts=card.tags||[]; if(!ts.length) return TAG_DEF; let s=0; ts.forEach(t=>s+=tw(t)); return s/ts.length; }
  const tagLabel = id => (tagIndex[id]&&tagIndex[id].label) || id;

  // ---- card sets ----
  const reviewCards = ()=> cards.filter(c=> c.type!=="problem");   // flip cards
  const problemCards = ()=> cards.filter(c=> c.type==="problem");
  const get = id => byId[id];

  function srs(id){
    if(!state.srs[id]) state.srs[id] = {reps:0,lapses:0,ease:2.3,ivl:0,due:0,seen:false,hist:[]};
    return state.srs[id];
  }
  const isDue = id => { const s=state.srs[id]; return !s || !s.seen || s.due<=Date.now(); };

  // Due queue for flip cards: due/unseen first, then blended weakness + hot-tag boost.
  function dueQueue(){
    const due = reviewCards().filter(c=>isDue(c.id));
    return due.sort((a,a2)=>{
      const sa=state.srs[a.id], sb=state.srs[a2.id];
      const na=!sa||!sa.seen, nb=!sb||!sb.seen;
      if(na!==nb) return na?1:-1;                 // review scheduled-overdue before brand-new
      return priority(a2)-priority(a);            // higher priority first
    });
  }
  // Adaptive priority: hot tags dominate, plus overdue + intrinsic weakness. Drives Smart mode + due order.
  function priority(c){
    const s=state.srs[c.id]||{};
    const overdue = s.seen ? Math.min(3,Math.max(0,(Date.now()-(s.due||0))/DAY)) : 0.5;
    const weak = s.ease? Math.max(0,2.5-s.ease) : 0.3;
    return tagBoost(c)*1.0 + overdue*0.35 + weak*0.3 + (s.seen?0:0.35);
  }
  // Smart/adaptive queue: every review card ranked by priority (ignores strict due-ness) — catered practice.
  function adaptiveQueue(kind){
    const pool = kind==="problem"? problemCards() : reviewCards();
    return pool.slice().sort((a,b)=>priority(b)-priority(a));
  }
  function lectureQueue(lec){ return reviewCards().filter(c=>c.lecture===lec); }
  function tagQueue(tagId){ return reviewCards().filter(c=>(c.tags||[]).includes(tagId)).sort((a,b)=>priority(b)-priority(a)); }

  // Per-tag rollup for the heatmap: weight + coverage + observed accuracy.
  function tagStats(){
    const idx={}; tagList.forEach(t=>idx[t.id]={id:t.id,label:t.label,kind:t.kind,lecture:t.lecture,w:tw(t.id),cards:0,reps:0,corr:0});
    cards.forEach(c=>(c.tags||[]).forEach(t=>{ if(!idx[t])return; idx[t].cards++;
      const st=cardStat(c); if(st){ idx[t].reps+=st.reps; idx[t].corr+=st.acc*st.reps; } }));
    return Object.values(idx).map(t=>({...t, acc: t.reps? t.corr/t.reps : null}))
      .sort((a,b)=> b.w-a.w || (a.label>b.label?1:-1));
  }
  function hotTags(n){ return tagStats().filter(t=>t.w>1.05 && t.cards>0).slice(0,n||6); }
  const taxonomy = ()=> tagList;
  const systemHealth = ()=> health;

  // ---- grading a flip card (Anki 1-4) ----
  function grade(id, g, latencyMs){
    const s = srs(id);
    const ts = Date.now();
    SyncCore.applyFlip(s, g, ts, EXAM_I);   // same math as before; single source shared with replay
    s.hist.push({ts, lat:Math.round(latencyMs), grade:g, correct:g>=2, dev:DEV, kind:"flip"});
    bumpTags(get(id), g);
    save();
  }

  // ---- problems: log a self-graded attempt + heuristic local check ----
  function localCheck(card, typed){
    const norm = t => (t||"").toLowerCase().replace(/[′’]/g,"'").replace(/\s+/g,"")
      .replace(/[^a-z0-9%'./-]/g,"");
    const ans = card.answer||"";
    const nt = norm(typed), na = norm(ans);
    if(!nt) return {score:0,verdict:"no"};
    // key tokens: percentages/numbers, lone MC letters, DNA/RNA runs
    const toks = new Set();
    (ans.match(/\d+(\.\d+)?%?/g)||[]).forEach(x=>toks.add(norm(x)));
    (ans.match(/\b[A-E]\b/g)||[]).forEach(x=>toks.add(x.toLowerCase()));
    (ans.match(/[ACGTU]{4,}/gi)||[]).forEach(x=>toks.add(norm(x)));
    let hit=0, tot=toks.size;
    toks.forEach(t=>{ if(nt.includes(t)) hit++; });
    // fallback: char-overlap if no structured tokens
    let score = tot? hit/tot : (nt.length>4 && na.includes(nt.slice(0,6))?0.6:0.3);
    const verdict = score>=0.8?"ok":score>=0.4?"partial":"no";
    return {score, verdict, hit, tot};
  }
  function logProblem(id, correct, latencyMs){
    const s = srs(id);
    const ts = Date.now();
    SyncCore.applyProblem(s, correct, ts, EXAM_I);
    s.hist.push({ts, lat:Math.round(latencyMs), grade:correct?3:1, correct, dev:DEV, kind:"problem"});
    bumpTags(get(id), correct?3:1);
    save();
  }

  // ---- session logging ----
  function logSession(rec){ state.sessions.push(Object.assign({ts:Date.now()},rec)); save(); }

  // ---- stats ----
  function cardStat(c){
    const s = state.srs[c.id]; if(!s||!s.hist.length) return null;
    const h=s.hist, n=h.length;
    const acc = h.filter(x=>x.correct).length/n;
    const lats = h.filter(x=>x.correct).map(x=>x.lat).sort((a,b)=>a-b);
    const medLat = lats.length? lats[Math.floor(lats.length/2)] : null;
    const slow = medLat!=null && medLat > 1.5*c.target_s*1000 && acc>=0.5;
    const mastered = s.reps>=2 && acc>=0.8 && medLat!=null && medLat<=c.target_s*1000;
    return {acc, medLat, slow, mastered, reps:n, lapses:s.lapses, ease:s.ease};
  }
  function topicStats(){
    const map={};
    cards.forEach(c=>{
      const st=cardStat(c); if(!st) return;
      const m = map[c.topic] || (map[c.topic]={topic:c.topic,reps:0,corr:0,lat:[],mastered:0,slow:0,n:0});
      m.n++; m.reps+=st.reps; m.corr+=st.acc*st.reps;
      if(st.medLat!=null) m.lat.push(st.medLat);
      if(st.mastered) m.mastered++; if(st.slow) m.slow++;
    });
    return Object.values(map).map(m=>({
      topic:m.topic, cards:m.n, reps:m.reps,
      acc: m.reps? m.corr/m.reps : 0,
      medLat: m.lat.length? Math.round(m.lat.sort((a,b)=>a-b)[Math.floor(m.lat.length/2)]/1000):null,
      mastered:m.mastered, slow:m.slow
    })).sort((a,b)=>a.acc-b.acc);
  }
  function overview(){
    let mastered=0, seen=0, totalReps=0, corr=0, studyMs=0;
    const days=new Set(); let slowList=[], leeches=[];
    cards.forEach(c=>{
      const st=cardStat(c); if(!st) return;
      seen++; totalReps+=st.reps; corr+=st.acc*st.reps;
      if(st.mastered) mastered++;
      if(st.slow) slowList.push({id:c.id,topic:c.topic,medLat:Math.round(st.medLat/1000),target:c.target_s});
      const s=state.srs[c.id]; s.hist.forEach(x=>{studyMs+=Math.min(x.lat,120000);days.add(new Date(x.ts).toDateString());});
      if(st.lapses>=3) leeches.push({id:c.id,topic:c.topic,lapses:st.lapses});
    });
    return {
      total:cards.length, seen, mastered,
      due: cards.filter(c=>c.type!=="problem"&&isDue(c.id)).length,
      acc: totalReps? corr/totalReps : null,
      studyMin: Math.round(studyMs/60000), studyDays:days.size,
      streak: streak(), slowList, leeches
    };
  }
  function streak(){
    const days=new Set(); state.sessions.forEach(s=>days.add(new Date(s.ts).toDateString()));
    cards.forEach(c=>{const s=state.srs[c.id]; if(s) s.hist.forEach(x=>days.add(new Date(x.ts).toDateString()));});
    let n=0, d=new Date();
    while(days.has(d.toDateString())){ n++; d.setDate(d.getDate()-1); }
    return n;
  }
  const daysToExam = ()=> Math.max(0, Math.ceil((EXAM_I-Date.now())/DAY));

  // ---- export / import (cross-device until cloud sync lands) ----
  function exportJSON(){ return JSON.stringify(state); }
  function importJSON(txt){ const s=JSON.parse(txt); if(s&&s.srs){ state=migrate(s); save(); return true;} return false; }

  // ---- markdown-lite ----
  function md(t){
    if(!t) return "";
    let h = t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    h = h.replace(/\*\*(.+?)\*\*/g,"<b>$1</b>").replace(/(^|[^*])\*([^*]+?)\*/g,"$1<em>$2</em>")
         .replace(/`([^`]+?)`/g,"<code>$1</code>");
    // bullet lists
    h = h.replace(/(?:^|\n)- (.+)/g,(_,x)=>"\n<li>"+x+"</li>");
    h = h.replace(/(<li>[\s\S]*?<\/li>)/g,"<ul>$1</ul>").replace(/<\/ul>\s*<ul>/g,"");
    h = h.replace(/\n{2,}/g,"<br><br>").replace(/\n/g,"<br>").replace(/<br>(<ul>|<li>)/g,"$1");
    return h;
  }

  // ---- cloud sync + deep grade (no-op until configured in Settings) ----
  const SYNC_KEY="bio305.sync";
  let syncMeta=(()=>{try{return JSON.parse(localStorage.getItem(SYNC_KEY))||{updatedAt:0};}catch(e){return{updatedAt:0};}})();
  const cfg=()=> state.settings.cloud || {};
  function cloudConfigured(){ const c=cfg(); return !!(c.apiBase && c.account && c.appSecret); }
  function setCloud(apiBase,account,appSecret){
    state.settings.cloud={apiBase:(apiBase||"").replace(/\/+$/,""),account:account||"default",appSecret:appSecret||""};
    state.settings.updatedAt=Date.now();   // settings changed -> win LWW on merge
    _suppressPush=true; save(); _suppressPush=false;
  }
  function saveMeta(){ try{ localStorage.setItem(SYNC_KEY,JSON.stringify(syncMeta)); }catch(e){} }
  let _onSync=null; function onSync(fn){ _onSync=fn; }   // app registers a re-render hook
  // PULL: cheap `since` poll; on change, MERGE remote into local (suppressed save -> no echo push).
  async function pull(){
    if(!cloudConfigured()) return false; const c=cfg();
    const r=await fetch(c.apiBase+"/sync?account="+encodeURIComponent(c.account)+"&since="+(syncMeta.updatedAt||0),
      {headers:{"x-app-secret":c.appSecret}});
    if(!r.ok) return false; const d=await r.json();
    if(d.changed===false) return false;
    if(d.blob && (d.updatedAt||0) > (syncMeta.updatedAt||0)){
      let remote; try{ remote=JSON.parse(d.blob); }catch(e){ return false; }
      if(remote && remote.srs){
        _suppressPush=true; state=SyncCore.mergeState(state, remote, byId, cards.length, EXAM_I); save(); _suppressPush=false;
        syncMeta.updatedAt=d.updatedAt; saveMeta();
        if(_onSync) try{ _onSync(); }catch(e){}
        return true;
      }
    }
    return false;
  }
  // PUSH: merge-before-write so a push can NEVER clobber. If remote is unreadable (offline), skip
  // and stay dirty for the next window rather than risk overwriting the other device.
  async function push(){
    if(!cloudConfigured()) return false; const c=cfg();
    let remote=null;
    try{ const r=await fetch(c.apiBase+"/sync?account="+encodeURIComponent(c.account),{headers:{"x-app-secret":c.appSecret}});
      if(!r.ok) return false; const d=await r.json(); if(d.blob){ remote=JSON.parse(d.blob); } }
    catch(e){ return false; }
    if(remote && remote.srs){ _suppressPush=true; state=SyncCore.mergeState(state, remote, byId, cards.length, EXAM_I); save(); _suppressPush=false; }
    const r2=await fetch(c.apiBase+"/sync",{method:"POST",
      headers:{"content-type":"application/json","x-app-secret":c.appSecret},
      body:JSON.stringify({account:c.account,blob:JSON.stringify(state)})});
    if(!r2.ok) return false; const d2=await r2.json(); syncMeta.updatedAt=d2.updatedAt||Date.now(); saveMeta();
    dirty=false; return true;
  }
  // THROTTLE: push at most once per PUSH_MIN while dirty (keeps writes well under the KV cap).
  let pushT=null, lastPush=0;
  function schedulePush(){
    if(!cloudConfigured() || pushT) return;
    const since=Date.now()-lastPush;
    pushT=setTimeout(runPush, since>=PUSH_MIN ? 1500 : (PUSH_MIN-since));
  }
  async function runPush(){ pushT=null; lastPush=Date.now(); if(dirty){ try{ await push(); }catch(e){} } }
  function flushPush(){ if(!cloudConfigured()) return; if(pushT){clearTimeout(pushT);pushT=null;} if(dirty){ lastPush=Date.now(); push().catch(()=>{}); } }
  // POLL LOOP: pull now, then every POLL_INTERVAL while visible (no reads when hidden); immediate
  // pull on refocus; flush the pending push when backgrounded/closed. Idempotent.
  let _syncStarted=false;
  function startSync(){
    if(_syncStarted || !cloudConfigured()) return; _syncStarted=true;
    pull().catch(()=>{});
    setInterval(()=>{ if(typeof document==="undefined"||document.visibilityState==="visible") pull().catch(()=>{}); }, POLL_INTERVAL);
    if(typeof document!=="undefined") document.addEventListener("visibilitychange", ()=>{
      if(document.visibilityState==="visible") pull().catch(()=>{}); else flushPush(); });
    if(typeof window!=="undefined"){ window.addEventListener("pagehide", flushPush); window.addEventListener("beforeunload", flushPush); }
  }
  async function deepGrade(card,student){
    if(!cloudConfigured()) throw new Error("cloud not set up"); const c=cfg();
    const r=await fetch(c.apiBase+"/grade",{method:"POST",
      headers:{"content-type":"application/json","x-app-secret":c.appSecret},
      body:JSON.stringify({account:c.account,card_id:card.id,question:card.q,
        model_answer:((card.answer||"")+"  "+(card.worked||"")).trim(),student_answer:student})});
    if(!r.ok) throw new Error("enqueue failed"); return (await r.json()).id;
  }
  async function pollGrade(id){ const c=cfg();
    const r=await fetch(c.apiBase+"/grade/"+id,{headers:{"x-app-secret":c.appSecret}}); return r.json(); }
  // Laptop-local deep grade: POST straight to the on-machine daemon; verdict returns INLINE (no queue/poll/KV).
  async function localGrade(card,student){
    const r=await fetch("http://127.0.0.1:8457/grade",{method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({card_id:card.id,question:card.q,
        model_answer:((card.answer||"")+"  "+(card.worked||"")).trim(),student_answer:student})});
    if(!r.ok){ let e={}; try{e=await r.json();}catch(_){} throw new Error(e.error||("grader "+r.status)); }
    return r.json();
  }

  return { init, save, units:()=>units, cards:()=>cards, get, reviewCards, problemCards,
    dueQueue, adaptiveQueue, lectureQueue, tagQueue, isDue, srs, grade, localCheck, logProblem, logSession,
    cardStat, topicStats, overview, daysToExam, exportJSON, importJSON, md,
    tagStats, hotTags, taxonomy, tagLabel, tagBoost, priority, systemHealth,
    settings:()=>state.settings,
    cloudConfigured, setCloud, cloudCfg:cfg, pull, push, deepGrade, pollGrade, localGrade,
    startSync, onSync };
})();
