// Service worker for web push notifications.
// RFC 8291 payload decryption is handled by the browser before this handler receives it.

self.addEventListener('push', (e) => {
  let title = 'Partners in Biz';
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

  // Validate URL: resolve relative to origin, accept only if same-origin.
  let validatedUrl = undefined;
  if (url) {
    try {
      const resolved = new URL(url, self.location.origin).href;
      const resolved_origin = new URL(resolved).origin;
      if (resolved_origin === self.location.origin) {
        validatedUrl = resolved;
      }
    } catch (_) {
      // Invalid URL; discard.
    }
  }

  // Truncate to safe lengths.
  title = title.slice(0, 120);
  body = body.slice(0, 300);

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { url: validatedUrl },
      tag: tag || undefined,
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  let url = self.location.origin + '/';
  if (e.notification.data && typeof e.notification.data.url === 'string') {
    try {
      const resolved = new URL(e.notification.data.url, self.location.origin).href;
      const resolved_origin = new URL(resolved).origin;
      if (resolved_origin === self.location.origin) {
        url = resolved;
      }
    } catch (_) {
      // Invalid URL; use app root.
    }
  }

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Find a client on the same origin.
      let client = undefined;
      for (let i = 0; i < list.length; i++) {
        try {
          const clientOrigin = new URL(list[i].url).origin;
          if (clientOrigin === self.location.origin) {
            client = list[i];
            break;
          }
        } catch (_) {
          // Invalid URL; skip.
        }
      }
      if (client) {
        const navigatePromise = client.navigate ? client.navigate(url) : Promise.resolve(client);
        return navigatePromise.then((c) => (c || client).focus());
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
