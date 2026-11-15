const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'database.json');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function readData() {
  if (!fs.existsSync(DB_FILE)) {
    const defaultData = {
      users: {
        "Admin": { role: "manager", pass: "123456" }
      },
      inventory: [],
      registrations: {},
      masterRoster: {},
      shiftRequests: [],
      revenue: {},
      expenses: [],
      auditLogs: [],
      carmel_user_accounts: { "Admin": "manager" },
      all_staff_registrations: {},
      carmel_master_roster: {},
      carmel_shift_requests: [],
      carmel_inventory: [],
      carmel_revenue_records: {},
      carmel_expense_records: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }

  try {
    let data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (!data.users) data.users = {};
    if (!data.inventory) data.inventory = [];
    if (!data.registrations) data.registrations = {};
    if (!data.masterRoster) data.masterRoster = {};
    if (!data.shiftRequests) data.shiftRequests = [];
    if (!data.revenue) data.revenue = {};
    if (!data.expenses) data.expenses = [];
    if (!data.auditLogs) data.auditLogs = [];
    if (!data.carmel_user_accounts) {
      data.carmel_user_accounts = {};
      Object.keys(data.users).forEach(u => data.carmel_user_accounts[u] = data.users[u].role);
    }
    if (!data.carmel_master_roster) data.carmel_master_roster = data.masterRoster;
    if (!data.all_staff_registrations) data.all_staff_registrations = data.registrations;
    if (!data.carmel_shift_requests) data.carmel_shift_requests = data.shiftRequests;
    if (!data.carmel_inventory) data.carmel_inventory = data.inventory;
    if (!data.carmel_revenue_records) data.carmel_revenue_records = data.revenue;
    if (!data.carmel_expense_records) data.carmel_expense_records = data.expenses;
    return data;
  } catch (err) {
    console.error("Lỗi đọc file database.json:", err);
    return {};
  }
}

function writeData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function logActivity(data, actor, action, detail) {
  const logItem = {
    id: Date.now(),
    time: new Date().toLocaleString('vi-VN'),
    actor: actor || 'Ẩn danh',
    action: action,
    detail: detail || ''
  };
  if (!Array.isArray(data.auditLogs)) data.auditLogs = [];
  data.auditLogs.unshift(logItem);
}

// 1. API lấy toàn bộ dữ liệu
app.get('/api/data', (req, res) => {
  res.json(readData());
});

// 2. API lưu dữ liệu tổng hợp
app.post('/api/save-data', (req, res) => {
  const incomingData = req.body;
  const data = readData();
  Object.assign(data, incomingData);

  if (incomingData.carmel_master_roster) data.masterRoster = incomingData.carmel_master_roster;
  if (incomingData.all_staff_registrations) data.registrations = incomingData.all_staff_registrations;
  if (incomingData.carmel_shift_requests) data.shiftRequests = incomingData.carmel_shift_requests;
  if (incomingData.carmel_inventory) data.inventory = incomingData.carmel_inventory;
  if (incomingData.carmel_revenue_records) data.revenue = incomingData.carmel_revenue_records;
  if (incomingData.carmel_expense_records) data.expenses = incomingData.carmel_expense_records;

  writeData(data);
  res.json({ success: true });
});

// 3. API Đăng nhập (CHỈ CHO PHÉP TÀI KHOẢN ĐÃ ĐƯỢC ADMIN TẠO)
app.post('/api/login', (req, res) => {
  const { name, pass } = req.body;
  const data = readData();

  if (!data.users[name]) {
    return res.status(401).json({ 
      success: false, 
      message: 'Tài khoản chưa được tạo! Vui lòng liên hệ Admin/Quản lý để được cấp tài khoản.' 
    });
  }

  if (data.users[name].pass !== pass) {
    return res.status(401).json({ success: false, message: 'Sai mật khẩu!' });
  }

  logActivity(data, name, 'Đăng nhập', 'Vào hệ thống thành công');
  writeData(data);

  res.json({
    success: true,
    user: {
      name: name,
      role: data.users[name].role
    }
  });
});

// 4. API TẠO TÀI KHOẢN MỚI DÀNH RIÊNG CHO ADMIN
app.post('/api/users/create', (req, res) => {
  const { name, pass, role, actor } = req.body;
  const data = readData();

  if (!name || !pass) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ tên và mật khẩu!' });
  }

  const staffName = name.trim();
  if (data.users[staffName]) {
    return res.status(400).json({ success: false, message: 'Tài khoản này đã tồn tại trên hệ thống!' });
  }

  const userRole = role || 'employee';
  data.users[staffName] = { role: userRole, pass: pass.trim() };
  data.carmel_user_accounts[staffName] = userRole;

  if (!data.masterRoster[staffName]) {
    const emptyShifts = { t2: 'Off', t3: 'Off', t4: 'Off', t5: 'Off', t6: 'Off', t7: 'Off', cn: 'Off' };
    data.masterRoster[staffName] = emptyShifts;
    data.carmel_master_roster[staffName] = emptyShifts;
  }

  logActivity(data, actor || 'Admin', 'Tạo tài khoản', `Cấp tài khoản cho: ${staffName} (${userRole})`);
  writeData(data);

  res.json({ success: true, message: `Đã cấp tài khoản cho ${staffName} thành công!` });
});

