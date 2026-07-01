/* Bio 305 API — Cloudflare Pages Function (catch-all under /api/*).
   KV-backed. Sync = whole-blob LWW, server-clock-ordered. Grade queue drained by the local relay.
   Auth: x-app-secret == APP_SECRET (client routes); x-relay-secret == RELAY_SECRET (relay routes). */

const ALLOWED_ORIGINS = [
  "https://polishcow31.github.io",
  "http://localhost:8456",
  "http://127.0.0.1:8456",
];
function cors(origin){
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-app-secret,x-relay-secret",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const json = (d,s,o)=> new Response(JSON.stringify(d),
  { status:s||200, headers:{ "content-type":"application/json", ...cors(o) } });

export async function onRequest(ctx){
  const { request, env, params } = ctx;
  const origin = request.headers.get("Origin") || "";
  if(request.method==="OPTIONS") return new Response(null,{status:204,headers:cors(origin)});

  const seg = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const route = seg.join("/");                 // "", "sync", "grade", "grade/ID", "jobs", "jobs/ID/result", "health"
  const KV = env.BIO305_KV;
  const appOK   = ()=> env.APP_SECRET   && request.headers.get("x-app-secret")===env.APP_SECRET;
  const relayOK = ()=> env.RELAY_SECRET && request.headers.get("x-relay-secret")===env.RELAY_SECRET;

  try{
    if(route===""||route==="health") return json({ok:true,service:"bio305-api"},200,origin);

    // ---- SYNC (whole-blob LWW) ----
    if(route==="sync" && request.method==="GET"){
      if(!appOK()) return json({error:"unauthorized"},401,origin);
      const account = new URL(request.url).searchParams.get("account") || "default";
      const raw = await KV.get("profile:"+account);
      const d = raw ? JSON.parse(raw) : {blob:null,updatedAt:0};
      return json({blob:d.blob, updatedAt:d.updatedAt},200,origin);
    }
    if(route==="sync" && request.method==="POST"){
      if(!appOK()) return json({error:"unauthorized"},401,origin);
      const b = await request.json();
      const account = b.account || "default";
      const blob = typeof b.blob==="string" ? b.blob : JSON.stringify(b.blob||{});
      const now = Date.now();
      await KV.put("profile:"+account, JSON.stringify({blob,updatedAt:now}));
      return json({ok:true,updatedAt:now},200,origin);
    }

    // ---- DEEP GRADE (enqueue + poll) ----
    if(route==="grade" && request.method==="POST"){
      if(!appOK()) return json({error:"unauthorized"},401,origin);
      const b = await request.json();
      const id = crypto.randomUUID();
      await KV.put("job:"+id, JSON.stringify({ id, account:b.account||"default", card_id:b.card_id||"",
        question:b.question||"", model_answer:b.model_answer||"", student_answer:b.student_answer||"",
        status:"pending", created_at:Date.now() }), { expirationTtl: 86400 });   // 24h backstop: abandoned jobs self-clean
      // Maintain a small pending-id index so the relay's every-30s /jobs poll is one GET, never a KV.list.
      const idx = JSON.parse(await KV.get("pending:index") || "[]");
      if(!idx.includes(id)){ idx.push(id); await KV.put("pending:index", JSON.stringify(idx)); }
      return json({id,status:"pending"},200,origin);
    }
    if(route.startsWith("grade/") && request.method==="GET"){
      if(!appOK()) return json({error:"unauthorized"},401,origin);
      const raw = await KV.get("job:"+route.split("/")[1]);
      const j = raw ? JSON.parse(raw) : {status:"unknown"};
      return json({status:j.status,verdict:j.verdict,score:j.score,note:j.note},200,origin);
    }

    // ---- RELAY (local claude -p drainer) ----
    if(route==="jobs" && request.method==="GET"){
      if(!relayOK()) return json({error:"unauthorized"},401,origin);
      const out=[];
      // Hourly reconciliation (relay adds ?full=1 ~once/hour): authoritative KV.list to catch any
      // job the index missed (rare concurrent-write race) and rebuild the index from ground truth.
      // ~24 list ops/day instead of the old 2,880 that blew the 1,000/day list cap ~4am nightly.
      if(new URL(request.url).searchParams.get("full")==="1"){
        const live=[];
        const list = await KV.list({prefix:"job:"});
        for(const k of list.keys){
          const raw = await KV.get(k.name); if(!raw) continue;
          const j = JSON.parse(raw);
          if(j.status==="pending"){ live.push(j.id);
            if(out.length<10) out.push({id:j.id,card_id:j.card_id,question:j.question,model_answer:j.model_answer,student_answer:j.student_answer}); }
        }
        await KV.put("pending:index", JSON.stringify(live));   // rebuild index from truth
        return json({jobs:out,reconciled:true},200,origin);
      }
      // Cheap default path: ONE get for the index, then get only the (usually 0) pending ids. No list.
      const idx = JSON.parse(await KV.get("pending:index") || "[]");
      for(const id of idx){
        const raw = await KV.get("job:"+id); if(!raw) continue;
        const j = JSON.parse(raw);
        if(j.status==="pending"){ out.push({id:j.id,card_id:j.card_id,question:j.question,model_answer:j.model_answer,student_answer:j.student_answer}); }
        if(out.length>=10) break;
      }
      return json({jobs:out},200,origin);
    }
    if(/^jobs\/[^/]+\/result$/.test(route) && request.method==="POST"){
      if(!relayOK()) return json({error:"unauthorized"},401,origin);
      const id = route.split("/")[1];
      const raw = await KV.get("job:"+id); if(!raw) return json({error:"no job"},404,origin);
      const j = JSON.parse(raw); const b = await request.json();
      Object.assign(j,{ status:b.error?"error":"done", verdict:b.verdict||null,
        score:b.score!=null?b.score:null, note:b.note||null, graded_at:Date.now() });
      await KV.put("job:"+id, JSON.stringify(j), { expirationTtl: 3600 });   // auto-clean 1h after grading (app reads verdict well before)
      // Drop from the pending index so the cheap /jobs path stops returning it.
      const idx = JSON.parse(await KV.get("pending:index") || "[]");
      const ni = idx.filter(x=>x!==id);
      if(ni.length!==idx.length) await KV.put("pending:index", JSON.stringify(ni));
      return json({ok:true},200,origin);
    }

    return json({error:"not found",route},404,origin);
  }catch(e){ return json({error:String(e&&e.message||e)},500,origin); }
}
