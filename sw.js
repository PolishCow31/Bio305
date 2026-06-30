/* Bio 305 service worker — offline shell cache. Cache version bumps on deploy. */
const C = "bio305-v1";
const ASSETS = ["./","index.html","css/style.css?v=1","js/store.js?v=1","js/app.js?v=1",
  "data/units.json","data/L1.json","img/blockm.svg","manifest.json"];
self.addEventListener("install", e=>{
  e.waitUntil(caches.open(C).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e=>{
  e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", e=>{
  if(e.request.method!=="GET") return;
  e.respondWith(caches.match(e.request).then(r=> r || fetch(e.request).then(resp=>{
    const cp=resp.clone(); caches.open(C).then(c=>c.put(e.request,cp)); return resp;
  }).catch(()=>caches.match("index.html"))));
});