// 5. API XÓA TÀI KHOẢN NHÂN VIÊN DÀNH RIÊNG CHO ADMIN
app.delete('/api/users/:name', (req, res) => {
  const staffName = req.params.name;
  const actor = req.query.actor || 'Admin';
  const data = readData();

  if (staffName.toLowerCase() === 'admin') {
    return res.status(400).json({ success: false, message: 'Không thể xóa tài khoản Admin máy chủ!' });
  }

  if (data.users[staffName]) {
    delete data.users[staffName];
    delete data.carmel_user_accounts[staffName];
    if (data.masterRoster) delete data.masterRoster[staffName];
    if (data.carmel_master_roster) delete data.carmel_master_roster[staffName];
    if (data.registrations) delete data.registrations[staffName];
    if (data.all_staff_registrations) delete data.all_staff_registrations[staffName];

    logActivity(data, actor, 'Xóa tài khoản', `Đã xóa nhân viên: ${staffName}`);
    writeData(data);
    return res.json({ success: true });
  }

  res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
});

// 6. API XÓA SẠCH LỊCH VỀ OFF
app.post('/api/shifts/clear-roster', (req, res) => {
  const data = readData();
  const emptyRoster = {};
  Object.keys(data.users || {}).forEach(name => {
    if (name.toLowerCase() !== 'admin') {
      emptyRoster[name] = { t2: 'Off', t3: 'Off', t4: 'Off', t5: 'Off', t6: 'Off', t7: 'Off', cn: 'Off' };
    }
  });

  data.masterRoster = emptyRoster;
  data.carmel_master_roster = emptyRoster;
  data.registrations = {};
  data.all_staff_registrations = {};

  writeData(data);
  logActivity(data, req.body.actor || 'Quản lý', 'Xóa lịch tuần', 'Đã đặt lại toàn bộ lịch làm việc về Off');
  writeData(data);

  res.json({ success: true, emptyRoster });
});

// 7. Cập nhật kho
app.post('/api/inventory', (req, res) => {
  const { items, actor } = req.body;
  const data = readData();
  data.inventory = items;
  data.carmel_inventory = items;
  logActivity(data, actor, 'Cập nhật kho', 'Đã lưu lại tồn kho mới');
  writeData(data);
  res.json({ success: true });
});

// 8. Đăng ký ca
app.post('/api/shifts/register', (req, res) => {
  const { staffName, schedule } = req.body;
  const data = readData();
  data.registrations[staffName] = schedule;
  data.all_staff_registrations[staffName] = schedule;
  logActivity(data, staffName, 'Đăng ký ca làm', 'Nộp phiếu đăng ký tuần');
  writeData(data);
  res.json({ success: true });
});

// 9. Yêu cầu Pass / Đổi ca
app.post('/api/shifts/request', (req, res) => {
  const { newRequest } = req.body;
  const data = readData();
  data.shiftRequests.push(newRequest);
  data.carmel_shift_requests.push(newRequest);
  logActivity(data, newRequest.from, `Tạo yêu cầu ${newRequest.type}`, `Gửi cho ${newRequest.to}`);
  writeData(data);
  res.json({ success: true });
});

