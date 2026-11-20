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

app.get('/api/data', (req, res) => {
  res.json(readData());
});

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

// 7. Cập nhật kho -> Bắn thông báo NVL (khi bấm mở thẳng tab-nvl)
app.post('/api/inventory', (req, res) => {
  const { items, actor } = req.body;
  const data = readData();
  data.inventory = items;
  data.carmel_inventory = items;
  logActivity(data, actor, 'Cập nhật kho', 'Đã lưu lại tồn kho mới');
  writeData(data);

  if (Array.isArray(items)) {
    const lowStockItems = items.filter(i => (Number(i.inQty) - Number(i.outQty)) <= 3);
    if (lowStockItems.length > 0) {
      const names = lowStockItems.map(i => `${i.name} (còn ${Math.max(0, i.inQty - i.outQty)} ${i.unit})`).join(', ');
      sendPushToTargets(
        s => s.role === 'manager',
        'Cảnh báo Kho NVL',
        `${names}.`,
        '/dashboard.html?tab=tab-nvl'
      );
    }
  }

  res.json({ success: true });
});

// 8. Đăng ký ca làm -> Báo Quản lý (khi bấm mở thẳng tab-shift)
app.post('/api/shifts/register', (req, res) => {
  const { staffName, schedule } = req.body;
  const data = readData();
  data.registrations[staffName] = schedule;
  data.all_staff_registrations[staffName] = schedule;
  logActivity(data, staffName, 'Đăng ký ca làm', 'Nộp phiếu đăng ký tuần');
  writeData(data);

  sendPushToTargets(
    s => s.role === 'manager',
    'Đăng ký Ca Làm',
    `Nhân viên ${staffName} vừa nộp phiếu đăng ký lịch làm tuần mới!`,
    '/dashboard.html?tab=tab-shift'
  );

  res.json({ success: true });
});

// 9. Yêu cầu Pass / Đổi ca -> Báo Quản lý (khi bấm mở thẳng tab-request)
app.post('/api/shifts/request', (req, res) => {
  const { newRequest } = req.body;
  const data = readData();
  data.shiftRequests.push(newRequest);
  data.carmel_shift_requests.push(newRequest);
  logActivity(data, newRequest.from, `Tạo yêu cầu ${newRequest.type}`, `Gửi cho ${newRequest.to}`);
  writeData(data);

  const actionText = newRequest.type === 'PASS' ? 'xin Pass ca' : 'xin Đổi ca';
  sendPushToTargets(
    s => s.role === 'manager',
    'Yêu Cầu Ca Làm',
    `Nhân viên ${newRequest.from} vừa gửi đơn ${actionText} cho ${newRequest.to}. Quản lý vui lòng xét duyệt!`,
newRequest.type === 'SWAP' ? '/dashboard.html?tab=tab-swap-shift' : '/dashboard.html?tab=tab-pass-shift'  );

  res.json({ success: true });
});

// 10. Duyệt / Từ chối Pass hoặc Đổi ca -> GỬI THÔNG BÁO VỀ MÁY NHÂN VIÊN LIÊN QUAN
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

    // Gửi thông báo về đúng tài khoản nhân viên gửi yêu cầu và nhân viên nhận ca
    const typeText = targetReq.type === 'PASS' ? 'Pass ca' : 'Đổi ca';
    const statusText = status === 'APPROVED' ? 'ĐÃ CHẤP NHẬN ✅' : 'ĐÃ TỪ CHỐI ❌';
    const relatedNames = [targetReq.from, targetReq.to].filter(Boolean).map(n => n.toLowerCase());

    sendPushToTargets(
      s => s.role === 'employee' && relatedNames.includes((s.actor || '').toLowerCase()),
      `Kết quả ${typeText}`,
      `Quản lý ${statusText} yêu cầu ${typeText} giữa ${targetReq.from} và ${targetReq.to}.`,
targetReq.type === 'SWAP' ? '/dashboard.html?tab=tab-swap-shift' : '/dashboard.html?tab=tab-pass-shift'    );
  }
  res.json({ success: true });
});

