/* Bio 305 — app: hash router + views. Depends on Store. */
(function(){
  const app = document.getElementById("app");
  const tabbar = document.getElementById("tabbar");
  const el = (h)=>{ const d=document.createElement("div"); d.innerHTML=h.trim(); return d.firstElementChild; };
  const md = Store.md;
  let sess = null; // active review session

  // ---------- theme ----------
  function applyTheme(t){ document.documentElement.setAttribute("data-theme",t);
    document.querySelector('meta[name=theme-color]').setAttribute("content", t==="light"?"#FBF7EE":"#00274C"); }
  document.getElementById("theme-btn").onclick = ()=>{
    const t = document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark";
    applyTheme(t); Store.settings().theme=t; Store.save();
  };

  // ---------- router ----------
  function route(){
    const h = location.hash.replace(/^#\/?/,"") || "home";
    const [view,arg] = h.split("/");
    setTab(view);
    if(view==="home") return renderHome();
    if(view==="review") return startReview(arg);
    if(view==="problems") return renderProblems();
    if(view==="stats") return renderStats();
    if(view==="settings") return renderSettings();
    renderHome();
  }
  function setTab(v){ [...tabbar.children].forEach(a=>a.classList.toggle("active", a.dataset.tab===v)); }
  function go(hash){ location.hash = hash; }

  // ---------- home ----------
  function renderHome(){
    const ov = Store.overview();
    const due = Store.dueQueue().length;
    const units = Store.units();
    const covered = ov.seen, total = ov.total;
    app.innerHTML = "";
    app.appendChild(el(`
      <section class="hero">
        <img class="watermark" src="img/blockm.svg" alt="" aria-hidden="true" />
        <p class="eyebrow">University of Michigan · Genetics</p>
        <h1>Welcome back, Christian.</h1>
        <p class="sub">${ due ? `<b>${due}</b> card${due>1?"s":""} due. Exam I in <b>${Store.daysToExam()} days</b>.`
           : `You're caught up. ${covered? covered+" of "+total+" cards seen." : "Start with Lecture 1 — "+total+" cards ready."}` }</p>
      </section>`));
    const cta = el(`<div class="cta-row"></div>`);
    const dueBtn = el(`<button class="btn">Start review <span class="cnt">${due}</span></button>`);
    dueBtn.onclick=()=>go("/review"); if(!due) dueBtn.disabled=true;
    const probBtn = el(`<button class="btn alt">Problems →</button>`); probBtn.onclick=()=>go("/problems");
    cta.append(dueBtn, probBtn); app.appendChild(cta);

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
          const seen = cs.filter(c=>{const s=Store.srs(c.id); return s&&s.seen;}).length;
          const mastered = cs.filter(c=>{const x=Store.cardStat(c); return x&&x.mastered;}).length;
          const pct = cs.length? Math.round(mastered/cs.length*100):0;
          const row = el(`<div class="lec live"><div class="lnum">L${L.n}</div>
            <div class="lmeta"><div class="lt">${L.title}</div>
            <div class="ls">${cs.length} cards · ${seen} seen · ${mastered} mastered</div>
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
    let queue;
    if(arg && /^L\d+$/.test(arg)){ const n=+arg.slice(1); queue = Store.lectureQueue(n).map(c=>c.id); }
    else queue = Store.dueQueue().map(c=>c.id);
    if(!queue.length){ app.innerHTML=""; app.appendChild(el(`<div class="empty"><div class="big">Nothing to review</div>
      <p>All caught up. Try the Problems tab or come back later.</p></div>`)); return; }
    sess = {queue, i:0, shownTs:0, flipped:false, done:0, correct:0, label: arg||"Due"};
    renderCard();
  }
  function renderCard(){
    const id = sess.queue[sess.i];
    if(id===undefined) return finishReview();
    const c = Store.get(id);
    const prog = Math.round(sess.done/(sess.done+sess.queue.length-sess.i)*100);
    app.innerHTML="";
    const stage = el(`<div class="review-stage">
      <div class="rev-top"><span>${sess.done+1} · ${sess.label}</span>
        <span class="rev-prog"><i style="width:${prog}%"></i></span>
        <span class="x" title="End">✕</span></div>
      <div class="flash"><div class="flash-card">
        <div class="face front">
          <div class="tagline"><span class="chip type">${c.type}</span><span class="chip">${c.topic}</span></div>
          <div class="q md">${md(c.q)}</div>
          <div class="hint">tap to reveal</div>
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
    sess.shownTs = performance.now(); sess.flipped=false;
    fc.onclick=()=>{ if(sess.flipped) return; sess.flipped=true; fc.classList.add("flipped"); showGrades(stage, id); };
  }
  function showGrades(stage, id){
    const lat = performance.now()-sess.shownTs;
    const host = stage.querySelector(".grade-host");
    const row = el(`<div class="grade-row">
      <button class="grade again"><b>Again</b><small>&lt;1m</small></button>
      <button class="grade hard"><b>Hard</b><small>soon</small></button>
      <button class="grade good"><b>Good</b><small>space</small></button>
      <button class="grade easy"><b>Easy</b><small>later</small></button></div>`);
    const gs=[1,2,3,4];
    [...row.children].forEach((b,k)=>b.onclick=()=>{
      Store.grade(id, gs[k], lat);
      sess.done++; if(gs[k]>=2) sess.correct++;
      if(gs[k]===1) sess.queue.push(id);   // resurface this session
      sess.i++; renderCard();
    });
    host.appendChild(row);
  }
  function finishReview(){
    if(sess && sess.done) Store.logSession({mode:"review",cards:sess.done,correct:sess.correct});
    const d=sess?sess.done:0, c=sess?sess.correct:0; sess=null;
    app.innerHTML="";
    app.appendChild(el(`<div class="empty"><div class="big">Session done</div>
      <p>${d} cards · ${d?Math.round(c/d*100):0}% recalled.</p></div>`));
    const r=el(`<div class="cta-row" style="justify-content:center"></div>`);
    const a=el(`<button class="btn">Home</button>`); a.onclick=()=>go("/home");
    const b=el(`<button class="btn alt">Stats →</button>`); b.onclick=()=>go("/stats"); r.append(a,b);
    app.appendChild(r);
  }

  // ---------- problems ----------
  function renderProblems(){
    const probs = Store.problemCards();
    app.innerHTML="";
    app.appendChild(el(`<div class="sec-h">Problems · L1 · type your answer, then grade yourself</div>`));
    let i=0;
    const host = el(`<div></div>`); app.appendChild(host);
    function show(){
      const c = probs[i]; host.innerHTML="";
      if(!c){ host.appendChild(el(`<div class="empty"><div class="big">That's all ${probs.length} problems</div>
        <p>Loop again anytime — wrong ones resurface in review.</p></div>`)); return; }
      const t0 = performance.now();
      const card = el(`<div class="panel prob">
        <div class="tagline" style="margin-bottom:12px"><span class="chip type">problem</span>
          <span class="chip">${c.topic}</span><span class="chip">${i+1}/${probs.length}</span></div>
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
        const sg=el(`<div class="cta-row" style="margin-top:14px">
          <button class="btn good-b">I got it</button>
          <button class="btn alt miss-b">Missed it</button>
          <button class="btn alt deep-b" title="Send to claude -p for a full LLM grade (cloud)">Deep grade</button></div>`);
        sg.querySelector(".good-b").onclick=()=>{ Store.logProblem(c.id,true,lat); i++; show(); };
        sg.querySelector(".miss-b").onclick=()=>{ Store.logProblem(c.id,false,lat); i++; show(); };
        sg.querySelector(".deep-b").onclick=async(e)=>{
          if(!Store.cloudConfigured()){ e.target.textContent="Set up sync first →"; setTimeout(()=>go("/settings"),800); return; }
          e.target.disabled=true; e.target.textContent="Grading…";
          try{
            const jid=await Store.deepGrade(c, ta.value);
            let r, t=0;
            while(t++<30){ await new Promise(z=>setTimeout(z,2000)); r=await Store.pollGrade(jid); if(r.status==="done"||r.status==="error") break; }
            if(r&&r.status==="done"){
              e.target.textContent="Deep grade: "+(r.verdict||"")+(r.score!=null?" ("+Math.round(r.score*100)+"%)":"");
              res.appendChild(el(`<div class="verdict ${r.verdict==='correct'?'ok':r.verdict==='partial'?'partial':'no'}" style="margin-top:10px">
                <b>LLM grade:</b> ${r.verdict||''} — ${r.note||''}</div>`));
            } else e.target.textContent="Timed out (is the relay running?)";
          }catch(x){ e.target.textContent="Error: "+x.message; }
        };
        res.appendChild(sg);
        card.querySelector(".check").disabled=true;
      };
    }
    show();
  }

  // ---------- stats ----------
  function renderStats(){
    const ov = Store.overview();
    app.innerHTML="";
    if(!ov.seen){ app.appendChild(el(`<div class="empty"><div class="big">No data yet</div>
      <p>Drill some cards and your learning profile builds here — accuracy, speed, weak topics, and the cards you get right but slowly.</p></div>`));
      const r=el(`<div class="cta-row" style="justify-content:center"></div>`);
      const a=el(`<button class="btn">Start review</button>`); a.onclick=()=>go("/review"); r.append(a); app.appendChild(r); return; }
    app.appendChild(el(`<div class="tiles">
      <div class="tile"><div class="k">Due now</div><div class="v">${ov.due}</div></div>
      <div class="tile"><div class="k">Mastered</div><div class="v">${ov.mastered}<span class="u"> / ${ov.total}</span></div></div>
      <div class="tile"><div class="k">Accuracy</div><div class="v">${ov.acc!=null?Math.round(ov.acc*100):"—"}<span class="u">%</span></div></div>
      <div class="tile"><div class="k">Study time</div><div class="v">${ov.studyMin}<span class="u"> min</span></div></div>
      <div class="tile"><div class="k">Streak</div><div class="v">${ov.streak}<span class="u"> d</span></div></div>
      <div class="tile"><div class="k">Exam I</div><div class="v">${Store.daysToExam()}<span class="u"> d</span></div></div>
    </div>`));
    // topic table
    const ts = Store.topicStats();
    if(ts.length){
      const tbl=el(`<div class="panel"><h2>Topic mastery</h2>
        <table class="tt"><thead><tr><th>Topic</th><th>Cards</th><th>Accuracy</th><th>Median time</th><th>Mastered</th></tr></thead>
        <tbody></tbody></table></div>`);
      const tb=tbl.querySelector("tbody");
      ts.forEach(t=>tb.appendChild(el(`<tr><td>${t.topic}</td><td>${t.cards}</td>
        <td class="pct">${Math.round(t.acc*100)}%</td>
        <td>${t.medLat!=null?t.medLat+"s":"—"}${t.slow?' <span class="tag-slow">·'+t.slow+' slow</span>':''}</td>
        <td>${t.mastered}/${t.cards}</td></tr>`)));
      app.appendChild(tbl);
    }
    // not-automatic
    if(ov.slowList.length){
      const p=el(`<div class="panel"><h2>Not automatic yet <span style="font-size:12px;color:var(--ink-faint);font-weight:400">right but slow — drill for speed</span></h2><div></div></div>`);
      const host=p.querySelector("div:last-child");
      ov.slowList.slice(0,12).forEach(s=>host.appendChild(el(`<div class="lec"><div class="lmeta">
        <div class="lt">${s.id} · ${s.topic}</div><div class="ls">${s.medLat}s vs ${s.target}s target</div></div></div>`)));
      app.appendChild(p);
    }
    if(ov.leeches.length){
      const p=el(`<div class="panel"><h2>Leeches <span style="font-size:12px;color:var(--ink-faint);font-weight:400">missed 3+ times — re-read the concept</span></h2><div></div></div>`);
      const host=p.querySelector("div:last-child");
      ov.leeches.forEach(s=>host.appendChild(el(`<div class="lec"><div class="lmeta">
        <div class="lt">${s.id} · ${s.topic}</div><div class="ls">missed ${s.lapses}×</div></div></div>`)));
      app.appendChild(p);
    }
    // export/import
    const io=el(`<div class="panel"><h2>Backup</h2>
      <p style="color:var(--ink-soft);font-size:14px;margin:0 0 12px">Stats live on this device until cloud sync ships. Export to move between phone &amp; laptop.</p>
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

  // ---------- settings ----------
  function renderSettings(){
    const c = Store.cloudCfg();
    app.innerHTML="";
    app.appendChild(el(`<div class="sec-h">Settings</div>`));
    const p = el(`<div class="panel"><h2>Cloud sync &amp; deep grading</h2>
      <p style="color:var(--ink-soft);font-size:14px;margin:0 0 14px">Enter once per device to sync progress across phone &amp; laptop and enable LLM grading of typed answers. ${Store.cloudConfigured()?'<b style="color:var(--good)">Connected.</b>':'Not connected — running local-only.'}</p>
      <label class="fld">API URL<input id="s-api" placeholder="https://bio305-api.&lt;sub&gt;.workers.dev" value="${c.apiBase||''}"></label>
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
      try{ const got=await Store.pull(); await Store.push();
        status.innerHTML='<b style="color:var(--good)">Connected.</b> '+(got?'Pulled newer cloud data.':'Pushed this device’s progress.'); }
      catch(e){ status.innerHTML='<b style="color:var(--bad)">Failed: '+(e.message||e)+'</b>'; }
    };
    $("#s-test").onclick=async()=>{
      const base=$("#s-api").value.trim().replace(/\/+$/,""); status.textContent="Testing…";
      try{ const r=await fetch(base+"/health"); const d=await r.json();
        status.innerHTML=d.ok?'<b style="color:var(--good)">API reachable.</b>':'Unexpected response'; }
      catch(e){ status.innerHTML='<b style="color:var(--bad)">Unreachable: '+(e.message||e)+'</b>'; }
    };
  }

  // ---------- boot ----------
  Store.init().then(async ()=>{
    applyTheme(Store.settings().theme||"dark");
    const gd=document.getElementById("goal-days"); if(gd) gd.textContent=Store.daysToExam()+" days";
    if(Store.cloudConfigured()){ try{ await Store.pull(); }catch(e){} }
    window.addEventListener("hashchange", route);
    route();
    if("serviceWorker" in navigator && location.hostname.endsWith("github.io"))
      navigator.serviceWorker.register("sw.js").catch(()=>{});
  });
})();
