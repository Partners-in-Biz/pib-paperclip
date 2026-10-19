// Service worker for web push notifications.
// RFC 8291 payload decryption is handled by the browser before this handler receives it.

self.addEventListener('push', (e) => {
  let title = 'Cockpit';
  let body = 'Notification received';
  let url = undefined;
  let tag = undefined;

  try {
    const payload = e.data.json();
    if (payload && typeof payload === 'object') {
      title = typeof payload.title === 'string' ? payload.title : title;
      body = typeof payload.body === 'string' ? payload.body : body;
      url = typeof payload.url === 'string' ? payload.url : undefined;
      tag = typeof payload.tag === 'string' ? payload.tag : undefined;
    }
  } catch (_) {
    // Not JSON or e.data is empty; use defaults.
    if (e.data) {
      try {
        body = e.data.text();
      } catch (_) {
        body = 'Notification received';
      }
    }
  }

  // Truncate to safe lengths.
  title = title.slice(0, 120);
  body = body.slice(0, 300);

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { url },
      tag,
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  let url = self.location.origin + '/';
  if (e.notification.data && typeof e.notification.data.url === 'string') {
    try {
      const resolved = new URL(e.notification.data.url, self.location.origin).href;
      const origin = new URL(resolved).origin;
      if (origin === self.location.origin) {
        url = resolved;
      }
    } catch (_) {
      // Invalid URL; use origin.
    }
  }

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const w = list[0];
      if (w) {
        const navigatePromise = w.navigate ? w.navigate(url) : Promise.resolve(w);
        return navigatePromise.then((c) => (c || w).focus());
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});
