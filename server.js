require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const webpush = require('web-push');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ====================================================
// 1. KẾT NỐI CLOUD DATABASE (MONGODB ATLAS)
// ====================================================
const rawMongoUri = process.env.MONGO_URI;
const MONGO_URI = rawMongoUri
  ? rawMongoUri.trim()
      .replace(/^['"]|['"]$/g, '')
      .replace(/^\[|\]$/g, '')
      .trim()
  : '';

if (!MONGO_URI) {
  console.error('Thiếu biến môi trường MONGO_URI');
  process.exit(1);
}

if (!/^mongodb(?:\+srv)?:\/\//.test(MONGO_URI)) {
  console.error('MONGO_URI không hợp lệ: chuỗi phải bắt đầu bằng mongodb:// hoặc mongodb+srv://');
  process.exit(1);
}

const StoreSchema = new mongoose.Schema({
  key: { type: String, default: 'main_store' },
  payload: { type: Object, required: true }
});
const StoreModel = mongoose.model('Store', StoreSchema);

let memoryCache = null;
const activeSessions = new Map();

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.set(token, {
    name: user.name,
    role: user.role,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000
  });
  return token;
}

function getSession(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const session = token ? activeSessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) activeSessions.delete(token);
    return null;
  }
  return session;
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ success: false, message: 'Phiên đăng nhập đã hết hạn!' });
  req.auth = session;
  next();
}

function requireManager(req, res, next) {
  if (!req.auth || req.auth.role !== 'manager') {
    return res.status(403).json({ success: false, message: 'Chỉ Quản lý mới có quyền thực hiện!' });
  }
  next();
}

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
  if (!data.carmel_registrations_by_week) data.carmel_registrations_by_week = {};
  if (!data.carmel_rosters_by_week) data.carmel_rosters_by_week = {};
  if (!data.carmel_full_users) data.carmel_full_users = data.users;
  if (!data.carmel_staff_rates) data.carmel_staff_rates = {};
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

app.get('/api/data', requireAuth, (req, res) => {
  const data = JSON.parse(JSON.stringify(readData()));
  if (req.auth.role !== 'manager') {
    if (data.users) {
      Object.keys(data.users).forEach(name => {
        if (data.users[name]) data.users[name].pass = '';
      });
    }
    if (data.carmel_full_users) {
      Object.keys(data.carmel_full_users).forEach(name => {
        if (data.carmel_full_users[name]) data.carmel_full_users[name].pass = '';
      });
    }
  }
  res.json(data);
});

app.post('/api/save-data', requireAuth, (req, res) => {
  const incomingData = req.body;
  const data = readData();
  const managerOnlyKeys = ['users', 'carmel_full_users', 'carmel_staff_rates', 'masterRoster', 'carmel_master_roster', 'carmel_rosters_by_week', 'revenue', 'carmel_revenue_records', 'expenses', 'carmel_expense_records'];
  if (req.auth.role !== 'manager') {
    const attemptedManagerWrite = managerOnlyKeys.some(key => Object.prototype.hasOwnProperty.call(incomingData, key));
    if (attemptedManagerWrite) return res.status(403).json({ success: false, message: 'Chỉ Quản lý mới được cập nhật dữ liệu này!' });
  }
  Object.assign(data, incomingData);

  if (incomingData.carmel_master_roster) data.masterRoster = incomingData.carmel_master_roster;
  if (incomingData.all_staff_registrations) data.registrations = incomingData.all_staff_registrations;
  if (incomingData.carmel_shift_requests) data.shiftRequests = incomingData.carmel_shift_requests;
  if (incomingData.carmel_inventory) data.inventory = incomingData.carmel_inventory;
  if (incomingData.carmel_revenue_records) data.revenue = incomingData.carmel_revenue_records;
  if (incomingData.carmel_expense_records) data.expenses = incomingData.carmel_expense_records;
  if (incomingData.carmel_full_users) {
    data.carmel_full_users = incomingData.carmel_full_users;
    Object.keys(incomingData.carmel_full_users).forEach(name => {
      if (data.users[name]) {
        data.users[name].role = incomingData.carmel_full_users[name].role;
        data.users[name].pass = incomingData.carmel_full_users[name].pass;
        data.users[name].hourlyRate = incomingData.carmel_full_users[name].hourlyRate;
      }
    });
  }
  if (incomingData.carmel_staff_rates) data.carmel_staff_rates = incomingData.carmel_staff_rates;
  if (incomingData.carmel_registrations_by_week) data.carmel_registrations_by_week = incomingData.carmel_registrations_by_week;
  if (incomingData.carmel_rosters_by_week) data.carmel_rosters_by_week = incomingData.carmel_rosters_by_week;

  if (incomingData.carmel_revenue_records) {
    logActivity(data, req.auth.name, 'Cập nhật doanh thu', `Đã đồng bộ dữ liệu doanh thu (${Object.keys(incomingData.carmel_revenue_records).length} ngày)`);
  }
  if (incomingData.carmel_expense_records) {
    logActivity(data, req.auth.name, 'Cập nhật chi phí', `Đã đồng bộ ${incomingData.carmel_expense_records.length} khoản chi`);
  }
  if (incomingData.carmel_full_users || incomingData.carmel_staff_rates) {
    logActivity(data, req.auth.name, 'Cập nhật tài khoản/lương', 'Đã lưu mức lương hoặc thông tin tài khoản');
  }
  if (incomingData.carmel_rosters_by_week || incomingData.carmel_master_roster) {
    logActivity(data, req.auth.name, 'Cập nhật lịch làm', 'Đã lưu thay đổi bảng lịch làm');
  }

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

  const user = { name, role: data.users[name].role };
  res.json({ success: true, user, token: createSession(user) });
});

