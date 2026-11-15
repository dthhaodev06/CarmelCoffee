    self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'Carmel Coffee', body: 'Có thông báo mới!' };

  const options = {
    body: data.body,
    icon: 'https://cdn-icons-png.flaticon.com/512/924/924514.png', // Icon ly cà phê
    badge: 'https://cdn-icons-png.flaticon.com/512/924/924514.png',
    vibrate: [200, 100, 200]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Bấm vào thông báo sẽ tự mở web
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/')
  );
});