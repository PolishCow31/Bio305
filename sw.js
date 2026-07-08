/* Bio 305 service worker — offline shell cache. Cache version bumps on deploy. */
const C = "bio305-v14";
const ASSETS = ["./","index.html","css/style.css?v=3","js/sync-core.js?v=1","js/store.js?v=6","js/app.js?v=8",
  "data/units.json","data/tags.json","data/L1.json","data/L2.json","data/L3.json","data/L4.json","img/blockm.svg",
  "img/favicon-32.png","img/icon-512.png","apple-touch-icon.png","manifest.json"];
self.addEventListener("install", e=>{
  e.waitUntil(caches.open(C).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e=>{
  e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", e=>{
  if(e.request.method!=="GET") return;
  const url = e.request.url;
  // System-health is refreshed by the critic fleet between deploys — always network, never cache-stale.
  if(url.indexOf("system-health.json")>=0){
    e.respondWith(fetch(e.request).catch(()=>new Response("null",{headers:{"content-type":"application/json"}})));
    return;
  }
  // Content data (units/tags/decks): network-first so new lectures & cards appear immediately; cache = offline fallback.
  if(/\/data\/.*\.json(\?|$)/.test(url)){
    e.respondWith(fetch(e.request).then(resp=>{ const cp=resp.clone(); caches.open(C).then(c=>c.put(e.request,cp)); return resp; })
      .catch(()=>caches.match(e.request)));
    return;
  }
  // App shell: cache-first (versioned).
  e.respondWith(caches.match(e.request).then(r=> r || fetch(e.request).then(resp=>{
    const cp=resp.clone(); caches.open(C).then(c=>c.put(e.request,cp)); return resp;
  }).catch(()=>caches.match("index.html"))));
});
