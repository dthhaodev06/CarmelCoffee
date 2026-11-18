const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ====================================================
// 1. KẾT NỐI CLOUD DATABASE (MONGODB ATLAS)
// ====================================================
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://huyhao0620_db_user:Sy42pPnptuaa0x07@cluster0.w5ubkha.mongodb.net/carmelcoffee';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Đã kết nối Cloud Database (MongoDB) thành công!'))
  .catch(err => console.error('❌ Lỗi kết nối MongoDB:', err));

const StoreSchema = new mongoose.Schema({
  key: { type: String, default: 'main_store' },
  payload: { type: Object, required: true }
});
const StoreModel = mongoose.model('Store', StoreSchema);

let memoryCache = null;

function ensureDataStructure(data) {
  if (!data.users) data.users = { "Admin": { role: "manager", pass: "123456" } };
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
  if (!data.pushSubscriptions) data.pushSubscriptions = [];
  return data;
}

async function initDatabase() {
  const defaultData = ensureDataStructure({
    users: {
      "Admin": { role: "manager", pass: "123456" }
    }
  });

  let doc = await StoreModel.findOne({ key: 'main_store' });
  if (!doc) {
    doc = await StoreModel.create({ key: 'main_store', payload: defaultData });
  }
  memoryCache = ensureDataStructure(doc.payload);
}

function readData() {
  return memoryCache || ensureDataStructure({});
}

function writeData(data) {
  if (Array.isArray(data.auditLogs) && data.auditLogs.length > 500) {
    data.auditLogs = data.auditLogs.slice(0, 500);
  }
  memoryCache = data;
  StoreModel.findOneAndUpdate(
    { key: 'main_store' },
    { payload: data },
    { upsert: true }
  ).catch(err => console.error('❌ Lỗi đồng bộ dữ liệu lên Cloud:', err));
}

function logActivity(data, actor, action, detail) {
  const logItem = {
    id: Date.now(),
    time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    actor: actor || 'Ẩn danh',
    action: action,
    detail: detail || ''
  };
  if (!Array.isArray(data.auditLogs)) data.auditLogs = [];
  data.auditLogs.unshift(logItem);
}

// ====================================================
// 2. CÁC API QUẢN LÝ DỮ LIỆU & NHÂN SỰ
// ====================================================

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

// 3. API Đăng nhập
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

// 4. API TẠO TÀI KHOẢN MỚI
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

// 5. API XÓA TÀI KHOẢN NHÂN VIÊN
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

  logActivity(data, req.body.actor || 'Quản lý', 'Xóa lịch tuần', 'Đã đặt lại toàn bộ lịch làm việc về Off');
  writeData(data);

  res.json({ success: true, emptyRoster });
});

// 7. Cập nhật kho & CẢNH BÁO QUẢN LÝ KHI NVL SẮP HẾT (TỒN KHO <= 3)
app.post('/api/inventory', (req, res) => {
  const { items, actor } = req.body;
  const data = readData();
  data.inventory = items;
  data.carmel_inventory = items;
  logActivity(data, actor, 'Cập nhật kho', 'Đã lưu lại tồn kho mới');
  writeData(data);

  // Kiểm tra nếu có món nào tồn kho <= 3 thì bắn thông báo đến Quản lý
  if (Array.isArray(items)) {
    const lowStockItems = items.filter(i => (Number(i.inQty) - Number(i.outQty)) <= 3);
    if (lowStockItems.length > 0) {
      const names = lowStockItems.map(i => `${i.name} (còn ${Math.max(0, i.inQty - i.outQty)} ${i.unit})`).join(', ');
      sendManagerNotification('Cảnh báo Kho NVL ⚠️', `Các món sau sắp hết: ${names}. Quản lý kiểm tra nhập thêm hàng!`);
    }
  }

  res.json({ success: true });
});

// 8. Đăng ký ca làm & THÔNG BÁO CHO QUẢN LÝ BIẾT
app.post('/api/shifts/register', (req, res) => {
  const { staffName, schedule } = req.body;
  const data = readData();
  data.registrations[staffName] = schedule;
  data.all_staff_registrations[staffName] = schedule;
  logActivity(data, staffName, 'Đăng ký ca làm', 'Nộp phiếu đăng ký tuần');
  writeData(data);

  // Bắn thông báo về điện thoại Quản lý
  sendManagerNotification('Đăng ký Ca Làm 📋', `Nhân viên [${staffName}] vừa nộp phiếu đăng ký lịch làm tuần mới!`);

  res.json({ success: true });
});