// 10B. API BÁO CHO TOÀN BỘ NHÂN VIÊN KHI QUẢN LÝ ĐÃ XẾP XONG BẢNG LỊCH LÀM
app.post('/api/shifts/publish-roster', (req, res) => {
  const { actor, weekLabel } = req.body;
  const data = readData();
  logActivity(data, actor || 'Quản lý', 'Công bố lịch làm', `Đã hoàn tất xếp lịch (${weekLabel || 'tuần mới'})`);
  writeData(data);

  sendPushToTargets(
    s => s.role === 'employee',
    'Lịch Làm Việc Mới 📅',
    `Quản lý đã xếp xong bảng lịch làm ${weekLabel || 'tuần mới'}. Vào xem ca của bạn ngay!`,
    '/dashboard.html?tab=tab-schedule'
  );

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

app.get('/api/logs', (req, res) => {
  res.json(readData().auditLogs);
});

// ====================================================
// 3. HỆ THỐNG THÔNG BÁO ĐẨY 2 CHIỀU & DEEP-LINK TAB
// ====================================================
const publicVapidKey = 'BMVrq03lPj1UYEJVVQ20pvFDTARfl_AbUpQJFoeEkmkQMzF6KTuKu0Zo28PmwLbaCRw5rv__ineMDq2bXJrjk_g';
const privateVapidKey = 'iOH9tXmt6ysad8u_UAcNtSptnzuEIhGnxMrqZVJnRCI';

webpush.setVapidDetails(
  'mailto:carmelcoffee@gmail.com',
  publicVapidKey,
  privateVapidKey
);

// HÀM GỬI THÔNG BÁO ĐẾN ĐÚNG NHÓM ĐỐI TƯỢNG VÀ KÈM URL TAB ĐÍCH
function sendPushToTargets(filterFn, title, message, targetUrl = '/dashboard.html') {
  const payload = JSON.stringify({ title, body: message, url: targetUrl });
  const data = readData();
  const subs = data.pushSubscriptions || [];
  let changed = false;

  const matchedSubs = subs.filter(filterFn);

  matchedSubs.forEach(subObj => {
    const subTarget = subObj.subscription ? subObj.subscription : subObj;
    webpush.sendNotification(subTarget, payload)
      .then(() => {
        console.log(`✅ Đã gửi Push [${title}] tới ${subObj.actor} (${subObj.role})`);
      })
      .catch(err => {
        console.error('❌ Lỗi gửi Push:', err.statusCode, err.body || err.message);
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

// API nhận đăng ký thiết bị (Lưu cả Quản lý và Nhân viên kèm tên tài khoản)
app.post('/api/subscribe', (req, res) => {
  const { subscription, role, actor } = req.body;
  const data = readData();
  if (!Array.isArray(data.pushSubscriptions)) data.pushSubscriptions = [];

  const subData = subscription || req.body;
  const endpoint = subData.endpoint;

  if (endpoint && role && actor) {
    // Xóa bản ghi cũ của cùng thiết bị này để cập nhật đúng người đang đăng nhập
    data.pushSubscriptions = data.pushSubscriptions.filter(s => {
      const ep = s.subscription ? s.subscription.endpoint : s.endpoint;
      return ep !== endpoint;
    });

    data.pushSubscriptions.push({
      subscription: subData,
      role: role,
      actor: actor
    });
    writeData(data);
    console.log(`📲 Đã gắn thiết bị cho ${actor} (${role})`);
  }

  res.status(201).json({ success: true });
});

// API hủy đăng ký Push khi bấm Đăng xuất
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  const data = readData();

  if (endpoint && Array.isArray(data.pushSubscriptions)) {
    data.pushSubscriptions = data.pushSubscriptions.filter(s => {
      const ep = s.subscription ? s.subscription.endpoint : s.endpoint;
      return ep !== endpoint;
    });
    writeData(data);
    console.log('🔕 Đã gỡ thiết bị khỏi danh sách nhận thông báo');
  }

  res.json({ success: true });
});

app.post('/api/test-notify', (req, res) => {
  sendPushToTargets(
    s => s.role === 'manager',
    'Carmel Coffee ☕',
    '🔔 Thông báo thử nghiệm: Kết nối thành công!',
    '/dashboard.html?tab=tab-schedule'
  );
  res.json({ success: true });
});
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});
// ====================================================
// 4. KHỞI CHẠY SERVER
// ====================================================
initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`====================================================`);
      console.log(`🚀 Máy chủ Carmel Coffee đang chạy trên Port ${PORT}`);
      console.log(`====================================================`);
    });
  })
  .catch(err => {
    console.error('❌ Không thể khởi động server:', err);
  });