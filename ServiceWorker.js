self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Nhận thông báo từ server và đính kèm đường dẫn tab đích
self.addEventListener('push', (event) => {
  let data = { title: 'Carmel Coffee ☕', body: 'Bạn có thông báo mới!', url: '/dashboard.html' };
  if (event.data) {
    try {
      data = Object.assign(data, event.data.json());
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: '/logocarmel.jpg',
    badge: '/logocarmel.jpg',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/dashboard.html' }
  };

  const notificationPromise = self.registration.showNotification(data.title, options);
  event.waitUntil(notificationPromise);
});

// Xử lý khi người dùng chạm vào banner thông báo
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = (event.notification.data && event.notification.data.url) || '/dashboard.html';
  const parsed = new URL(rawUrl, self.location.origin);
  const tabParam = parsed.searchParams.get('tab') || '';
  if (tabParam) {
    parsed.hash = tabParam;
  }
  const fullTargetUrl = parsed.href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('dashboard.html') && 'focus' in client) {
          client.postMessage({ type: 'OPEN_TAB_FROM_PUSH', url: fullTargetUrl });
          if ('navigate' in client) {
            client.navigate(fullTargetUrl).catch(() => {});
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(fullTargetUrl);
      }
    })
  );
});