// 9. Yêu cầu Pass / Đổi ca & THÔNG BÁO CHO QUẢN LÝ XÉT DUYỆT
app.post('/api/shifts/request', (req, res) => {
  const { newRequest } = req.body;
  const data = readData();
  data.shiftRequests.push(newRequest);
  data.carmel_shift_requests.push(newRequest);
  logActivity(data, newRequest.from, `Tạo yêu cầu ${newRequest.type}`, `Gửi cho ${newRequest.to}`);
  writeData(data);

  // Bắn thông báo về điện thoại Quản lý
  const actionText = newRequest.type === 'PASS' ? 'xin Pass ca' : 'xin Đổi ca';
  sendManagerNotification('Yêu Cầu Ca Làm 🔄', `Nhân viên [${newRequest.from}] vừa gửi đơn ${actionText} cho [${newRequest.to}]. Quản lý vui lòng xét duyệt!`);

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

// ====================================================
// ====================================================
// 3. THÔNG BÁO ĐẨY (CHỈ GỬI CHO THIẾT BỊ QUẢN LÝ)
// ====================================================
const publicVapidKey = 'BMVrq03lPj1UYEJVVQ20pvFDTARfl_AbUpQJFoeEkmkQMzF6KTuKu0Zo28PmwLbaCRw5rv__ineMDq2bXJrjk_g';
const privateVapidKey = 'iOH9tXmt6ysad8u_UAcNtSptnzuEIhGnxMrqZVJnRCI';

webpush.setVapidDetails(
  'mailto:carmelcoffee@gmail.com',
  publicVapidKey,
  privateVapidKey
);

// HÀM TIỆN ÍCH: CHỈ BẮN THÔNG BÁO ĐẾN ĐIỆN THOẠI QUẢN LÝ
function sendManagerNotification(title, message) {
  const payload = JSON.stringify({ title, body: message });
  const data = readData();
  const subs = data.pushSubscriptions || [];
  let changed = false;

  const managerSubs = subs.filter(s => s.role === 'manager' || !s.role);

  managerSubs.forEach(subObj => {
    const subTarget = subObj.subscription ? subObj.subscription : subObj;
    webpush.sendNotification(subTarget, payload)
      .then(() => {
        console.log('✅ Đã gửi thông báo đẩy thành công tới:', subTarget.endpoint.slice(0, 45) + '...');
      })
      .catch(err => {
        console.error('❌ Lỗi gửi Push:', err.statusCode, err.body || err.message);
        // Xóa tự động nếu token hết hạn (410/404) hoặc sai khóa VAPID cũ (401/403)
        if ([401, 403, 404, 410].includes(err.statusCode)) {
          data.pushSubscriptions = data.pushSubscriptions.filter(s => {
            const ep = s.subscription ? s.subscription.endpoint : s.endpoint;
            return ep !== subTarget.endpoint;
          });
          changed = true;
        }
      });
  });

  if (changed) writeData(data);
}

// API nhận đăng ký từ điện thoại Quản lý (Luôn cập nhật đè mã mới nhất)
app.post('/api/subscribe', (req, res) => {
  const { subscription, role, actor } = req.body;
  const data = readData();
  if (!Array.isArray(data.pushSubscriptions)) data.pushSubscriptions = [];

  const subData = subscription || req.body;
  const endpoint = subData.endpoint;

  if (endpoint) {
    // Xóa bản ghi cũ của cùng thiết bị này (nếu có) để cập nhật khóa mới nhất
    data.pushSubscriptions = data.pushSubscriptions.filter(s => {
      const ep = s.subscription ? s.subscription.endpoint : s.endpoint;
      return ep !== endpoint;
    });

    data.pushSubscriptions.push({
      subscription: subData,
      role: role || 'manager',
      actor: actor || 'Quản lý'
    });
    writeData(data);
  }

  // Bắn ngay 1 thông báo thử nghiệm về điện thoại Quản lý sau 1 giây
  setTimeout(() => {
    const payload = JSON.stringify({
      title: 'Carmel Coffee ☕',
      body: '🎉 Chúc mừng Quản lý! Điện thoại đã kích hoạt nhận thông báo điều hành thành công!'
    });
    webpush.sendNotification(subData, payload)
      .then(() => console.log('✅ Đã gửi thông báo chào mừng tới iPhone!'))
      .catch(e => console.error('❌ Lỗi test push:', e.statusCode, e.body || e.message));
  }, 1000);

  res.status(201).json({ success: true });
});

// API gửi thử thông báo
app.post('/api/test-notify', (req, res) => {
  sendManagerNotification('Carmel Coffee ☕', '🔔 Thông báo thử nghiệm: Web đã kết nối điện thoại Quản lý thành công!');
  res.json({ success: true });
});// ====================================================
// 4. KHỞI CHẠY SERVER SAU KHI TẢI XONG DỮ LIỆU CLOUD
// ====================================================
initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`====================================================`);
      console.log(`🚀 Máy chủ Carmel Coffee đang chạy trên Port ${PORT}`);
      console.log(`👉 Truy cập từ máy tính: http://localhost:${PORT}/dashboard.html`);
      console.log(`====================================================`);
    });
  })
  .catch(err => {
    console.error('❌ Không thể khởi động server do lỗi kết nối database:', err);
  });