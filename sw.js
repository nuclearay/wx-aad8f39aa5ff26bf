// App shell for faster return visits, plus lightning notifications.
// version 20261112a
// Navigations: serve the cached page immediately when we have one, and refresh that copy in the background.
// pollen.json is not handled here. It is republished on its own schedule and the page revalidates it.
const SHELL='wx-shell-20261112a';
const SHELL_FILES=['./','./index.html','./manifest.json','./icon-192.png','./icon-512.png'];

function storedResponse(res,body){
  // fetch() already decoded the body. Keeping content-encoding would make the cache serve garbage.
  const headers=new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(body,{status:res.status,statusText:res.statusText,headers});
}
async function store(cache,url){
  const res=await fetch(url,{cache:'no-cache'});
  if(!res.ok)throw new Error('shell '+url+' '+res.status);
  const body=await res.blob();
  await cache.put(url,storedResponse(res,body));
}

self.addEventListener('install',()=>self.skipWaiting());

// Fill the shell cache after the page has its weather response, so this download
// does not compete with the first forecast on a cold start.
self.addEventListener('message',e=>{
  if(!e.data||e.data.type!=='shell-cache')return;
  e.waitUntil((async()=>{
    const cache=await caches.open(SHELL);
    if(await cache.match('./index.html'))return;
    for(const url of SHELL_FILES){try{await store(cache,url)}catch(err){}}
  })());
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('wx-shell-')&&k!==SHELL).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});

self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window'}).then(c=>c.length?c[0].focus():self.clients.openWindow('./index.html')));
});

async function cacheShell(res){
  if(!res||!res.ok)return;
  const body=await res.clone().blob();
  const cache=await caches.open(SHELL);
  await cache.put('./index.html',storedResponse(res,body));
}

async function shellNavigate(e){
  const cache=await caches.open(SHELL);
  const cached=await cache.match('./index.html')||await cache.match('./');
  // Low priority so a background shell check does not stall the forecast on a slow link.
  const update=fetch(e.request,{priority:'low'}).then(async res=>{await cacheShell(res);return res}).catch(()=>null);
  e.waitUntil(update.catch(()=>{}));
  if(cached)return cached;
  const res=await update;
  if(res)return res;
  return new Response('Offline',{status:503,headers:{'Content-Type':'text/plain'}});
}

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET'||req.mode!=='navigate')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  if(url.pathname.endsWith('/pollen.json'))return;
  e.respondWith(shellNavigate(e));
});
