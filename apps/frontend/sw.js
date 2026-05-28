// Gavirila Homestead — Service Worker
// Provides: install-to-homescreen PWA capability + offline shell caching
// Does NOT intercept API calls — those must stay live.

const CACHE_NAME = 'gavirila-shell-v1';

// Static shell files to cache for instant loading
const SHELL_ASSETS = ['/', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept API calls, WebSocket upgrades, or external resources
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Show a notification when backend broadcasts a gate:needs_review event
// (The main app posts these via postMessage when it receives the WS event)
self.addEventListener('message', (event) => {
  if (event.data?.type === 'gate:needs_review') {
    const { taskId, taskTitle, agent } = event.data;
    self.registration.showNotification('Gavirila — Review needed', {
      body: `${agent || 'An agent'} finished: "${taskTitle || taskId}"`,
      icon: '/manifest.json',
      tag: `review-${taskId}`,
      data: { taskId },
      actions: [
        { action: 'open', title: 'Open' },
      ],
    });
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes('/'));
      if (existing) { existing.focus(); return; }
      return self.clients.openWindow('/');
    })
  );
});