// 10. Duyệt ca
app.post('/api/shifts/handle-request', (req, res) => {
  const { reqId, status, actor, masterRoster } = req.body;
  const data = readData();
  const targetReq = data.shiftRequests.find(r => r.id === reqId);
  if (targetReq) {
    targetReq.status = status;
    const carmelTarget = data.carmel_shift_requests.find(r => r.id === reqId);
    if (carmelTarget) carmelTarget.status = status;
    if (masterRoster) {
      data.masterRoster = masterRoster;
      data.carmel_master_roster = masterRoster;
    }
    logActivity(data, actor, `${status === 'APPROVED' ? 'Phê duyệt' : 'Từ chối'} yêu cầu`, `Mã yêu cầu: #${reqId}`);
    writeData(data);
  }
  res.json({ success: true });
});

// 11. Doanh thu
app.post('/api/revenue', (req, res) => {
  const { date, record, actor } = req.body;
  const data = readData();
  data.revenue[date] = record;
  data.carmel_revenue_records[date] = record;
  logActivity(data, actor, 'Nhập doanh thu', `Ngày ${date}: ${record.total.toLocaleString('vi-VN')} đ`);
  writeData(data);
  res.json({ success: true });
});

// 12. Chi phí
app.post('/api/expenses', (req, res) => {
  const { item, actor } = req.body;
  const data = readData();
  data.expenses.push(item);
  data.carmel_expense_records.push(item);
  logActivity(data, actor, 'Thêm khoản chi', `${item.name} (${item.cost.toLocaleString('vi-VN')} đ)`);
  writeData(data);
  res.json({ success: true });
});

app.delete('/api/expenses/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const actor = req.query.actor || 'Quản lý';
  const data = readData();
  const deletedItem = data.expenses.find(i => i.id === id);
  data.expenses = data.expenses.filter(i => i.id !== id);
  data.carmel_expense_records = data.carmel_expense_records.filter(i => i.id !== id);
  logActivity(data, actor, 'Xóa khoản chi', deletedItem ? deletedItem.name : `ID: #${id}`);
  writeData(data);
  res.json({ success: true });
});

// 13. Xem logs
app.get('/api/logs', (req, res) => {
  res.json(readData().auditLogs);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Máy chủ Carmel Coffee đang chạy trên Port ${PORT}`);
  console.log(`👉 Truy cập từ máy tính: http://localhost:${PORT}/dashboard.html`);
  console.log(`👉 Truy cập từ điện thoại: http://192.168.0.111:${PORT}/dashboard.html`);
  console.log(`====================================================`);
});
const webpush = require('web-push');

// 1. Dán 2 chuỗi vừa tạo ở Bước 1 vào đây:
const publicVapidKey = 'BBKRszWMOyxzA7KsJ8WrkoHzkVBfLLvHjwXtD9GMoNYTSiHzQl5Hos-kZ80mqPDyp4ka234B64_fba4FZn1F2vs';
const privateVapidKey = 'tu7Bqd0tLOS2kwiBM3ZyzoqGQHJouI5Y7M9bMdRRDUI';

webpush.setVapidDetails(
  'mailto:carmelcoffee@gmail.com',
  publicVapidKey,
  privateVapidKey
);

// Mảng lưu danh sách các điện thoại đã đăng ký nhận thông báo
let pushSubscriptions = [];

// API nhận đăng ký từ điện thoại
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  if (subscription && !pushSubscriptions.some(s => s.endpoint === subscription.endpoint)) {
    pushSubscriptions.push(subscription);
  }
  res.status(201).json({ success: true });
});

// HÀM TIỆN ÍCH: Gọi hàm này ở bất cứ đâu để bắn thông báo về điện thoại
function sendPhoneNotification(title, message) {
  const payload = JSON.stringify({ title, body: message });

  pushSubscriptions.forEach(sub => {
    webpush.sendNotification(sub, payload).catch(err => {
      // Nếu token hết hạn thì xóa khỏi danh sách
      if (err.statusCode === 410 || err.statusCode === 404) {
        pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
      }
    });
  });
}

// VÍ DỤ TEST: API gửi thử 1 thông báo
app.post('/api/test-notify', (req, res) => {
  sendPhoneNotification('Carmel Coffee', '🔔 Thông báo thử nghiệm: Web đã kết nối điện thoại thành công!');
  res.json({ success: true });
});
