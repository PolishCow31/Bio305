/* Bio 305 — app: hash router + views. Depends on Store. v6: adaptive tags, Smart/Blitz, heatmap, health. */
(function(){
  const app = document.getElementById("app");
  const tabbar = document.getElementById("tabbar");
  const el = (h)=>{ const d=document.createElement("div"); d.innerHTML=h.trim(); return d.firstElementChild; };
  const md = Store.md;
  const esc = s=>(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  let sess = null; // active review session

  // ---------- theme ----------
  function applyTheme(t){ document.documentElement.setAttribute("data-theme",t);
    document.querySelector('meta[name=theme-color]').setAttribute("content", t==="light"?"#FBF7EE":"#00274C"); }
  document.getElementById("theme-btn").onclick = ()=>{
    const t = document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark";
    applyTheme(t); Store.settings().theme=t; Store.settings().updatedAt=Date.now(); Store.save();
  };

  // ---------- tag helpers ----------
  function tagChips(c, max){
    const ts=(c.tags||[]).slice(0,max||4);
    return ts.map(t=>`<span class="chip tag" data-tag="${t}">${esc(Store.tagLabel(t))}</span>`).join("");
  }
  // weight -> colour: hot(weak) red, baseline neutral, cold(strong) green.
  function tagColor(w){
    if(w>1.05){ const k=Math.min(1,(w-1)/2.2); return `hsl(${Math.round(8+ (1-k)*20)} ${Math.round(70+k*20)}% ${Math.round(52-k*8)}%)`; }
    if(w<0.95){ const k=Math.min(1,(1-w)/0.55); return `hsl(${Math.round(140- k*10)} ${Math.round(38+k*24)}% ${Math.round(42-k*4)}%)`; }
    return "var(--line-2)";
  }
  function tagSnapshot(ids){ const m={}; Store.tagStats().forEach(t=>{ if(!ids||ids.has(t.id)) m[t.id]=t.w; }); return m; }

  // ---------- router ----------
  function route(){
    const h = location.hash.replace(/^#\/?/,"") || "home";
    const [view,arg] = h.split(/\/(.+)/);   // split on first slash only (tag:foo keeps colon)
    setTab(view);
    if(view!=="exam" && window.Exam) Exam.cleanup();   // kill any live exam timer/keybinds on the way out
    if(view==="home") return renderHome();
    if(view==="review") return startReview(arg);
    if(view==="problems") return renderProblems(arg);
    if(view==="exam") return renderExam(arg);
    if(view==="stats") return renderStats();
    if(view==="health") return renderHealth();
    if(view==="settings") return renderSettings();
    renderHome();
  }
  function setTab(v){ [...tabbar.children].forEach(a=>a.classList.toggle("active", a.dataset.tab===v)); }
  function go(hash){ location.hash = hash; }
  // click-through for tag chips anywhere
  app && app.addEventListener("click",(e)=>{ const t=e.target.closest(".chip.tag"); if(t&&t.dataset.tag){ e.stopPropagation(); go("/review/tag:"+t.dataset.tag); }});

  // ---------- home ----------
  function renderHome(){
    const ov = Store.overview();
    const due = Store.dueQueue().length;
    const units = Store.units();
    const hot = Store.hotTags(5);
    const covered = ov.seen, total = ov.total;
    app.innerHTML = "";
    app.appendChild(el(`
      <section class="hero">
        <div class="watermark" aria-hidden="true"></div>
        <p class="eyebrow">University of Michigan · Genetics</p>
        <h1>Welcome back, Christian.</h1>
        <p class="sub">${ due ? `<b>${due}</b> card${due>1?"s":""} due. Exam I in <b>${Store.daysToExam()} days</b>.`
           : `You're caught up. ${covered? covered+" of "+total+" cards seen." : "Start with Smart review — "+total+" cards ready."}` }</p>
      </section>`));

    // hot-tags banner — the adaptive brain, made visible
    if(hot.length){
      const b = el(`<div class="hotbar"><span class="hl">Catered to your misses:</span> <span class="hchips"></span></div>`);
      const hc=b.querySelector(".hchips");
      hot.forEach(t=>hc.appendChild(el(`<span class="chip tag hot" data-tag="${t.id}" style="border-color:${tagColor(t.w)};color:${tagColor(t.w)}">${esc(t.label)}</span>`)));
      app.appendChild(b);
    }

    const cta = el(`<div class="cta-row"></div>`);
    const smart = el(`<button class="btn">${hot.length?"Smart review":"Start review"} <span class="cnt">${Store.reviewCards().length}</span></button>`);
    smart.onclick=()=>go("/review/smart");
    const dueBtn = el(`<button class="btn alt">Due <span class="cnt">${due}</span></button>`);
    dueBtn.onclick=()=>go("/review"); if(!due) dueBtn.disabled=true;
    const blitz = el(`<button class="btn alt">Blitz</button>`); blitz.onclick=()=>go("/review/blitz");
    const probBtn = el(`<button class="btn alt">Problems →</button>`); probBtn.onclick=()=>go("/problems");
    cta.append(smart, dueBtn, blitz, probBtn); app.appendChild(cta);

    // health strip
    const H = Store.systemHealth();
    if(H && H.findings && H.findings.length){
      const open = H.findings.filter(f=>f.severity!=="info").length;
      const strip = el(`<div class="healthstrip"><span class="dot ${open?'warn':'ok'}"></span>
        ${open? open+" system flag"+(open>1?"s":"")+" from the critics" : "Critics: all clear"} <span class="go">View →</span></div>`);
      strip.onclick=()=>go("/health"); app.appendChild(strip);
    }

    app.appendChild(el(`<div class="sec-h">Course · tap a live lecture to drill</div>`));
    units.forEach((u,ui)=>{
      const open = ui===0 ? "open":"";
      const unit = el(`<div class="unit ${open}">
        <div class="unit-head"><div><div class="ut">${u.title}</div><div class="ux">${u.exam}</div></div>
        <span class="chev">▶</span></div>
        <div class="unit-body"></div></div>`);
      unit.querySelector(".unit-head").onclick=()=>unit.classList.toggle("open");
      const body = unit.querySelector(".unit-body");
      u.lectures.forEach(L=>{
        if(L.status==="live"){
          const cs = Store.lectureQueue(L.n);
          const probs = Store.problemCards().filter(c=>c.lecture===L.n).length;
          const seen = cs.filter(c=>{const s=Store.srs(c.id); return s&&s.seen;}).length;
          const mastered = cs.filter(c=>{const x=Store.cardStat(c); return x&&x.mastered;}).length;
          const pct = cs.length? Math.round(mastered/cs.length*100):0;
          const row = el(`<div class="lec live"><div class="lnum">L${L.n}</div>
            <div class="lmeta"><div class="lt">${L.title}</div>
            <div class="ls">${cs.length} cards${probs?" · "+probs+" problems":""} · ${seen} seen · ${mastered} mastered</div>
            <div class="mini"><span class="bar"><i style="width:${pct}%"></i></span></div></div>
            <span class="lbadge">Live</span></div>`);
          row.onclick=()=>go("/review/L"+L.n);
          body.appendChild(row);
        } else {
          body.appendChild(el(`<div class="lec tbd"><div class="lnum">L${L.n}</div>
            <div class="lmeta"><div class="lt">${L.title}</div><div class="ls">L${L.n} — TBD</div></div>
            <span class="lbadge">TBD</span></div>`));
        }
      });
      app.appendChild(unit);
    });
  }

  // ---------- review (flip cards) ----------
  function startReview(arg){
    let queue, label="Due", mode="due";
    if(arg==="smart"){ queue = Store.adaptiveQueue().map(c=>c.id); label="Smart"; mode="smart"; }
    else if(arg==="blitz"){ queue = Store.adaptiveQueue().filter(c=>c.type==="recall").map(c=>c.id); label="Blitz"; mode="blitz"; }
    else if(arg && arg.indexOf("tag:")===0){ const t=arg.slice(4); queue=Store.tagQueue(t).map(c=>c.id); label=Store.tagLabel(t); mode="tag"; }
    else if(arg && /^L\d+$/.test(arg)){ const n=+arg.slice(1); queue = Store.lectureQueue(n).map(c=>c.id); label="L"+n; mode="lecture"; }
    else queue = Store.dueQueue().map(c=>c.id);
    if(!queue.length){ app.innerHTML=""; app.appendChild(el(`<div class="empty"><div class="big">Nothing to review</div>
      <p>All caught up. Try Problems or come back later.</p></div>`));
      const r=el(`<div class="cta-row" style="justify-content:center"></div>`);
      const a=el(`<button class="btn">Home</button>`); a.onclick=()=>go("/home"); r.append(a); app.appendChild(r); return; }
    const touched = new Set(); queue.forEach(id=>{ const c=Store.get(id); (c.tags||[]).forEach(t=>touched.add(t)); });
    sess = {queue, i:0, shownTs:0, flipped:false, done:0, correct:0, streak:0, bestStreak:0, onpace:0, label, mode,
            blitz: mode==="blitz", tagSnap: tagSnapshot(touched), touched};
    renderCard();
  }
  function hud(){
    const remaining = sess.queue.length - sess.i;
    const acc = sess.done? Math.round(sess.correct/sess.done*100) : 0;
    return `<div class="hud">
      <span class="h-item"><b>${sess.done}</b> done</span>
      <span class="h-item"><b>${remaining}</b> left</span>
      <span class="h-item h-acc"><b>${acc}</b>% acc</span>
      <span class="h-item h-streak">${sess.streak>=3?'🔥 ':''}<b>${sess.streak}</b> streak</span>
    </div>`;
  }
  function renderCard(){
    const id = sess.queue[sess.i];
    if(id===undefined) return finishReview();
    const c = Store.get(id);
    const prog = Math.round(sess.done/(sess.done+sess.queue.length-sess.i||1)*100);
    app.innerHTML="";
    const stage = el(`<div class="review-stage ${sess.blitz?'blitz':''}">
      <div class="rev-top"><span class="rev-label">${esc(sess.label)}${sess.blitz?' · blitz':''}</span>
        <span class="rev-prog"><i style="width:${prog}%"></i></span>
        <span class="x" title="End">✕</span></div>
      ${hud()}
      <div class="flash"><div class="flash-card">
        <div class="face front">
          <div class="tagline"><span class="chip type">${c.type}</span>${tagChips(c,3)}</div>
          <div class="q md">${md(c.q)}</div>
          <div class="hint">tap · space to flip</div>
        </div>
        <div class="face back">
          <div class="a md">${c.type==="concept"?'<span class="lead">Answer</span>':''}${md(c.a||"")}</div>
          <div class="src">${c.src||""}</div>
        </div>
      </div></div>
      <div class="grade-host"></div>
    </div>`);
    app.appendChild(stage);
    stage.querySelector(".x").onclick=()=>finishReview();
    const fc = stage.querySelector(".flash-card");
    sess.shownTs = performance.now(); sess.flipped=false; sess.flipLat=null;
    const gradeHost = stage.querySelector(".grade-host");
    fc.onclick=()=>{                                   // toggle front <-> back (tap or space)
      sess.flipped = !sess.flipped;
      fc.classList.toggle("flipped", sess.flipped);
      if(sess.flipped){
        // capture recall time + build the grade row ONCE (first flip); re-flips just re-show it
        if(sess.flipLat==null){ sess.flipLat = performance.now()-sess.shownTs; showGrades(stage, id, c, sess.flipLat); }
        gradeHost.style.display="";
      } else {
        gradeHost.style.display="none";                // flipping back to the front hides the answer + grades
      }
    };
  }
  function showGrades(stage, id, c, lat){
    const onpace = lat <= (c.target_s||10)*1000*1.25;
    const host = stage.querySelector(".grade-host");
    const paceTag = `<div class="pace ${onpace?'good':'slow'}">${(lat/1000).toFixed(1)}s ${onpace?'· on pace':'· slow (target '+(c.target_s||'—')+'s)'}</div>`;
    const row = el(`<div class="grade-wrap">${paceTag}<div class="grade-row">
      <button class="grade again"><b>Again</b><small>1 · 7</small></button>
      <button class="grade hard"><b>Hard</b><small>2 · 8</small></button>
      <button class="grade good"><b>Good</b><small>3 · 9</small></button>
      <button class="grade easy"><b>Easy</b><small>4 · 0</small></button></div></div>`);
    const gs=[1,2,3,4];
    [...row.querySelectorAll(".grade")].forEach((b,k)=>b.onclick=()=>{
      Store.grade(id, gs[k], lat);
      sess.done++;
      if(gs[k]>=2){ sess.correct++; sess.streak++; sess.bestStreak=Math.max(sess.bestStreak,sess.streak); }
      else { sess.streak=0; }
      if(onpace&&gs[k]>=3) sess.onpace++;
      if(gs[k]===1) sess.queue.push(id);   // resurface this session
      sess.i++; renderCard();
    });
    host.appendChild(row);
  }
  function finishReview(){
    if(sess && sess.done) Store.logSession({mode:"review",cards:sess.done,correct:sess.correct,label:sess.label});
    const d=sess?sess.done:0, c=sess?sess.correct:0, best=sess?sess.bestStreak:0;
    // tag movement recap
    const after = tagSnapshot(sess?sess.touched:new Set());
    const risers=[], fallers=[];
    if(sess) Object.keys(after).forEach(t=>{ const dlt=after[t]-(sess.tagSnap[t]||1); if(dlt>0.08) risers.push({t,dlt}); else if(dlt<-0.05) fallers.push({t,dlt}); });
    risers.sort((a,b)=>b.dlt-a.dlt); fallers.sort((a,b)=>a.dlt-b.dlt);
    sess=null;
    app.innerHTML="";
    app.appendChild(el(`<div class="empty"><div class="big">Session done</div>
      <p>${d} cards · ${d?Math.round(c/d*100):0}% recalled · best streak ${best}.</p></div>`));
    if(risers.length || fallers.length){
      const p=el(`<div class="panel recap"><h2>What shifted</h2><div class="recap-cols"></div></div>`);
      const cols=p.querySelector(".recap-cols");
      const rc=el(`<div class="rc"><div class="rc-h up">Needs work — surfacing sooner</div><div class="rc-b"></div></div>`);
      risers.slice(0,6).forEach(x=>rc.querySelector(".rc-b").appendChild(el(`<span class="chip tag" data-tag="${x.t}" style="border-color:${tagColor(after[x.t])}">${esc(Store.tagLabel(x.t))} ▲</span>`)));
      const fc=el(`<div class="rc"><div class="rc-h down">Getting solid — shown less</div><div class="rc-b"></div></div>`);
      (fallers.length?fallers:[]).slice(0,6).forEach(x=>fc.querySelector(".rc-b").appendChild(el(`<span class="chip tag" data-tag="${x.t}" style="border-color:${tagColor(after[x.t])}">${esc(Store.tagLabel(x.t))} ▼</span>`)));
      if(risers.length) cols.appendChild(rc); if(fallers.length) cols.appendChild(fc);
      app.appendChild(p);
    }
    const r=el(`<div class="cta-row" style="justify-content:center"></div>`);
    const a=el(`<button class="btn">Smart review →</button>`); a.onclick=()=>go("/review/smart");
    const b=el(`<button class="btn alt">Stats</button>`); b.onclick=()=>go("/stats");
    const hm=el(`<button class="btn alt">Home</button>`); hm.onclick=()=>go("/home"); r.append(a,b,hm);
    app.appendChild(r);
  }

  // ---------- problems ----------
  function renderProblems(arg){
    // adaptive order: weak-tag problems first; optional tag: filter
    let probs = Store.adaptiveQueue("problem");
    let label = "adaptive · weak tags first";
    if(arg && arg.indexOf("tag:")===0){ const t=arg.slice(4); probs=probs.filter(c=>(c.tags||[]).includes(t)); label=Store.tagLabel(t); }
    app.innerHTML="";
    app.appendChild(el(`<div class="sec-h">Problems · ${esc(label)} · type your answer, then grade yourself</div>`));
    let i=0;
    const host = el(`<div></div>`); app.appendChild(host);
    function show(){
      const c = probs[i]; host.innerHTML="";
      if(!c){ host.appendChild(el(`<div class="empty"><div class="big">That's all ${probs.length} problems</div>
        <p>Loop again anytime — wrong ones resurface in review.</p></div>`)); return; }
      const t0 = performance.now();
      const card = el(`<div class="panel prob">
        <div class="tagline" style="margin-bottom:12px"><span class="chip type">problem</span>
          ${tagChips(c,3)}<span class="chip">${i+1}/${probs.length}</span></div>
        <div class="q md">${md(c.q)}</div>
        <textarea placeholder="Work it out, then type your answer…"></textarea>
        <div class="cta-row" style="margin:14px 0 0">
          <button class="btn check">Check</button>
          <button class="btn alt skip">Skip →</button></div>
        <div class="result"></div>
      </div>`);
      host.appendChild(card);
      const ta=card.querySelector("textarea"), res=card.querySelector(".result");
      card.querySelector(".skip").onclick=()=>{ i++; show(); };
      card.querySelector(".check").onclick=()=>{
        const chk = Store.localCheck(c, ta.value);
        const lat = performance.now()-t0;
        const vlabel = chk.verdict==="ok"?"Looks right":chk.verdict==="partial"?"Partial — check against the solution":"Doesn't match — check the solution";
        res.innerHTML="";
        res.appendChild(el(`<div class="verdict ${chk.verdict==='ok'?'ok':chk.verdict==='partial'?'partial':'no'}">
          ${vlabel} <span style="color:var(--ink-faint);font-weight:400">· auto-check is a hint; you grade it</span></div>`));
        res.appendChild(el(`<div class="worked"><span class="lead">Worked solution</span><div class="md">${md(c.worked||"")}</div>
          <div class="md" style="margin-top:10px"><b>Answer:</b> ${md(c.answer||"")}</div></div>`));
        const isLocal=["localhost","127.0.0.1"].includes(location.hostname);
        const sg=el(`<div class="cta-row" style="margin-top:14px">
          <button class="btn good-b">I got it</button>
          <button class="btn alt miss-b">Missed it</button>
          <button class="btn alt deep-b" title="${isLocal?'Grade this answer with claude -p on your laptop':'Deep grade runs on your laptop'}">Deep grade</button></div>`);
        sg.querySelector(".good-b").onclick=()=>{ Store.logProblem(c.id,true,lat); i++; show(); };
        sg.querySelector(".miss-b").onclick=()=>{ Store.logProblem(c.id,false,lat); i++; show(); };
        sg.querySelector(".deep-b").onclick=async(e)=>{
          if(!isLocal){ e.target.disabled=true; e.target.textContent="Laptop only"; return; }
          e.target.disabled=true; e.target.textContent="Grading…";
          try{
            const r=await Store.localGrade(c, ta.value);
            if(r && !r.error){
              e.target.textContent="Deep grade: "+(r.verdict||"")+(r.score!=null?" ("+Math.round(r.score*100)+"%)":"");
              res.appendChild(el(`<div class="verdict ${r.verdict==='correct'?'ok':r.verdict==='partial'?'partial':'no'}" style="margin-top:10px">
                <b>LLM grade:</b> ${r.verdict||''} — ${r.note||''}</div>`));
            } else { e.target.textContent="Grader error"; if(r&&r.note) e.target.title=r.note; }
          }catch(x){ e.target.textContent="Error: "+x.message; }
        };
        res.appendChild(sg);
        card.querySelector(".check").disabled=true;
      };
    }
    show();
  }

  // ---------- exam (engine lives in exam.js) ----------
  function renderExam(arg){
    if(!window.Exam){ app.innerHTML=""; app.appendChild(el(`<div class="empty"><div class="big">Exam engine not loaded</div></div>`)); return; }
    const [sub,rest] = (arg||"").split(/\/(.+)/);
    if(sub==="take")   return Exam.renderTake(app, rest);
    if(sub==="review") return Exam.renderReview(app, rest);
    return Exam.renderHome(app);
  }

  // ---------- stats ----------
  function renderStats(){
    const ov = Store.overview();
    app.innerHTML="";
    // Tag heatmap renders even before data (weights start at baseline) — it's the map of the whole course.
    app.appendChild(el(`<div class="tiles">
      <div class="tile"><div class="k">Due now</div><div class="v">${ov.due}</div></div>
      <div class="tile"><div class="k">Mastered</div><div class="v">${ov.mastered}<span class="u"> / ${ov.total}</span></div></div>
      <div class="tile"><div class="k">Accuracy</div><div class="v">${ov.acc!=null?Math.round(ov.acc*100):"—"}<span class="u">%</span></div></div>
      <div class="tile"><div class="k">Study time</div><div class="v">${ov.studyMin}<span class="u"> min</span></div></div>
      <div class="tile"><div class="k">Streak</div><div class="v">${ov.streak}<span class="u"> d</span></div></div>
      <div class="tile"><div class="k">Exam I</div><div class="v">${Store.daysToExam()}<span class="u"> d</span></div></div>
    </div>`));

    // TAG HEATMAP — the adaptive brain
    const ts = Store.tagStats();
    if(ts.length){
      const hm=el(`<div class="panel"><h2>Tag heatmap <span class="sub-note">red = weak (surfacing more) · green = solid · tap to drill</span></h2>
        <div class="heat"></div></div>`);
      const grid=hm.querySelector(".heat");
      ts.forEach(t=>{
        const cell=el(`<button class="hcell" data-tag="${t.id}" title="${esc(t.label)} — weight ${t.w.toFixed(2)}${t.acc!=null?', '+Math.round(t.acc*100)+'% acc':''}, ${t.cards} cards">
          <span class="hl">${esc(t.label)}</span>
          <span class="hw">${t.acc!=null?Math.round(t.acc*100)+'%':'·'}</span></button>`);
        cell.style.borderColor=tagColor(t.w);
        cell.style.background=`color-mix(in srgb, ${tagColor(t.w)} ${Math.round(Math.min(1,Math.abs(t.w-1)/2)*22+6)}%, transparent)`;
        cell.onclick=()=>go("/review/tag:"+t.id);
        grid.appendChild(cell);
      });
      app.appendChild(hm);
    }

    if(!ov.seen){
      app.appendChild(el(`<div class="panel"><p style="margin:0;color:var(--ink-soft)">Drill some cards and the rest of your profile — accuracy, speed, weak topics, leeches — fills in here. The heatmap above already maps every tag; it heats up as you miss.</p></div>`));
    }
    // topic table
    const tp = Store.topicStats();
    if(tp.length){
      const tbl=el(`<div class="panel"><h2>Topic mastery</h2>
        <table class="tt"><thead><tr><th>Topic</th><th>Cards</th><th>Accuracy</th><th>Median time</th><th>Mastered</th></tr></thead>
        <tbody></tbody></table></div>`);
      const tb=tbl.querySelector("tbody");
      tp.forEach(t=>tb.appendChild(el(`<tr><td>${esc(t.topic)}</td><td>${t.cards}</td>
        <td class="pct">${Math.round(t.acc*100)}%</td>
        <td>${t.medLat!=null?t.medLat+"s":"—"}${t.slow?' <span class="tag-slow">·'+t.slow+' slow</span>':''}</td>
        <td>${t.mastered}/${t.cards}</td></tr>`)));
      app.appendChild(tbl);
    }
    if(ov.slowList.length){
      const p=el(`<div class="panel"><h2>Not automatic yet <span class="sub-note">right but slow — drill for speed</span></h2><div></div></div>`);
      const host=p.querySelector("div:last-child");
      ov.slowList.slice(0,12).forEach(s=>host.appendChild(el(`<div class="lec"><div class="lmeta">
        <div class="lt">${s.id} · ${esc(s.topic)}</div><div class="ls">${s.medLat}s vs ${s.target}s target</div></div></div>`)));
      app.appendChild(p);
    }
    if(ov.leeches.length){
      const p=el(`<div class="panel"><h2>Leeches <span class="sub-note">missed 3+ times — re-read the concept</span></h2><div></div></div>`);
      const host=p.querySelector("div:last-child");
      ov.leeches.forEach(s=>host.appendChild(el(`<div class="lec"><div class="lmeta">
        <div class="lt">${s.id} · ${esc(s.topic)}</div><div class="ls">missed ${s.lapses}×</div></div></div>`)));
      app.appendChild(p);
    }
    // export/import
    const io=el(`<div class="panel"><h2>Backup</h2>
      <p style="color:var(--ink-soft);font-size:14px;margin:0 0 12px">Cloud sync keeps your devices in step automatically. Export is a manual backup you can save or re-import.</p>
      <div class="cta-row" style="margin:0">
        <button class="btn alt" id="exp">Export progress</button>
        <button class="btn alt" id="imp">Import</button></div></div>`);
    app.appendChild(io);
    io.querySelector("#exp").onclick=()=>{
      const blob=new Blob([Store.exportJSON()],{type:"application/json"});
      const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
      a.download="bio305-progress.json"; a.click();
    };
    io.querySelector("#imp").onclick=()=>{
      const inp=document.createElement("input"); inp.type="file"; inp.accept="application/json";
      inp.onchange=e=>{ const f=e.target.files[0]; if(!f)return; const r=new FileReader();
        r.onload=()=>{ try{ if(Store.importJSON(r.result)){ applyTheme(Store.settings().theme||"dark"); route(); } }catch(x){ alert("Bad file"); } }; r.readAsText(f); };
      inp.click();
    };
  }

  // ---------- system health (critic fleet) ----------
  function renderHealth(){
    const H = Store.systemHealth();
    app.innerHTML="";
    app.appendChild(el(`<div class="sec-h">System health · the critic fleet's audit of this deck</div>`));
    if(!H || !H.findings){
      app.appendChild(el(`<div class="empty"><div class="big">No audit yet</div>
        <p>The critic fleet runs periodically (and after new material is added). Its findings — wrong answers, off-topic cards, tag or difficulty imbalance, duplicates — land here for you to review.</p></div>`));
      return;
    }
    const when = H.generatedAt ? new Date(H.generatedAt).toLocaleString() : "recently";
    const st = H.stats||{};
    app.appendChild(el(`<div class="panel"><h2>Last audit</h2>
      <p style="margin:0;color:var(--ink-soft);font-size:14px">${esc(when)} · ${H.findings.length} finding${H.findings.length!==1?"s":""}
      ${st.cards?`· ${st.cards} cards`:""}${st.critics?`· ${st.critics} critics`:""}</p></div>`));
    const order={critical:0,high:1,warn:2,medium:3,low:4,info:5};
    const fs=H.findings.slice().sort((a,b)=>(order[a.severity]??9)-(order[b.severity]??9));
    if(!fs.length) app.appendChild(el(`<div class="panel"><p style="margin:0;color:var(--good)"><b>All clear.</b> The critics found no issues in the current deck.</p></div>`));
    fs.forEach(f=>{
      const p=el(`<div class="panel finding sev-${esc(f.severity||'info')}">
        <div class="fhead"><span class="sev">${esc((f.severity||'info').toUpperCase())}</span>
          <span class="farea">${esc(f.area||'general')}</span>${f.cardId?`<span class="chip">${esc(f.cardId)}</span>`:''}</div>
        <div class="fmsg md">${md(f.msg||f.message||'')}</div>
        ${f.fix?`<div class="ffix"><b>Suggested fix:</b> ${md(f.fix)}</div>`:''}</div>`);
      app.appendChild(p);
    });
  }

  // ---------- settings ----------
  function renderSettings(){
    const c = Store.cloudCfg();
    app.innerHTML="";
    app.appendChild(el(`<div class="sec-h">Settings</div>`));
    const p = el(`<div class="panel"><h2>Cloud sync &amp; deep grading</h2>
      <p style="color:var(--ink-soft);font-size:14px;margin:0 0 14px">Enter once per device to sync progress across phone &amp; laptop and enable LLM grading of typed answers. ${Store.cloudConfigured()?'<b style="color:var(--good)">Connected.</b>':'Not connected — running local-only.'}</p>
      <label class="fld">API URL<input id="s-api" placeholder="https://bio305-api.pages.dev/api" value="${c.apiBase||''}"></label>
      <label class="fld">Account<input id="s-acct" placeholder="christian" value="${c.account||''}"></label>
      <label class="fld">Passcode<input id="s-sec" type="password" placeholder="app secret" value="${c.appSecret||''}"></label>
      <div class="cta-row" style="margin:14px 0 0"><button class="btn" id="s-save">Save &amp; sync</button>
      <button class="btn alt" id="s-test">Test connection</button></div>
      <div id="s-status" style="margin-top:12px;font-size:14px;color:var(--ink-soft)"></div></div>`);
    app.appendChild(p);
    const $=s=>p.querySelector(s), status=$("#s-status");
    $("#s-save").onclick=async()=>{
      Store.setCloud($("#s-api").value.trim(),$("#s-acct").value.trim(),$("#s-sec").value.trim());
      status.textContent="Saving & syncing…";
      try{ const got=await Store.pull(); await Store.push(); Store.startSync();
        status.innerHTML='<b style="color:var(--good)">Connected.</b> '+(got?'Merged newer cloud data.':'Pushed this device’s progress.')+' Live sync on.'; }
      catch(e){ status.innerHTML='<b style="color:var(--bad)">Failed: '+(e.message||e)+'</b>'; }
    };
    $("#s-test").onclick=async()=>{
      const base=$("#s-api").value.trim().replace(/\/+$/,""); status.textContent="Testing…";
      try{ const r=await fetch(base+"/health"); const d=await r.json();
        status.innerHTML=d.ok?'<b style="color:var(--good)">API reachable.</b>':'Unexpected response'; }
      catch(e){ status.innerHTML='<b style="color:var(--bad)">Unreachable: '+(e.message||e)+'</b>'; }
    };
  }

  // Re-render passive dashboards when a remote sync lands — but never nuke an active review
  // session or a problem the user is mid-typing.
  function handleRemoteSync(){
    if(sess) return;
    const ae=document.activeElement;
    if(ae && (ae.tagName==="TEXTAREA"||ae.tagName==="INPUT")) return;
    const v=(location.hash.replace(/^#\/?/,"")||"home").split("/")[0];
    if(v==="home"||v==="stats"||v==="health") route();
  }

  // ---------- boot ----------
  Store.init().then(async ()=>{
    applyTheme(Store.settings().theme||"dark");
    const gd=document.getElementById("goal-days"); if(gd) gd.textContent=Store.daysToExam()+" days";
    Store.onSync(handleRemoteSync); Store.startSync();   // live merge sync (no-op until cloud configured)
    window.addEventListener("hashchange", route);
    route();
    // Keyboard (review screen): space = flip toggle (front<->back); grade with 1/2/3/4 OR 7/8/9/0 (right hand).
    document.addEventListener("keydown", (e)=>{
      const fc=document.querySelector(".flash-card"); if(!fc) return;
      const t=(document.activeElement||{}).tagName; if(t==="INPUT"||t==="TEXTAREA") return;
      // Robust space detection — some browsers/devices send an empty or nonstandard e.code, so check key + keyCode too.
      if(e.code==="Space" || e.key===" " || e.key==="Spacebar" || e.keyCode===32){ e.preventDefault(); fc.click(); return; }
      if(fc.classList.contains("flipped")){
        const i={"1":0,"2":1,"3":2,"4":3,"7":0,"8":1,"9":2,"0":3}[e.key];   // 7/8/9/0 mirror 1/2/3/4 (Again/Hard/Good/Easy)
        if(i!==undefined){ e.preventDefault(); const g=document.querySelectorAll(".grade-row .grade")[i]; if(g) g.click(); }
      }
    });
    if("serviceWorker" in navigator && location.hostname.endsWith("github.io"))
      navigator.serviceWorker.register("sw.js").catch(()=>{});
  });
})();
