/* Bio 305 — exam: timed mock-exam engine (Exam I, Unit 1). Depends on Store.
   Sits alongside the flashcard app: papers are their own data, results feed the tag weights. */
(function(){
  const el = (h)=>{ const d=document.createElement("div"); d.innerHTML=h.trim(); return d.firstElementChild; };
  const esc = s=>(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const md  = t=>Store.md(t||"");
  const LETTERS = "ABCDE".split("");
  const KEY = "bio305.exam";

  // ---------- persistence (separate from the SRS blob; exams are their own record) ----------
  function load(){ try{ return JSON.parse(localStorage.getItem(KEY)) || {attempts:[], active:null}; }
                   catch(e){ return {attempts:[], active:null}; } }
  function persist(s){ try{ localStorage.setItem(KEY, JSON.stringify(s)); }catch(e){} }
  let X = load();

  // ---------- paper loading ----------
  const papers = {};       // id -> paper
  let index = null;        // exams.json
  async function loadIndex(){
    if(index) return index;
    const r = await fetch("data/exams.json", {cache:"no-store"});
    index = await r.json(); return index;
  }
  async function loadPaper(id){
    if(papers[id]) return papers[id];
    const idx = await loadIndex();
    const meta = idx.papers.find(p=>p.id===id);
    if(!meta) throw new Error("Unknown paper: "+id);
    const r = await fetch("data/"+meta.file, {cache:"no-store"});
    const p = await r.json(); papers[id]=p; return p;
  }

  // ---------- scoring ----------
  // MC scores itself. Typed problems are self-graded in review against a rubric, so a fresh
  // attempt reports MC-only until he grades the written work; `provisional` says so out loud.
  function scoreAttempt(paper, att){
    let mcPts=0, mcMax=0, wrPts=0, wrMax=0, mcRight=0, mcTot=0;
    paper.questions.forEach(q=>{
      const a = att.answers[q.id];
      if(q.type==="mc"){
        mcMax += q.pts; mcTot++;
        if(a!=null && a===q.answer){ mcPts += q.pts; mcRight++; }
      } else {
        wrMax += q.pts;
        const sg = att.selfGrade && att.selfGrade[q.id];
        if(sg && sg.pts!=null) wrPts += sg.pts;
      }
    });
    const ungraded = paper.questions.filter(q=>q.type!=="mc" && !(att.selfGrade&&att.selfGrade[q.id])).length;
    return { mcPts, mcMax, wrPts, wrMax, mcRight, mcTot, ungraded,
             pts: mcPts+wrPts, max: mcMax+wrMax,
             pct: (mcMax+wrMax) ? (mcPts+wrPts)/(mcMax+wrMax) : 0,
             mcPct: mcMax ? mcPts/mcMax : 0 };
  }
  // U-M grade bands. She does not round: 90.0 = A-, 89.999 = B+.
  function band(pct){
    const p = pct*100;
    if(p>=93) return "A"; if(p>=90) return "A−"; if(p>=87) return "B+"; if(p>=83) return "B";
    if(p>=80) return "B−"; if(p>=77) return "C+"; if(p>=73) return "C"; if(p>=70) return "C−";
    if(p>=67) return "D+"; if(p>=63) return "D"; if(p>=60) return "D−"; return "E";
  }

  // ---------- shared bits ----------
  function fmtClock(ms){
    if(ms<0) ms=0;
    const s=Math.floor(ms/1000), m=Math.floor(s/60), ss=s%60;
    return m+":"+String(ss).padStart(2,"0");
  }
  function groupOf(paper, q){ return q.group ? (paper.groups||[]).find(g=>g.id===q.group) : null; }

  // The codon + wobble reference she hands out on paper. Practising without it trains the wrong task.
  function formulaSheet(){
    const bases=["U","C","A","G"];
    const CODON={
      UUU:"Phe",UUC:"Phe",UUA:"Leu",UUG:"Leu",CUU:"Leu",CUC:"Leu",CUA:"Leu",CUG:"Leu",
      AUU:"Ile",AUC:"Ile",AUA:"Ile",AUG:"Met",GUU:"Val",GUC:"Val",GUA:"Val",GUG:"Val",
      UCU:"Ser",UCC:"Ser",UCA:"Ser",UCG:"Ser",CCU:"Pro",CCC:"Pro",CCA:"Pro",CCG:"Pro",
      ACU:"Thr",ACC:"Thr",ACA:"Thr",ACG:"Thr",GCU:"Ala",GCC:"Ala",GCA:"Ala",GCG:"Ala",
      UAU:"Tyr",UAC:"Tyr",UAA:"STOP",UAG:"STOP",CAU:"His",CAC:"His",CAA:"Gln",CAG:"Gln",
      AAU:"Asn",AAC:"Asn",AAA:"Lys",AAG:"Lys",GAU:"Asp",GAC:"Asp",GAA:"Glu",GAG:"Glu",
      UGU:"Cys",UGC:"Cys",UGA:"STOP",UGG:"Trp",CGU:"Arg",CGC:"Arg",CGA:"Arg",CGG:"Arg",
      AGU:"Ser",AGC:"Ser",AGA:"Arg",AGG:"Arg",GGU:"Gly",GGC:"Gly",GGA:"Gly",GGG:"Gly"};
    let rows="";
    bases.forEach(b1=>{ bases.forEach(b3=>{
      let tds="";
      bases.forEach(b2=>{ const c=b1+b2+b3; tds+=`<td><code>${c}</code> ${CODON[c]}</td>`; });
      rows+=`<tr>${tds}</tr>`;
    });});
    return el(`<div class="panel sheet">
      <div class="sheet-h">Formula sheet — provided on the real exam (signed, M-Card surrendered)</div>
      <table class="codon"><tbody>${rows}</tbody></table>
      <div class="wobble">
        <b>Wobble (5′ base of the anticodon → 3′ base of the codon it can read)</b>
        <table class="wob"><tbody>
          <tr><td><code>G</code></td><td>reads U or C</td></tr>
          <tr><td><code>C</code></td><td>reads G only</td></tr>
          <tr><td><code>A</code></td><td>reads U only</td></tr>
          <tr><td><code>U</code></td><td>reads A or G</td></tr>
          <tr><td><code>I</code> (inosine)</td><td>reads U, C or A</td></tr>
        </tbody></table>
        <p class="fine">Max 5 codons read by one tRNA (inosine); min 3 tRNAs to read a 6-codon family.
        Anticodons are written 3′→5′ when paired against a 5′→3′ codon.</p>
      </div>
    </div>`);
  }

  // ---------- view: exam home ----------
  async function renderHome(app){
    app.innerHTML="";
    let idx;
    try{ idx = await loadIndex(); }
    catch(e){ app.appendChild(el(`<div class="empty"><div class="big">No papers found</div><p>data/exams.json failed to load.</p></div>`)); return; }

    app.appendChild(el(`<section class="hero exam-hero">
      <div class="watermark" aria-hidden="true"></div>
      <p class="eyebrow">Timed mock · exam conditions</p>
      <h1>Exam I practice</h1>
      <p class="sub">${esc(idx.blurb||"")}</p>
    </section>`));

    if(X.active){
      const p = idx.papers.find(q=>q.id===X.active.paper);
      const left = X.active.endsAt - Date.now();
      const bar = el(`<div class="resume-bar">
        <div><b>In progress — ${esc(p?p.title:X.active.paper)}</b>
          <span class="fine">${left>0? fmtClock(left)+" left" : "time expired"}</span></div>
        <div class="cta-row"></div></div>`);
      const go1=el(`<button class="btn">Resume</button>`); go1.onclick=()=>{ location.hash="/exam/take/"+X.active.paper; };
      const go2=el(`<button class="btn alt">Discard</button>`);
      go2.onclick=()=>{ if(confirm("Discard the in-progress attempt? This cannot be undone.")){ X.active=null; persist(X); renderHome(app); } };
      bar.querySelector(".cta-row").append(go1,go2);
      app.appendChild(bar);
    }

    app.appendChild(el(`<div class="sec-h">Papers</div>`));
    const list = el(`<div class="paper-list"></div>`);
    idx.papers.forEach(p=>{
      const mine = X.attempts.filter(a=>a.paper===p.id);
      const best = mine.length ? Math.max(...mine.map(a=>a.scorePct||0)) : null;
      const row = el(`<div class="paper">
        <div class="p-main">
          <div class="p-t">${esc(p.title)}</div>
          <div class="p-s">${esc(p.covers)} · ${p.questions} questions · ${p.points} points · ${p.minutes} min</div>
          <div class="p-d">${esc(p.blurb||"")}</div>
        </div>
        <div class="p-side">
          ${best!=null?`<div class="p-best"><span class="k">best</span><span class="v">${Math.round(best*100)}%</span><span class="g">${band(best)}</span></div>`:``}
          <div class="cta-row"></div>
        </div>
      </div>`);
      const start = el(`<button class="btn">${mine.length?"Retake":"Start"}</button>`);
      start.onclick = ()=>{
        if(X.active && !confirm("You have an attempt in progress. Starting a new one discards it. Continue?")) return;
        beginAttempt(p.id, p.minutes);
      };
      row.querySelector(".cta-row").appendChild(start);
      if(mine.length){
        const rev=el(`<button class="btn alt">Review last</button>`);
        rev.onclick=()=>{ location.hash="/exam/review/"+X.attempts.lastIndexOf(mine[mine.length-1]); };
        row.querySelector(".cta-row").appendChild(rev);
      }
      list.appendChild(row);
    });
    app.appendChild(list);

    if(X.attempts.length){
      app.appendChild(el(`<div class="sec-h">Your attempts</div>`));
      const t = el(`<div class="att-list"></div>`);
      X.attempts.slice().reverse().forEach((a)=>{
        const realIdx = X.attempts.indexOf(a);
        const p = idx.papers.find(q=>q.id===a.paper);
        const d = new Date(a.submittedAt);
        const r = el(`<div class="att">
          <div class="a-l"><b>${esc(p?p.title:a.paper)}</b>
            <span class="fine">${d.toLocaleDateString(undefined,{month:"short",day:"numeric"})} ${d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})} · ${fmtClock(a.elapsed)} used</span></div>
          <div class="a-r">
            <span class="sc">${Math.round((a.scorePct||0)*100)}%</span>
            <span class="bd">${band(a.scorePct||0)}</span>
            ${a.ungraded?`<span class="chip warn">${a.ungraded} to grade</span>`:``}
          </div></div>`);
        r.onclick=()=>{ location.hash="/exam/review/"+realIdx; };
        t.appendChild(r);
      });
      app.appendChild(t);
    }

    app.appendChild(el(`<div class="sec-h">Reference</div>`));
    app.appendChild(formulaSheet());
  }

  function beginAttempt(paperId, minutes){
    const now = Date.now();
    X.active = { paper:paperId, startedAt:now, endsAt: now + minutes*60000,
                 answers:{}, flags:{}, seen:{}, pos:0 };
    persist(X);
    location.hash = "/exam/take/"+paperId;
  }

  // ---------- view: sit the exam ----------
  let tick = null;
  async function renderTake(app, paperId){
    if(tick){ clearInterval(tick); tick=null; }
    let paper;
    try{ paper = await loadPaper(paperId); }
    catch(e){ app.innerHTML=""; app.appendChild(el(`<div class="empty"><div class="big">Couldn't load that paper</div><p>${esc(e.message)}</p></div>`)); return; }

    if(!X.active || X.active.paper!==paperId){ beginAttempt(paperId, paper.minutes); }
    const A = X.active;

    app.innerHTML="";
    app.classList.add("exam-mode");
    const shell = el(`<div class="exam-shell">
      <div class="exam-bar">
        <div class="eb-l"><b>${esc(paper.title)}</b><span class="fine">${esc(paper.covers)} · ${paper.points} pts</span></div>
        <div class="eb-c"><span class="clock" id="ex-clock">—:—</span></div>
        <div class="eb-r">
          <button class="btn alt tiny" id="ex-sheet">Formula sheet</button>
          <button class="btn tiny" id="ex-submit">Submit</button>
        </div>
      </div>
      <div class="palette" id="ex-pal"></div>
      <div class="qhost" id="ex-q"></div>
      <div class="exam-nav">
        <button class="btn alt" id="ex-prev">← Previous</button>
        <button class="btn alt" id="ex-flag">Flag for review</button>
        <button class="btn" id="ex-next">Next →</button>
      </div>
      <div class="sheet-host" id="ex-sheet-host" hidden></div>
    </div>`);
    app.appendChild(shell);

    const clockEl = shell.querySelector("#ex-clock");
    const palEl   = shell.querySelector("#ex-pal");
    const qEl     = shell.querySelector("#ex-q");
    const sheetHost = shell.querySelector("#ex-sheet-host");

    shell.querySelector("#ex-sheet").onclick = ()=>{
      if(sheetHost.hidden){ if(!sheetHost.firstChild) sheetHost.appendChild(formulaSheet()); sheetHost.hidden=false; }
      else sheetHost.hidden=true;
    };
    shell.querySelector("#ex-prev").onclick = ()=>{ if(A.pos>0){ A.pos--; persist(X); draw(); } };
    shell.querySelector("#ex-next").onclick = ()=>{ if(A.pos<paper.questions.length-1){ A.pos++; persist(X); draw(); } };
    shell.querySelector("#ex-flag").onclick = ()=>{ const q=paper.questions[A.pos]; A.flags[q.id]=!A.flags[q.id]; persist(X); draw(); };
    shell.querySelector("#ex-submit").onclick = ()=>confirmSubmit(paper);

    function drawClock(){
      const left = A.endsAt - Date.now();
      clockEl.textContent = fmtClock(left);
      clockEl.classList.toggle("warn", left<=15*60000 && left>5*60000);
      clockEl.classList.toggle("danger", left<=5*60000);
      if(left<=0){ clearInterval(tick); tick=null; submit(paper, true); }
    }
    drawClock(); tick = setInterval(drawClock, 1000);

    function drawPalette(){
      palEl.innerHTML="";
      paper.questions.forEach((q,i)=>{
        const answered = A.answers[q.id]!=null && A.answers[q.id]!=="";
        const b = el(`<button class="pal ${i===A.pos?"cur":""} ${answered?"done":""} ${A.flags[q.id]?"flag":""}"
                       title="${esc(q.topic||"")}">${i+1}</button>`);
        b.onclick=()=>{ A.pos=i; persist(X); draw(); };
        palEl.appendChild(b);
      });
    }

    function draw(){
      drawPalette();
      const q = paper.questions[A.pos];
      A.seen[q.id]=true;
      qEl.innerHTML="";
      const g = groupOf(paper,q);
      if(g){
        qEl.appendChild(el(`<div class="shared">
          <div class="sh-h">Questions ${paper.questions.filter(x=>x.group===g.id).map(x=>paper.questions.indexOf(x)+1).join(" and ")} share this scenario</div>
          <div class="md">${md(g.stem)}</div>
          ${g.data?`<div class="datablock md">${md(g.data)}</div>`:``}
        </div>`));
      }
      const head = el(`<div class="q-head">
        <span class="qn">Question ${A.pos+1} <span class="of">of ${paper.questions.length}</span></span>
        ${q.section?`<span class="chip sect">${esc(q.section)}</span>`:``}
        <span class="qp">${q.pts} ${q.pts===1?"point":"points"}</span>
        ${A.flags[q.id]?`<span class="chip warn">flagged</span>`:``}
      </div>`);
      qEl.appendChild(head);
      qEl.appendChild(el(`<div class="q-stem md">${md(q.stem)}</div>`));

      if(q.type==="mc"){
        const opts = el(`<div class="opts"></div>`);
        q.options.forEach((o,i)=>{
          const chosen = A.answers[q.id]===i;
          const b = el(`<button class="opt ${chosen?"sel":""}">
            <span class="ol">${LETTERS[i]}</span><span class="ot md">${md(o)}</span></button>`);
          b.onclick=()=>{ A.answers[q.id] = (A.answers[q.id]===i? null : i); persist(X); draw(); };
          opts.appendChild(b);
        });
        qEl.appendChild(opts);
        // Calculation questions get a scratchpad. It never scores — but on a mapping or Chargaff
        // question the work IS the skill, and review shows it back next to the worked solution.
        if(q.work){
          const sp = el(`<details class="scratch" ${A.scratch&&A.scratch[q.id]?"open":""}>
            <summary>Scratch work — recommended on this one</summary>
            <textarea placeholder="Work it through here."></textarea></details>`);
          const sta = sp.querySelector("textarea");
          A.scratch = A.scratch || {};
          sta.value = A.scratch[q.id]||"";
          sta.oninput = ()=>{ A.scratch[q.id]=sta.value; persist(X); };
          qEl.appendChild(sp);
        }
      } else {
        const ta = el(`<textarea class="work" placeholder="Show your work — the reasoning is the point on these.">${esc(A.answers[q.id]||"")}</textarea>`);
        ta.oninput = ()=>{ A.answers[q.id]=ta.value; persist(X); };
        ta.onblur  = ()=>{ drawPalette(); };
        qEl.appendChild(ta);
      }
      shell.querySelector("#ex-prev").disabled = A.pos===0;
      shell.querySelector("#ex-next").disabled = A.pos===paper.questions.length-1;
      shell.querySelector("#ex-flag").textContent = A.flags[q.id] ? "Unflag" : "Flag for review";
    }
    draw();

    // A-E to answer, arrows to move. Ignored while typing a written answer.
    function keys(e){
      if(/^(INPUT|TEXTAREA)$/.test((e.target.tagName||""))) return;
      const q = paper.questions[A.pos];
      if(q.type==="mc"){
        const k = LETTERS.indexOf((e.key||"").toUpperCase());
        if(k>=0 && k<q.options.length){ e.preventDefault(); A.answers[q.id]=(A.answers[q.id]===k?null:k); persist(X); draw(); return; }
      }
      if(e.key==="ArrowRight"){ e.preventDefault(); if(A.pos<paper.questions.length-1){A.pos++;persist(X);draw();} }
      if(e.key==="ArrowLeft"){  e.preventDefault(); if(A.pos>0){A.pos--;persist(X);draw();} }
      if((e.key||"").toLowerCase()==="f"){ e.preventDefault(); A.flags[q.id]=!A.flags[q.id]; persist(X); draw(); }
    }
    document.addEventListener("keydown", keys);
    takeCleanup = ()=>{ document.removeEventListener("keydown", keys); if(tick){clearInterval(tick);tick=null;} app.classList.remove("exam-mode"); };

    function confirmSubmit(paper){
      const blank = paper.questions.filter(q=>A.answers[q.id]==null || A.answers[q.id]==="").length;
      const msg = blank ? `${blank} question${blank>1?"s are":" is"} unanswered. Submit anyway?` : "Submit the exam?";
      if(confirm(msg)) submit(paper,false);
    }
  }
  let takeCleanup = null;

  function submit(paper, autoTimeout){
    const A = X.active; if(!A) return;
    const now = Date.now();
    const att = { paper:paper.id, startedAt:A.startedAt, submittedAt:now,
                  elapsed: Math.min(now-A.startedAt, paper.minutes*60000),
                  answers:A.answers, flags:A.flags, scratch:A.scratch||{}, selfGrade:{}, autoTimeout:!!autoTimeout };
    const sc = scoreAttempt(paper, att);
    att.scorePct = sc.pct; att.mcPct = sc.mcPct; att.ungraded = sc.ungraded;
    X.attempts.push(att); X.active=null; persist(X);

    // Missed MC feeds the adaptive review queue — the exam is also a diagnostic.
    paper.questions.forEach(q=>{
      if(q.type!=="mc" || !q.tags) return;
      const right = att.answers[q.id]===q.answer;
      if(Store.examBump) Store.examBump(q.tags, right?3:1);
    });
    if(takeCleanup) takeCleanup();
    location.hash = "/exam/review/"+(X.attempts.length-1);
  }

  // ---------- view: review ----------
  async function renderReview(app, idxStr){
    if(takeCleanup) takeCleanup();
    const i = parseInt(idxStr,10);
    const att = X.attempts[i];
    if(!att){ app.innerHTML=""; app.appendChild(el(`<div class="empty"><div class="big">No such attempt</div></div>`)); return; }
    let paper;
    try{ paper = await loadPaper(att.paper); }
    catch(e){ app.innerHTML=""; app.appendChild(el(`<div class="empty"><div class="big">Couldn't load that paper</div></div>`)); return; }

    function redraw(){
      const sc = scoreAttempt(paper, att);
      att.scorePct = sc.pct; att.ungraded = sc.ungraded; persist(X);
      app.innerHTML="";

      app.appendChild(el(`<div class="tiles">
        <div class="tile"><div class="k">Score</div><div class="v">${Math.round(sc.pct*100)}<span class="u">%</span></div></div>
        <div class="tile"><div class="k">Grade</div><div class="v">${band(sc.pct)}</div></div>
        <div class="tile"><div class="k">Points</div><div class="v">${sc.pts}<span class="u"> / ${sc.max}</span></div></div>
        <div class="tile"><div class="k">Multiple choice</div><div class="v">${sc.mcRight}<span class="u"> / ${sc.mcTot}</span></div></div>
        <div class="tile"><div class="k">Time used</div><div class="v">${fmtClock(att.elapsed)}</div></div>
        <div class="tile"><div class="k">Pace</div><div class="v">${Math.round(att.elapsed/60000/paper.questions.length*10)/10}<span class="u"> min/q</span></div></div>
      </div>`));

      if(sc.ungraded){
        app.appendChild(el(`<div class="notice">${sc.ungraded} written ${sc.ungraded>1?"problems are":"problem is"} not graded yet —
          the score above counts them as zero. Grade them against the rubric below to see the real number.</div>`));
      }
      if(att.autoTimeout){
        app.appendChild(el(`<div class="notice warn">Time expired — this attempt was submitted automatically.</div>`));
      }

      // Where the points went, by lecture — the actual triage signal with the exam this close.
      const byLec = {};
      paper.questions.forEach(q=>{
        const L = q.lecture||0; byLec[L] = byLec[L] || {got:0,max:0,miss:[]};
        byLec[L].max += q.pts;
        if(q.type==="mc"){ if(att.answers[q.id]===q.answer) byLec[L].got += q.pts; else byLec[L].miss.push(q); }
        else { const sg=att.selfGrade[q.id]; if(sg&&sg.pts!=null){ byLec[L].got += sg.pts; if(sg.pts<q.pts) byLec[L].miss.push(q);} }
      });
      app.appendChild(el(`<div class="sec-h">Where the points went</div>`));
      const lecWrap = el(`<div class="lecbars"></div>`);
      Object.keys(byLec).sort((a,b)=>a-b).forEach(L=>{
        const b=byLec[L], pct = b.max? b.got/b.max : 0;
        const hue = pct>=0.85?"ok":pct>=0.7?"mid":"bad";
        lecWrap.appendChild(el(`<div class="lecbar">
          <div class="lb-h"><b>Lecture ${L}</b><span>${b.got} / ${b.max}</span></div>
          <div class="lb-t"><div class="lb-f ${hue}" style="width:${Math.round(pct*100)}%"></div></div>
        </div>`));
      });
      app.appendChild(lecWrap);

      app.appendChild(el(`<div class="sec-h">Every question</div>`));
      paper.questions.forEach((q,qi)=>{
        const a = att.answers[q.id];
        const right = q.type==="mc" ? a===q.answer : null;
        const sg = att.selfGrade[q.id];
        const cls = q.type==="mc" ? (right?"ok":"bad") : (sg? (sg.pts>=q.pts?"ok":sg.pts>0?"mid":"bad") : "ungraded");
        const card = el(`<div class="rev ${cls}">
          <div class="rev-h">
            <span class="rn">${qi+1}</span>
            <span class="rt">${esc(q.topic||"")} <span class="fine">· L${q.lecture} · ${q.pts} pts</span></span>
            <span class="rv">${q.type==="mc" ? (right?"✓":"✗") : (sg? sg.pts+"/"+q.pts : "grade it")}</span>
          </div>
          <div class="rev-b"></div>
        </div>`);
        const body = card.querySelector(".rev-b");
        const g = groupOf(paper,q);
        if(g) body.appendChild(el(`<div class="shared sm"><div class="md">${md(g.stem)}</div>${g.data?`<div class="datablock md">${md(g.data)}</div>`:``}</div>`));
        body.appendChild(el(`<div class="q-stem md">${md(q.stem)}</div>`));

        if(q.type==="mc"){
          const ol = el(`<div class="opts rev-opts"></div>`);
          q.options.forEach((o,oi)=>{
            const isAns = oi===q.answer, isMine = oi===a;
            const tag = isAns? `<span class="tagme ok">correct</span>` : (isMine? `<span class="tagme bad">you</span>`:``);
            const why = isAns ? (q.why||"") : ((q.wrong&&q.wrong[oi])||"");
            ol.appendChild(el(`<div class="opt rev-opt ${isAns?"is-ans":""} ${isMine&&!isAns?"is-mine":""}">
              <span class="ol">${LETTERS[oi]}</span>
              <div class="oc"><div class="ot md">${md(o)}</div>
                ${why?`<div class="owhy md">${md(why)}</div>`:``}</div>
              ${tag}</div>`));
          });
          body.appendChild(ol);
          if(a==null) body.appendChild(el(`<div class="fine blank">You left this blank.</div>`));
          const sw = att.scratch && att.scratch[q.id];
          if(sw) body.appendChild(el(`<div class="yours"><span class="lead">Your scratch work</span><div class="md">${md(sw)}</div></div>`));
          if(q.worked) body.appendChild(el(`<div class="worked"><span class="lead">How to work it</span><div class="md">${md(q.worked)}</div></div>`));
        } else {
          body.appendChild(el(`<div class="yours"><span class="lead">Your work</span>
            <div class="md">${a? md(a) : "<i>blank</i>"}</div></div>`));
          body.appendChild(el(`<div class="worked"><span class="lead">Worked solution</span>
            <div class="md">${md(q.worked||"")}</div>
            <div class="md" style="margin-top:10px"><b>Answer:</b> ${md(q.answer||"")}</div></div>`));
          if(q.rubric && q.rubric.length){
            const rb = el(`<div class="rubric"><span class="lead">Mark yourself — tick each point you actually got</span></div>`);
            const per = q.pts / q.rubric.length;
            const state = (sg && sg.ticks) ? sg.ticks.slice() : q.rubric.map(()=>false);
            q.rubric.forEach((r,ri)=>{
              const row=el(`<label class="rb-row"><input type="checkbox" ${state[ri]?"checked":""}/><span class="md">${md(r)}</span></label>`);
              row.querySelector("input").onchange=(e)=>{
                state[ri]=e.target.checked;
                const got = state.filter(Boolean).length;
                att.selfGrade[q.id] = { ticks:state.slice(), pts: Math.round(got*per*10)/10 };
                persist(X);
                if(Store.examBump && q.tags) Store.examBump(q.tags, got===q.rubric.length?3:1);
                redraw();
              };
              rb.appendChild(row);
            });
            body.appendChild(rb);
          }
          const isLocal=["localhost","127.0.0.1"].includes(location.hostname);
          const dg = el(`<div class="cta-row"><button class="btn alt tiny deep">${isLocal?"Deep grade this answer":"Deep grade — laptop only"}</button></div>`);
          dg.querySelector(".deep").onclick = async (e)=>{
            if(!isLocal){ e.target.disabled=true; return; }
            e.target.disabled=true; e.target.textContent="Grading…";
            try{
              const r = await Store.localGrade({id:q.id,q:q.stem,worked:q.worked,answer:q.answer}, a||"");
              if(r && !r.error){
                e.target.textContent = "Graded: "+(r.verdict||"");
                body.appendChild(el(`<div class="verdict ${r.verdict==='correct'?'ok':r.verdict==='partial'?'partial':'no'}">
                  <b>Tutor:</b> ${esc(r.note||"")}</div>`));
              } else { e.target.textContent = "Grader offline"; }
            }catch(x){ e.target.textContent="Error"; }
          };
          body.appendChild(dg);
        }
        if(q.src) body.appendChild(el(`<div class="fine src">Source: ${esc(q.src)}</div>`));
        app.appendChild(card);
      });

      const foot = el(`<div class="cta-row" style="justify-content:center;margin:22px 0 40px"></div>`);
      const again=el(`<button class="btn">Back to papers</button>`); again.onclick=()=>{ location.hash="/exam"; };
      const drill=el(`<button class="btn alt">Drill what I missed</button>`);
      drill.onclick=()=>{
        // Hand the weakest tag straight to the flashcard engine.
        const missed = {};
        paper.questions.forEach(q=>{
          const wrong = q.type==="mc" ? att.answers[q.id]!==q.answer
                                      : !(att.selfGrade[q.id] && att.selfGrade[q.id].pts>=q.pts);
          if(wrong) (q.tags||[]).forEach(t=>missed[t]=(missed[t]||0)+1);
        });
        const top = Object.keys(missed).sort((x,y)=>missed[y]-missed[x])[0];
        location.hash = top ? "/review/tag:"+top : "/review/smart";
      };
      foot.append(again,drill);
      app.appendChild(foot);
    }
    redraw();
  }

  window.Exam = { renderHome, renderTake, renderReview,
                  cleanup: ()=>{ if(takeCleanup) takeCleanup(); } };
})();
