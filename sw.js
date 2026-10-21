// Minimal service worker: lets Android Chrome show lightning notifications (it has no page-level Notification constructor).
// version 2026-10-21b (sun twilight)
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window'}).then(c=>c.length?c[0].focus():self.clients.openWindow('./index.html')))});
