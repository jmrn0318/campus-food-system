const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const STAFF_INVITE_CODE = process.env.STAFF_INVITE_CODE || '2006';

// Data directory path. On a host with a persistent volume, set DATA_DIR to its mount path (e.g. /data).
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
// Uploaded food photos live inside DATA_DIR when it is set, so they survive redeploys too.
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : process.env.DATA_DIR
    ? path.join(DATA_DIR, 'uploads')
    : path.join(__dirname, 'public', 'uploads');
const MENU_FILE = path.join(DATA_DIR, 'menu.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SUGGESTIONS_FILE = path.join(DATA_DIR, 'suggestions.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const sessions = new Map();

// Fresh deploys start with no data folder and no menu.json (both are git-ignored), so create them here.
const SEED_CANDIDATES = [
  path.join(__dirname, 'data', 'menu.seed.json'),
  path.join(__dirname, 'data', 'menu_seed.json'),
  path.join(__dirname, 'menu.seed.json'),
  path.join(__dirname, 'menu_seed.json')
];
const ensureDataFiles = () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  [ORDERS_FILE, SUGGESTIONS_FILE, USERS_FILE, NOTIFICATIONS_FILE].forEach((file) => {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
  });
  if (!fs.existsSync(MENU_FILE)) {
    const seed = SEED_CANDIDATES.find((file) => fs.existsSync(file));
    if (seed) {
      fs.copyFileSync(seed, MENU_FILE);
      console.log(`[info] Menu created from ${seed}`);
    } else {
      fs.writeFileSync(MENU_FILE, '[]');
      console.warn('[warn] No menu seed file found, so the menu starts empty.');
    }
  }
};
ensureDataFiles();

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// 1. DITO ANG ARAW NG SOLUSYON: I-serve ang 'public' folder
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// Storage setup para sa Image Uploads ng Staff
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]+/g, '_')}`);
  }
});
const upload = multer({ storage });

// Helper functions sa pagbabasa at pagsusulat ng JSON
const readData = (filePath) => {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const writeData = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
};

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt,
  passwordHash: crypto.scryptSync(password, salt, 64).toString('hex')
});

const passwordMatches = (password, user) => {
  const hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
};

const tokenFor = (user) => {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { id: user.id, role: user.role });
  return token;
};

const currentUser = (req) => sessions.get(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
const requireSignedIn = (req, res, next) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  req.user = user;
  next();
};
const requireCustomerOrStaff = (req, res, next) => {
  const user = currentUser(req);
  if (user) {
    req.user = user;
    return next();
  }
  if (req.headers['x-staff-pin'] === STAFF_PIN) {
    req.user = { role: 'staff' };
    return next();
  }
  return res.status(401).json({ error: 'Sign in required' });
};
const requireCustomer = (req, res, next) => {
  const user = currentUser(req);
  if (!user || user.role !== 'customer') return res.status(401).json({ error: 'Customer sign-in required' });
  req.user = user;
  next();
};
const requireStaff = (req, res, next) => {
  const user = currentUser(req);
  if (user?.role === 'staff' || req.headers['x-staff-pin'] === STAFF_PIN) {
    req.user = user || { role: 'staff' };
    return next();
  }
  return res.status(401).json({ error: 'Staff authorization required' });
};

const requireStaffMenuAccess = (req, res, next) => {
  const user = currentUser(req);
  if (user?.role === 'staff' || req.headers['x-staff-pin'] === STAFF_PIN) {
    req.user = user || { role: 'staff' };
    return next();
  }
  return res.status(401).json({ error: 'Staff authorization required' });
};

const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, role: user.role });

const registerUser = (name, email, password, role) => {
  const users = readData(USERS_FILE);
  const normalizedEmail = String(email || '').toLowerCase().trim();
  if (!name || !normalizedEmail || !password || String(password).length < 6) return { error: 'Name, email, and a password of at least 6 characters are required.' };
  if (users.some((user) => user.email === normalizedEmail)) return { error: 'An account with that email already exists.', status: 409 };
  const credentials = hashPassword(String(password));
  const user = { id: `${role}-${Date.now()}`, name: String(name).trim(), email: normalizedEmail, role, ...credentials, createdAt: new Date().toISOString() };
  users.push(user);
  writeData(USERS_FILE, users);
  return { user, token: tokenFor(user) };
};

const loginUser = (email, password, role) => {
  const user = readData(USERS_FILE).find((entry) => entry.email === String(email || '').toLowerCase().trim() && entry.role === role);
  if (!user || !passwordMatches(String(password || ''), user)) return null;
  return { user, token: tokenFor(user) };
};

app.post('/api/auth/staff/register', (req, res) => {
  if (String(req.body.inviteCode || '').trim() !== STAFF_INVITE_CODE) return res.status(403).json({ error: 'Valid staff verification code required.' });
  const result = registerUser(req.body.name, req.body.email, req.body.password, 'staff');
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.status(201).json({ token: result.token, user: publicUser(result.user) });
});

app.post('/api/auth/staff/login', (req, res) => {
  const result = loginUser(req.body.email, req.body.password, 'staff');
  if (!result) return res.status(401).json({ error: 'Invalid staff email or password.' });
  res.json({ token: result.token, user: publicUser(result.user) });
});

app.post('/api/auth/staff/forgot-password', (req, res) => {
  res.json({ message: 'If that staff email is registered, reset instructions have been sent. Contact the canteen administrator if you need help.' });
});

app.post('/api/auth/staff/logout', (req, res) => {
  sessions.delete(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
  res.json({ message: 'Staff signed out' });
});

app.get('/api/auth/staff/me', (req, res) => {
  const session = currentUser(req);
  const user = session && session.role === 'staff' && readData(USERS_FILE).find((entry) => entry.id === session.id);
  if (!user) return res.status(401).json({ error: 'Staff sign-in required' });
  res.json({ user: publicUser(user) });
});

app.get('/api/staff/profile', requireStaff, (req, res) => {
  if (!req.user.id) return res.json({ user: { name: 'Canteen staff', email: '', role: 'staff' } });
  const user = readData(USERS_FILE).find((entry) => entry.id === req.user.id && entry.role === 'staff');
  if (!user) return res.status(404).json({ error: 'Staff profile not found' });
  res.json({ user: publicUser(user) });
});

app.patch('/api/staff/profile', requireStaff, (req, res) => {
  if (!req.user.id) return res.status(400).json({ error: 'A verified staff account is required to edit the profile.' });
  const users = readData(USERS_FILE);
  const index = users.findIndex((entry) => entry.id === req.user.id && entry.role === 'staff');
  if (index === -1) return res.status(404).json({ error: 'Staff profile not found' });
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  if (users.some((entry, userIndex) => userIndex !== index && entry.email === email)) return res.status(409).json({ error: 'That email is already in use.' });
  users[index].name = name;
  users[index].email = email;
  writeData(USERS_FILE, users);
  res.json({ user: publicUser(users[index]) });
});

const staffAuthMiddleware = (req, res, next) => {
  const user = currentUser(req);
  if (user?.role === 'staff') {
    req.user = user;
    return next();
  }
  if (req.headers['x-staff-pin'] === STAFF_PIN) {
    req.user = { role: 'staff' };
    return next();
  }
  return res.status(401).json({ error: 'Staff authorization required' });
};

const checkStaffPin = (req, res, next) => {
  if (req.headers['x-staff-pin'] !== STAFF_PIN) return res.status(401).json({ error: 'Staff authorization required' });
  req.user = { role: 'staff' };
  next();
};

const pushNotification = (recipient, title, message, type = 'info') => {
  const notifications = readData(NOTIFICATIONS_FILE);
  notifications.unshift({ id: `note-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`, recipient, title, message, type, read: false, createdAt: new Date().toISOString() });
  writeData(NOTIFICATIONS_FILE, notifications.slice(0, 200));
};

// ==========================================
// API ROUTES
// ==========================================

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  const normalizedEmail = String(email || '').toLowerCase().trim();
  if (!name || !normalizedEmail || !password || String(password).length < 6) return res.status(400).json({ error: 'Name, email, and a password of at least 6 characters are required.' });
  const users = readData(USERS_FILE);
  if (users.some((user) => user.email === normalizedEmail)) return res.status(409).json({ error: 'An account with that email already exists.' });
  const credentials = hashPassword(String(password));
  const user = { id: `user-${Date.now()}`, name: String(name).trim(), email: normalizedEmail, role: 'customer', ...credentials, createdAt: new Date().toISOString() };
  users.push(user);
  writeData(USERS_FILE, users);
  const token = tokenFor(user);
  res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/login', (req, res) => {
  const user = readData(USERS_FILE).find((entry) => entry.email === String(req.body.email || '').toLowerCase().trim() && entry.role === 'customer');
  if (!user || !passwordMatches(String(req.body.password || ''), user)) return res.status(401).json({ error: 'Invalid email or password.' });
  res.json({ token: tokenFor(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/forgot-password', (req, res) => {
  res.json({ message: 'If that email is registered, reset instructions have been sent. For this local demo, contact the canteen administrator.' });
});

app.get('/api/auth/me', (req, res) => {
  const session = currentUser(req);
  const user = session && readData(USERS_FILE).find((entry) => entry.id === session.id);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
  sessions.delete(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
  res.json({ message: 'Signed out' });
});

app.post('/api/staff/login', (req, res) => {
  if (req.headers['x-staff-pin'] !== STAFF_PIN) return res.status(401).json({ error: 'Incorrect staff PIN.' });
  res.json({ user: { name: 'Canteen staff', role: 'staff' } });
});

app.get('/api/notifications', requireSignedIn, (req, res) => {
  const recipient = req.user.role === 'customer' ? req.user.id : 'staff';
  res.json({ notifications: readData(NOTIFICATIONS_FILE).filter((note) => note.recipient === recipient || note.recipient === 'all').slice(0, 30) });
});

app.patch('/api/notifications/:id/read', requireSignedIn, (req, res) => {
  const notifications = readData(NOTIFICATIONS_FILE);
  const index = notifications.findIndex((note) => note.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Notification not found' });
  if (notifications[index].recipient !== req.user.id && notifications[index].recipient !== req.user.role && notifications[index].recipient !== 'all') return res.status(403).json({ error: 'Notification access denied' });
  notifications[index].read = true;
  writeData(NOTIFICATIONS_FILE, notifications);
  res.json({ notification: notifications[index] });
});

// Get Menu
app.get('/api/menu', requireCustomerOrStaff, (req, res) => {
  res.json({ items: readData(MENU_FILE) });
});

// Admin: Add Food Item with Image Upload
app.post('/api/admin/menu', requireStaff, upload.single('foodImage'), (req, res) => {
  const menu = readData(MENU_FILE);
  const { name, category, price, prepMinutes, description } = req.body;
  if (!name || !category || !description || !Number.isFinite(Number(price)) || !Number.isFinite(Number(prepMinutes))) {
    return res.status(400).json({ error: 'Name, category, price, preparation time, and description are required.' });
  }
  if (!req.file) return res.status(400).json({ error: 'A food picture is required when adding a new item.' });

  const imageUrl = req.file 
    ? `/uploads/${req.file.filename}` 
    : '/images/default-food.jpg';

  const newItem = {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    category,
    price: Number(price),
    prepMinutes: Number(prepMinutes),
    available: true,
    description,
    imageUrl
  };

  menu.push(newItem);
  writeData(MENU_FILE, menu);
  res.status(201).json({ message: "Food added successfully!", item: newItem });
});

// Admin: Update Food Item
app.put('/api/admin/menu/:id', requireStaff, upload.single('foodImage'), (req, res) => {
  let menu = readData(MENU_FILE);
  const index = menu.findIndex(item => item.id === req.params.id);

  if (index === -1) return res.status(404).json({ error: "Item not found" });

  menu[index] = {
    ...menu[index],
    ...req.body,
    price: Number(req.body.price),
    prepMinutes: Number(req.body.prepMinutes),
    imageUrl: req.file ? `/uploads/${req.file.filename}` : menu[index].imageUrl,
  };
  writeData(MENU_FILE, menu);
  res.json({ message: "Food updated successfully", item: menu[index] });
});

// Admin: Delete Food Item
app.delete('/api/admin/menu/:id', requireStaff, (req, res) => {
  let menu = readData(MENU_FILE);
  const updatedMenu = menu.filter(item => item.id !== req.params.id);
  writeData(MENU_FILE, updatedMenu);
  res.json({ message: "Food deleted successfully" });
});

// Get Orders
app.get('/api/orders', requireCustomer, (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  const orders = readData(ORDERS_FILE);
  res.json({ orders: ids.length ? orders.filter((order) => ids.includes(order.id) && order.customerId === req.user.id) : orders.filter((order) => order.customerId === req.user.id) });
});

app.get('/api/queue', requireCustomer, (req, res) => {
  const waiting = readData(ORDERS_FILE).filter((order) => ['received', 'preparing'].includes(order.status));
  res.json({ queueDelayMinutes: Math.min(waiting.length, 10) });
});

app.post('/api/orders', requireCustomer, (req, res) => {
  const menu = readData(MENU_FILE);
  const { customerName, note, items } = req.body;
  if (!customerName || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'A name and at least one item are required.' });
  const lines = items.map((line) => {
    const item = menu.find((entry) => entry.id === line.id);
    if (!item || !item.available) return null;
    const qty = Math.max(1, Math.min(10, Number(line.qty) || 1));
    return { id: item.id, name: item.name, emoji: item.emoji, price: item.price, qty, prepMinutes: item.prepMinutes };
  });
  if (lines.some((line) => !line)) return res.status(409).json({ error: 'One or more items are no longer available.' });
  const orders = readData(ORDERS_FILE);
  const estimatedMinutes = Math.max(...lines.map((line) => line.prepMinutes)) + Math.ceil((lines.reduce((sum, line) => sum + line.qty, 0) - 1) / 2) + Math.min(orders.filter((order) => ['received', 'preparing'].includes(order.status)).length, 10);
  const order = { id: crypto.randomBytes(5).toString('hex'), code: `A${100 + orders.length + 1}`, customerId: currentUser(req)?.id || null, customerName: String(customerName).trim(), note: String(note || '').trim(), items: lines, total: lines.reduce((sum, line) => sum + line.price * line.qty, 0), status: 'received', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), estimatedMinutes, estimatedReadyAt: new Date(Date.now() + estimatedMinutes * 60000).toISOString(), history: [{ status: 'received', at: new Date().toISOString() }] };
  orders.unshift(order);
  writeData(ORDERS_FILE, orders);
  pushNotification('staff', 'New order received', `${order.code} from ${order.customerName} is ready to prepare.`, 'order');
  res.status(201).json({ order });
});

app.get('/api/orders/:id', (req, res) => {
  const order = readData(ORDERS_FILE).find((entry) => entry.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const user = currentUser(req);
  if (!user || (user.role !== 'staff' && order.customerId !== user.id)) return res.status(401).json({ error: 'Sign in required to view this order' });
  res.json({ order });
});

app.get('/api/staff/orders', requireStaff, (req, res) => {
  res.json({ orders: readData(ORDERS_FILE), serverTime: new Date().toISOString() });
});

app.patch('/api/staff/orders/:id', requireStaff, (req, res) => {
  const orders = readData(ORDERS_FILE);
  const index = orders.findIndex((order) => order.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Order not found' });
  const allowed = ['received', 'preparing', 'ready', 'completed'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Invalid order status' });
  orders[index].status = req.body.status;
  orders[index].updatedAt = new Date().toISOString();
  orders[index].history.push({ status: req.body.status, at: orders[index].updatedAt });
  writeData(ORDERS_FILE, orders);
  res.json({ order: orders[index] });
});

app.patch('/api/staff/menu/:id', requireStaff, (req, res) => {
  const menu = readData(MENU_FILE);
  const item = menu.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  item.available = Boolean(req.body.available);
  writeData(MENU_FILE, menu);
  res.json({ item });
});

// Customer: Suggestions API
app.post('/api/suggestions', requireCustomer, (req, res) => {
  const suggestions = readData(SUGGESTIONS_FILE);
  const { customerName, foodName, category, reason } = req.body;

  const newSuggestion = {
    id: `sug-${Date.now()}`,
    customerId: req.user.id,
    customerName: customerName || req.user.name || 'Student',
    foodName,
    category,
    reason,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  suggestions.push(newSuggestion);
  writeData(SUGGESTIONS_FILE, suggestions);
  res.status(201).json({ message: "Suggestion submitted!", suggestion: newSuggestion });
});

app.get('/api/suggestions', requireStaff, (req, res) => {
  res.json({ suggestions: readData(SUGGESTIONS_FILE) });
});

app.patch('/api/suggestions/:id', requireStaff, (req, res) => {
  const suggestions = readData(SUGGESTIONS_FILE);
  const index = suggestions.findIndex((suggestion) => suggestion.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Suggestion not found' });
  suggestions[index].status = req.body.status || suggestions[index].status;
  writeData(SUGGESTIONS_FILE, suggestions);
  const suggestion = suggestions[index];
  if (suggestion.status === 'planned' || suggestion.status === 'approved') pushNotification('all', 'New canteen idea', `${suggestion.foodName} was added to the canteen ideas list.`, 'suggestion');
  res.json({ suggestion });
});

// Unknown API paths must answer with JSON, not the student page.
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));

// ==========================================
// PAGE ROUTING HANDLERS
// ==========================================

// Staff Board Page Route
app.get('/staff', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'staff.html'));
});

// Default Student App Fallback Route
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Any unexpected error becomes a JSON message (and a line in the server logs) instead of an HTML error page.
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  const status = err.status && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: status < 500 ? err.message : 'Server error. Please try again.' });
});

// Start Server
app.listen(PORT, () => {
  if (STAFF_PIN === '1234') {
    console.warn('[warn] Using the default staff PIN (1234). Set the STAFF_PIN environment variable before deploying.');
  }
  if (STAFF_INVITE_CODE === '2006') {
    console.warn('[warn] Using the default staff verification code. Set STAFF_INVITE_CODE before deploying.');
  }
  console.log(`Campus Pickup is running:`);
  console.log(`  Student app : http://localhost:${PORT}`);
  console.log(`  Staff board : http://localhost:${PORT}/staff`);
  console.log(`  Data folder : ${DATA_DIR}`);
  console.log(`  Uploads     : ${UPLOAD_DIR}`);
});