/* Bio 305 — store: data, SRS scheduling, stats, local grading. Vanilla, localStorage-backed.
   Designed so a cloud sync layer can later read/write the same `state` blob. */
const Store = (function(){
  const KEY = "bio305.v1";
  const EXAM_I = new Date(2026,6,20).getTime();   // Mon Jul 20 2026 (month is 0-based)
  const DAY = 86400000;
  let cards = [], units = [], byId = {};
  let state = load();   // { srs:{id:{...}}, sessions:[], settings:{} }
  let _suppressPush = false;

  function load(){
    try{ const s = JSON.parse(localStorage.getItem(KEY)); if(s&&s.srs) return s; }catch(e){}
    return { srs:{}, sessions:[], settings:{theme:"dark"} };
  }
  function save(){ try{ localStorage.setItem(KEY, JSON.stringify(state)); }catch(e){}
    if(!_suppressPush && cloudConfigured()) schedulePush(); }

  async function init(){
    units = await fetch("data/units.json").then(r=>r.json());
    // Load EVERY live lecture's deck via units.json's file mapping — not just L1.
    const live = units.flatMap(u=>u.lectures).filter(l=>l.status==="live" && l.file);
    const decks = await Promise.all(live.map(l =>
      fetch("data/"+l.file).then(r=>r.json()).then(cs=>{ cs.forEach(c=>c.lecture=l.n); return cs; })
    ));
    cards = decks.flat();
    byId = {};
    cards.forEach(c=>{ byId[c.id]=c; });
    return true;
  }

  // ---- card sets ----
  const reviewCards = ()=> cards.filter(c=> c.type!=="problem");   // flip cards
  const problemCards = ()=> cards.filter(c=> c.type==="problem");
  const get = id => byId[id];

  function srs(id){
    if(!state.srs[id]) state.srs[id] = {reps:0,lapses:0,ease:2.3,ivl:0,due:0,seen:false,hist:[]};
    return state.srs[id];
  }
  const isDue = id => { const s=state.srs[id]; return !s || !s.seen || s.due<=Date.now(); };

  // Due queue for flip cards: due/unseen first, weakest (lowest ease, most lapses) prioritized.
  function dueQueue(){
    const due = reviewCards().filter(c=>isDue(c.id));
    return due.sort((a,a2)=>{
      const sa=state.srs[a.id], sb=state.srs[a2.id];
      const na=!sa||!sa.seen, nb=!sb||!sb.seen;
      if(na!==nb) return na?1:-1;                 // review scheduled-overdue before brand-new
      const ea=(sa?sa.ease:2.3), eb=(sb?sb.ease:2.3);
      return ea-eb;                               // weaker (lower ease) first
    });
  }
  function lectureQueue(lec){ return reviewCards().filter(c=>c.lecture===lec); }

  // ---- grading a flip card (Anki 1-4) ----
  function grade(id, g, latencyMs){
    const s = srs(id);
    const correct = g>=2;
    if(g===1){ s.lapses++; s.ease=Math.max(1.3,s.ease-0.2); s.ivl=0; s.due=Date.now()+45*1000; }
    else{
      if(g===2){ s.ease=Math.max(1.3,s.ease-0.15); s.ivl = s.reps===0?1:Math.max(1,s.ivl*1.2); }
      else if(g===3){ s.ivl = s.reps===0?1:Math.max(1,s.ivl*s.ease); }
      else if(g===4){ s.ease+=0.05; s.ivl = s.reps===0?2:Math.max(2,s.ivl*s.ease*1.3); }
      s.reps++;
      const capDays = Math.max(1, Math.ceil((EXAM_I-Date.now())/DAY)); // exam-aware: never schedule past Exam I
      s.ivl = Math.min(s.ivl, capDays);
      s.due = Date.now() + s.ivl*DAY;
    }
    s.seen = true;
    s.hist.push({ts:Date.now(),lat:Math.round(latencyMs),grade:g,correct});
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
    s.seen=true; s.reps++; if(!correct) s.lapses++;
    const capDays = Math.max(1, Math.ceil((EXAM_I-Date.now())/DAY));
    s.ivl = correct ? Math.min(capDays, s.reps===1?2:Math.max(2,(s.ivl||2)*2)) : 0;
    s.due = correct ? Date.now()+s.ivl*DAY : Date.now()+60*1000;
    s.hist.push({ts:Date.now(),lat:Math.round(latencyMs),grade:correct?3:1,correct});
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
  function importJSON(txt){ const s=JSON.parse(txt); if(s&&s.srs){ state=s; save(); return true;} return false; }

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
    _suppressPush=true; save(); _suppressPush=false;
  }
  function saveMeta(){ try{ localStorage.setItem(SYNC_KEY,JSON.stringify(syncMeta)); }catch(e){} }
  async function pull(){
    if(!cloudConfigured()) return false; const c=cfg();
    const r=await fetch(c.apiBase+"/sync?account="+encodeURIComponent(c.account),{headers:{"x-app-secret":c.appSecret}});
    if(!r.ok) return false; const d=await r.json();
    if(d.blob && d.updatedAt>syncMeta.updatedAt){
      const s=JSON.parse(d.blob);
      if(s&&s.srs){ _suppressPush=true; state=s; save(); _suppressPush=false; syncMeta.updatedAt=d.updatedAt; saveMeta(); return true; }
    }
    return false;
  }
  async function push(){
    if(!cloudConfigured()) return false; const c=cfg();
    const r=await fetch(c.apiBase+"/sync",{method:"POST",
      headers:{"content-type":"application/json","x-app-secret":c.appSecret},
      body:JSON.stringify({account:c.account,blob:JSON.stringify(state)})});
    if(!r.ok) return false; const d=await r.json(); syncMeta.updatedAt=d.updatedAt||Date.now(); saveMeta(); return true;
  }
  let pushT=null;
  function schedulePush(){ if(!cloudConfigured())return; clearTimeout(pushT); pushT=setTimeout(()=>push().catch(()=>{}),2500); }
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
    dueQueue, lectureQueue, isDue, srs, grade, localCheck, logProblem, logSession,
    cardStat, topicStats, overview, daysToExam, exportJSON, importJSON, md,
    settings:()=>state.settings,
    cloudConfigured, setCloud, cloudCfg:cfg, pull, push, deepGrade, pollGrade, localGrade };
})();
