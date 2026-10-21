const CACHE='campmap-shell-v4-duo-20261021';
const SHELL=['/','/index.html','/app-upgrade.js','/app-upgrade.css','/lib/state-core.mjs','/manifest.webmanifest','/apple-touch-icon.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('campmap-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(event.request.mode!=='navigate'&&!SHELL.includes(url.pathname))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    try{const response=await fetch(event.request,{signal:AbortSignal.timeout(5000)});if(response.ok){await cache.put(event.request,response.clone());return response;}throw Error('network');}
    catch{const cached=await cache.match(event.request)||(event.request.mode==='navigate'?await cache.match('/'):null);return cached||new Response('오프라인 화면이 아직 준비되지 않았습니다. 인터넷에 연결한 뒤 다시 열어 주세요.',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});}
  })());
});