app.post('/api/users/create', requireAuth, requireManager, (req, res) => {
  const { name, pass, role, hourlyRate, actor } = req.body;
  const data = readData();

  if (!name || !pass) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ tên và mật khẩu!' });
  }

  const staffName = name.trim();
  if (data.users[staffName]) {
    return res.status(400).json({ success: false, message: 'Tài khoản này đã tồn tại trên hệ thống!' });
  }

  const userRole = role || 'employee';
  const rate = Number.isFinite(Number(hourlyRate)) ? Math.max(0, Number(hourlyRate)) : 25000;
  data.users[staffName] = { role: userRole, pass: pass.trim(), hourlyRate: rate };
  data.carmel_full_users = data.users;
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

app.delete('/api/users/:name', requireAuth, requireManager, (req, res) => {
  const staffName = req.params.name;
  const actor = req.query.actor || 'Admin';
  const data = readData();

  if (staffName.toLowerCase() === 'admin') {
    return res.status(400).json({ success: false, message: 'Không thể xóa tài khoản Admin máy chủ!' });
  }

  if (data.users[staffName]) {
    delete data.users[staffName];
    delete data.carmel_full_users[staffName];
    delete data.carmel_staff_rates[staffName];
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

app.post('/api/shifts/clear-roster', requireAuth, requireManager, (req, res) => {
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
app.post('/api/inventory', requireAuth, async (req, res) => {
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
      await sendPushToTargets(
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
app.post('/api/shifts/register', requireAuth, async (req, res) => {
  const { staffName, schedule, weekKey } = req.body;
  if (staffName !== req.auth.name) return res.status(403).json({ success: false, message: 'Không thể đăng ký thay nhân viên khác!' });
  const data = readData();
  data.registrations[staffName] = schedule;
  data.all_staff_registrations[staffName] = schedule;
  if (weekKey) {
    if (!data.carmel_registrations_by_week[weekKey]) data.carmel_registrations_by_week[weekKey] = {};
    data.carmel_registrations_by_week[weekKey][staffName] = schedule;
  }
  logActivity(data, staffName, 'Đăng ký ca làm', 'Nộp phiếu đăng ký tuần');
  writeData(data);

  await sendPushToTargets(
    s => s.role === 'manager',
    'Đăng ký Ca Làm',
    `Nhân viên ${staffName} vừa nộp phiếu đăng ký lịch làm tuần mới!`,
    '/dashboard.html?tab=tab-shift'
  );

  res.json({ success: true });
});

// 9. Yêu cầu Pass / Đổi ca -> Báo Quản lý (khi bấm mở thẳng tab-request)
app.post('/api/shifts/request', requireAuth, async (req, res) => {
  const { newRequest } = req.body;
  if (!newRequest || newRequest.from !== req.auth.name) {
    return res.status(403).json({ success: false, message: 'Không thể tạo yêu cầu thay nhân viên khác!' });
  }
  const data = readData();
  data.shiftRequests.push(newRequest);
  data.carmel_shift_requests.push(newRequest);
  logActivity(data, newRequest.from, `Tạo yêu cầu ${newRequest.type}`, `Gửi cho ${newRequest.to}`);
  writeData(data);

  const actionText = newRequest.type === 'PASS' ? 'xin Pass ca' : 'xin Đổi ca';
  await sendPushToTargets(
    s => s.role === 'manager',
    'Yêu Cầu Ca Làm',
    `Nhân viên ${newRequest.from} vừa gửi đơn ${actionText} cho ${newRequest.to}. Quản lý vui lòng xét duyệt!`,
newRequest.type === 'SWAP' ? '/dashboard.html?tab=tab-swap-shift' : '/dashboard.html?tab=tab-pass-shift'  );

  res.json({ success: true });
});

// 10. Duyệt / Từ chối Pass hoặc Đổi ca -> GỬI THÔNG BÁO VỀ MÁY NHÂN VIÊN LIÊN QUAN
function getCurrentWeekKey() {
  const now = new Date();
  const currentDay = now.getDay();
  const diff = (currentDay === 0 ? -6 : 1) - currentDay;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

app.post('/api/shifts/handle-request', requireAuth, requireManager, async (req, res) => {
  const { reqId, status, actor, masterRoster, weekKey } = req.body;
  const data = readData();
  const targetReq = data.shiftRequests.find(r => r.id === reqId);

  if (targetReq) {
    if (targetReq.status !== 'PENDING') {
      return res.status(409).json({ success: false, message: 'Yêu cầu đã được xử lý!' });
    }
    const requestWeekKey = targetReq.weekKey || weekKey || getCurrentWeekKey();
    targetReq.status = status;
    const carmelTarget = data.carmel_shift_requests.find(r => r.id === reqId);
    if (carmelTarget) carmelTarget.status = status;
    if (status === 'APPROVED' && masterRoster) {
      if (!data.carmel_rosters_by_week) data.carmel_rosters_by_week = {};
      data.carmel_rosters_by_week[requestWeekKey] = masterRoster;
      if (requestWeekKey === getCurrentWeekKey()) {
        data.masterRoster = masterRoster;
        data.carmel_master_roster = masterRoster;
      }
    }
    logActivity(data, actor, `${status === 'APPROVED' ? 'Phê duyệt' : 'Từ chối'} yêu cầu`, `Mã yêu cầu: #${reqId}`);
    writeData(data);

    // Gửi thông báo về đúng tài khoản nhân viên gửi yêu cầu và nhân viên nhận ca
    const typeText = targetReq.type === 'PASS' ? 'Pass ca' : 'Đổi ca';
    const statusText = status === 'APPROVED' ? 'ĐÃ CHẤP NHẬN ✅' : 'ĐÃ TỪ CHỐI ❌';
    const relatedNames = [targetReq.from, targetReq.to].filter(Boolean).map(n => n.toLowerCase());

    await sendPushToTargets(
      s => s.role === 'employee' && relatedNames.includes((s.actor || '').toLowerCase()),
      `Kết quả ${typeText}`,
      `Quản lý ${statusText} yêu cầu ${typeText} giữa ${targetReq.from} và ${targetReq.to}.`,
targetReq.type === 'SWAP' ? '/dashboard.html?tab=tab-swap-shift' : '/dashboard.html?tab=tab-pass-shift'    );
  }
  res.json({ success: true });
});

// 10B. API BÁO CHO TOÀN BỘ NHÂN VIÊN KHI QUẢN LÝ ĐÃ XẾP XONG BẢNG LỊCH LÀM
app.post('/api/shifts/publish-roster', requireAuth, requireManager, async (req, res) => {
  const { actor, weekLabel } = req.body;
  const data = readData();
  logActivity(data, actor || 'Quản lý', 'Công bố lịch làm', `Đã hoàn tất xếp lịch (${weekLabel || 'tuần mới'})`);
  writeData(data);

  await sendPushToTargets(
    s => s.role === 'employee',
    'Lịch Làm Việc Mới 📅',
    `Quản lý đã xếp xong bảng lịch làm ${weekLabel || 'tuần mới'}. Vào xem ca của bạn ngay!`,
    '/dashboard.html?tab=tab-schedule'
  );

  res.json({ success: true });
});

// 11. Doanh thu
app.post('/api/revenue', requireAuth, requireManager, (req, res) => {
  const { date, record, actor } = req.body;
  const data = readData();
  data.revenue[date] = record;
  data.carmel_revenue_records[date] = record;
  logActivity(data, actor, 'Nhập doanh thu', `Ngày ${date}: ${record.total.toLocaleString('vi-VN')} đ`);
  writeData(data);
  res.json({ success: true });
});

// 12. Chi phí
app.delete('/api/revenue/:date', requireAuth, requireManager, (req, res) => {
  const date = req.params.date;
  const actor = req.auth.name;
  const data = readData();
  if (!data.revenue[date] && !data.carmel_revenue_records[date]) {
    return res.status(404).json({ success: false, message: 'Không tìm thấy dữ liệu doanh thu!' });
  }
  delete data.revenue[date];
  delete data.carmel_revenue_records[date];
  logActivity(data, actor, 'Xóa doanh thu', `Ngày ${date}`);
  writeData(data);
  res.json({ success: true });
});

app.post('/api/expenses', requireAuth, requireManager, (req, res) => {
  const { item, actor } = req.body;
  const data = readData();
  data.expenses.push(item);
  data.carmel_expense_records.push(item);
  logActivity(data, actor, 'Thêm khoản chi', `${item.name} (${item.cost.toLocaleString('vi-VN')} đ)`);
  writeData(data);
  res.json({ success: true });
});

app.delete('/api/expenses/:id', requireAuth, requireManager, (req, res) => {
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

app.get('/api/logs', requireAuth, requireManager, (req, res) => {
  res.json(readData().auditLogs);
});

// ====================================================
// 3. HỆ THỐNG THÔNG BÁO ĐẨY 2 CHIỀU & DEEP-LINK TAB
// ====================================================
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
if (!publicVapidKey || !privateVapidKey) {
  console.error('❌ Thiếu biến môi trường VAPID_PUBLIC_KEY hoặc VAPID_PRIVATE_KEY');
  process.exit(1);
}

webpush.setVapidDetails(
  'mailto:carmelcoffee@gmail.com',
  publicVapidKey,
  privateVapidKey
);

// HÀM GỬI THÔNG BÁO ĐẾN ĐÚNG NHÓM ĐỐI TƯỢNG VÀ KÈM URL TAB ĐÍCH
async function sendPushToTargets(filterFn, title, message, targetUrl = '/dashboard.html') {
  const payload = JSON.stringify({ title, body: message, url: targetUrl });
  const data = readData();
  const subs = Array.isArray(data.pushSubscriptions) ? data.pushSubscriptions : [];
  const matchedSubs = subs.filter(filterFn);

  const results = await Promise.allSettled(matchedSubs.map(async subObj => {
    const subTarget = subObj.subscription ? subObj.subscription : subObj;
    await webpush.sendNotification(subTarget, payload);
    console.log(`✅ Đã gửi Push [${title}] tới ${subObj.actor} (${subObj.role})`);
  }));

  const invalidEndpoints = new Set();
  let successCount = 0;
  let failureCount = 0;

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successCount++;
      return;
    }

    failureCount++;
    const err = result.reason || {};
    const subObj = matchedSubs[index];
    const subTarget = subObj.subscription ? subObj.subscription : subObj;
    console.error('❌ Lỗi gửi Push:', err.statusCode, err.body || err.message);

    if ([403, 404, 410].includes(err.statusCode)) {
      invalidEndpoints.add(subTarget.endpoint);
    }
  });

  if (invalidEndpoints.size > 0) {
    data.pushSubscriptions = subs.filter(subObj => {
      const subTarget = subObj.subscription ? subObj.subscription : subObj;
      return !invalidEndpoints.has(subTarget.endpoint);
    });
    writeData(data);
  }

  return { matched: matchedSubs.length, success: successCount, failed: failureCount };
}

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// API nhận đăng ký thiết bị (Lưu cả Quản lý và Nhân viên kèm tên tài khoản)
app.post('/api/subscribe', requireAuth, (req, res) => {
  const { subscription } = req.body;
  const role = req.auth.role;
  const actor = req.auth.name;
  const data = readData();
  if (!Array.isArray(data.pushSubscriptions)) data.pushSubscriptions = [];

  const subData = subscription || req.body;
  const endpoint = subData.endpoint;

  if (!endpoint || !subData.keys) {
    return res.status(400).json({ success: false, message: 'Subscription Push không hợp lệ!' });
  }

  if (endpoint && role && actor) {
    // Giữ một subscription mới nhất cho mỗi endpoint và không lưu trùng cùng người/thiết bị.
    data.pushSubscriptions = data.pushSubscriptions.filter(s => {
      const oldSub = s.subscription ? s.subscription : s;
      const sameEndpoint = oldSub.endpoint === endpoint;
      const sameUserAndDevice = s.actor === actor && oldSub.endpoint === endpoint;
      return !sameEndpoint && !sameUserAndDevice;
    });

    data.pushSubscriptions.push({
      subscription: subData,
      role: role,
      actor: actor,
      subscribedAt: Date.now()
    });
    writeData(data);
    console.log(`📲 Đã gắn thiết bị cho ${actor} (${role})`);
  }

  res.status(201).json({ success: true });
});

// API hủy đăng ký Push khi bấm Đăng xuất
app.post('/api/unsubscribe', requireAuth, (req, res) => {
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

app.post('/api/test-notify', requireAuth, requireManager, async (req, res) => {
  const result = await sendPushToTargets(
    s => s.role === 'manager',
    'Carmel Coffee ☕',
    '🔔 Thông báo thử nghiệm: Kết nối thành công!',
    '/dashboard.html?tab=tab-schedule'
  );
  res.json({ success: true, push: result });
});
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});
// ====================================================
// 4. KHỞI CHẠY SERVER
// ====================================================
async function startServer() {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ Đã kết nối Cloud Database (MongoDB) thành công!');

    await initDatabase();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`====================================================`);
      console.log(`🚀 Máy chủ Carmel Coffee đang chạy trên Port ${PORT}`);
      console.log(`====================================================`);
    });
  } catch (err) {
    console.error('❌ Không thể kết nối MongoDB:', err.message || err);
    process.exit(1);
  }
}

startServer();