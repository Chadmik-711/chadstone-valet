// Service worker for the Chadstone Valet dashboard.
// Its only real job is to receive Web Push messages (sent by the
// notify-pickup Edge Function) and show a notification — so staff phones
// buzz even when the dashboard tab is closed or the phone is locked.
//
// Lives at the site root path (…/Valet/sw.js) so its scope covers the app.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: '🔔 Car requested', body: event.data ? event.data.text() : '' }; }

  const title = data.title || '🔔 Car requested';
  const options = {
    body: data.body || 'A customer is ready for their car.',
    tag: data.tag || 'pickup',
    renotify: true,            // re-alert even if a notif with this tag exists
    requireInteraction: true,  // stays on screen until staff act on it
    icon: './icon.svg',
    badge: './icon.svg',
    vibrate: [300, 150, 300, 150, 300],
    data: { url: './index_v2.html' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses an existing dashboard tab, or opens one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './index_v2.html';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('index_v2.html') && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
