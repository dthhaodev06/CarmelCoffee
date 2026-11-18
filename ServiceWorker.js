// 1. Ép Service Worker cài đặt và kích hoạt chạy ngầm ngay lập tức
self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

// 2. Lắng nghe và hiển thị thông báo lên màn hình khóa
self.addEventListener('push', event => {
  let data = { title: 'Carmel Coffee ☕', body: 'Bạn có thông báo mới!' };

  // Bọc an toàn: Đảm bảo không bao giờ bị lỗi sập ngầm
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'Carmel Coffee ☕', body: event.data.text() };
    }
  }

  const options = {
    body: data.body,
    icon: 'https://cdn-icons-png.flaticon.com/512/924/924514.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/924/924514.png',
    vibrate: [200, 100, 200],
    tag: 'carmel-notification', // Chống trùng lặp thông báo
    renotify: true,
    data: {
      url: '/dashboard.html'
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 3. Khi bấm vào thông báo: Tự động mở đúng trang Dashboard
self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Nếu đã có tab Dashboard đang mở thì chuyển tới tab đó
      for (let client of windowClients) {
        if (client.url.includes('/dashboard.html') && 'focus' in client) {
          return client.focus();
        }
      }
      // Nếu chưa có thì mở trang Dashboard mới
      if (clients.openWindow) {
        return clients.openWindow('/dashboard.html');
      }
    })
  );
});