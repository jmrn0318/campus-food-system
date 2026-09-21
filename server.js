const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const dns = require('dns').promises;

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy; this makes req.ip the visitor's real IP
const PORT = process.env.PORT || 3000;
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const STAFF_INVITE_CODE = process.env.STAFF_INVITE_CODE || '2006';

// Email (Brevo HTTPS API, works on Railway; SMTP is blocked there on non-Pro plans)
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || ''; // must be a sender you verified inside Brevo
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Campus Pickup';
const MAIL_ENABLED = Boolean(BREVO_API_KEY && MAIL_FROM);

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

// ==========================================
// EMAIL VERIFICATION + PASSWORD RESET (6-digit codes sent by email)
// ==========================================

const MIN_PASSWORD = 8;
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const pendingRegistrations = new Map(); // key: "role:email" -> details waiting for the emailed code
const passwordResets = new Map(); // key: "role:email" -> reset code waiting to be used
const rateBuckets = new Map();

setInterval(() => {
  const now = Date.now();
  [pendingRegistrations, passwordResets].forEach((bucket) => {
    for (const [key, record] of bucket) if (record.expiresAt < now) bucket.delete(key);
  });
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt < now) rateBuckets.delete(key);
}, 5 * 60 * 1000).unref();

// Simple per-IP limit so nobody can spam the email quota or guess codes quickly.
const limitRequests = (name, max, windowMs) => (req, res, next) => {
  const key = `${name}:${req.ip}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }
  if (bucket.count >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  bucket.count += 1;
  next();
};
const codeRequestLimit = limitRequests('code-request', 30, 15 * 60 * 1000);
const codeCheckLimit = limitRequests('code-check', 60, 15 * 60 * 1000);

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normalizeEmail = (email) => String(email || '').toLowerCase().trim();
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const secondsLeft = (sentAt) => Math.max(1, Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - sentAt)) / 1000));

const sendMail = async (to, subject, text, html) => {
  if (!MAIL_ENABLED) {
    console.warn(`[mail] Email is not configured (set BREVO_API_KEY and MAIL_FROM). NOT sent to ${to}:\n${text}`);
    return;
  }
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: MAIL_FROM_NAME, email: MAIL_FROM }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Brevo responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
};

const sendCodeEmail = (to, name, code, purpose) => {
  const action = purpose === 'reset' ? 'reset your password' : 'verify your email address';
  const subject = purpose === 'reset' ? 'Your Campus Pickup password reset code' : 'Your Campus Pickup verification code';
  const text = `Hi ${name},\n\nUse this code to ${action}: ${code}\n\nIt expires in 10 minutes. If you did not ask for it, you can ignore this email.\n\nCampus Pickup`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:16px"><h2 style="margin:0 0 12px">Campus Pickup</h2><p>Hi ${escapeHtml(name)},</p><p>Use this code to ${action}:</p><p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:16px 0">${code}</p><p style="color:#555">It expires in 10 minutes. If you did not ask for it, you can ignore this email.</p></div>`;
  return sendMail(to, subject, text, html);
};

// A made-up domain (like "asdf@notreal123.xyz") has no mail server, so we can reject it right away.
const domainCanReceiveMail = async (domain) => {
  const missing = (err) => err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA');
  try {
    if ((await dns.resolveMx(domain)).length) return true;
  } catch (err) {
    if (!missing(err)) return true; // our DNS had a hiccup; the emailed code will still decide
  }
  try {
    return (await dns.resolve4(domain)).length > 0;
  } catch (err) {
    return !missing(err);
  }
};

const issueRegistrationCode = async (key, record) => {
  record.code = generateCode();
  record.expiresAt = Date.now() + CODE_TTL_MS;
  record.sentAt = Date.now();
  record.attempts = 0;
  pendingRegistrations.set(key, record);
  try {
    await sendCodeEmail(record.email, record.name, record.code, 'register');
  } catch (error) {
    pendingRegistrations.delete(key);
    console.error('[mail] Could not send verification email:', error.message);
    return { status: 502, error: 'We could not send the verification email. Please try again in a moment.' };
  }
  return { status: 202, email: record.email, message: `We sent a 6-digit code to ${record.email}. It expires in 10 minutes.` };
};

const startRegistration = async ({ role, name, email, password }) => {
  const normalizedEmail = normalizeEmail(email);
  const cleanName = String(name || '').trim();
  if (!cleanName || !normalizedEmail || !password) return { status: 400, error: 'Name, email, and password are required.' };
  if (String(password).length < MIN_PASSWORD) return { status: 400, error: `Password must be at least ${MIN_PASSWORD} characters.` };
  if (normalizedEmail.length > 254 || !EMAIL_PATTERN.test(normalizedEmail)) return { status: 400, error: 'Please enter a valid email address.' };
  if (readData(USERS_FILE).some((user) => user.email === normalizedEmail)) return { status: 409, error: 'An account with that email already exists.' };
  if (!(await domainCanReceiveMail(normalizedEmail.split('@')[1]))) return { status: 400, error: 'That email address does not look real. Please check it for typos.' };
  const key = `${role}:${normalizedEmail}`;
  const existing = pendingRegistrations.get(key);
  if (existing && Date.now() - existing.sentAt < RESEND_COOLDOWN_MS) return { status: 429, error: `Please wait ${secondsLeft(existing.sentAt)} seconds before asking for another code.` };
  return issueRegistrationCode(key, { role, name: cleanName, email: normalizedEmail, ...hashPassword(String(password)) });
};

const resendRegistration = async (role, email) => {
  const key = `${role}:${normalizeEmail(email)}`;
  const record = pendingRegistrations.get(key);
  if (!record) return { status: 400, error: 'No pending registration for that email. Please register again.' };
  if (Date.now() - record.sentAt < RESEND_COOLDOWN_MS) return { status: 429, error: `Please wait ${secondsLeft(record.sentAt)} seconds before asking for another code.` };
  return issueRegistrationCode(key, record);
};

const finishRegistration = (role, email, code) => {
  const key = `${role}:${normalizeEmail(email)}`;
  const pending = pendingRegistrations.get(key);
  if (!pending) return { status: 400, error: 'No pending registration for that email. Please register again.' };
  if (Date.now() > pending.expiresAt) {
    pendingRegistrations.delete(key);
    return { status: 400, error: 'That code has expired. Please request a new one.' };
  }
  if (!safeEqual(pending.code, String(code || '').trim())) {
    pending.attempts += 1;
    if (pending.attempts >= MAX_CODE_ATTEMPTS) {
      pendingRegistrations.delete(key);
      return { status: 429, error: 'Too many wrong codes. Please register again.' };
    }
    return { status: 400, error: 'Incorrect verification code.' };
  }
  const users = readData(USERS_FILE);
  if (users.some((user) => user.email === pending.email)) {
    pendingRegistrations.delete(key);
    return { status: 409, error: 'An account with that email already exists.' };
  }
  const user = { id: `${role}-${Date.now()}`, name: pending.name, email: pending.email, role, salt: pending.salt, passwordHash: pending.passwordHash, emailVerified: true, createdAt: new Date().toISOString() };
  users.push(user);
  writeData(USERS_FILE, users);
  pendingRegistrations.delete(key);
  return { status: 201, user, token: tokenFor(user) };
};

const RESET_REPLY = { message: 'If that email is registered, a 6-digit reset code has been sent. It expires in 10 minutes.' };

// Always answers the same way, so nobody can use this form to find out which emails have accounts.
const startPasswordReset = async (role, email) => {
  const normalizedEmail = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalizedEmail)) return RESET_REPLY;
  const user = readData(USERS_FILE).find((entry) => entry.email === normalizedEmail && entry.role === role);
  if (!user) return RESET_REPLY;
  const key = `${role}:${normalizedEmail}`;
  const existing = passwordResets.get(key);
  if (existing && Date.now() - existing.sentAt < RESEND_COOLDOWN_MS) return RESET_REPLY;
  const record = { userId: user.id, code: generateCode(), expiresAt: Date.now() + CODE_TTL_MS, sentAt: Date.now(), attempts: 0 };
  passwordResets.set(key, record);
  try {
    await sendCodeEmail(user.email, user.name, record.code, 'reset');
  } catch (error) {
    passwordResets.delete(key);
    console.error('[mail] Could not send reset email:', error.message);
  }
  return RESET_REPLY;
};

const finishPasswordReset = (role, email, code, password) => {
  if (String(password || '').length < MIN_PASSWORD) return { status: 400, error: `Password must be at least ${MIN_PASSWORD} characters.` };
  const key = `${role}:${normalizeEmail(email)}`;
  const record = passwordResets.get(key);
  if (!record || Date.now() > record.expiresAt) {
    passwordResets.delete(key);
    return { status: 400, error: 'That code is invalid or has expired. Please request a new one.' };
  }
  if (!safeEqual(record.code, String(code || '').trim())) {
    record.attempts += 1;
    if (record.attempts >= MAX_CODE_ATTEMPTS) {
      passwordResets.delete(key);
      return { status: 429, error: 'Too many wrong codes. Please request a new one.' };
    }
    return { status: 400, error: 'Incorrect reset code.' };
  }
  const users = readData(USERS_FILE);
  const index = users.findIndex((entry) => entry.id === record.userId && entry.role === role);
  if (index === -1) {
    passwordResets.delete(key);
    return { status: 400, error: 'That code is invalid or has expired. Please request a new one.' };
  }
  Object.assign(users[index], hashPassword(String(password)));
  writeData(USERS_FILE, users);
  passwordResets.delete(key);
  for (const [token, session] of sessions) if (session.id === users[index].id) sessions.delete(token); // sign out everywhere
  return { status: 200 };
};

const replyPending = (res, result) => {
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(202).json({ verificationRequired: true, email: result.email, message: result.message });
};
const replyCreated = (res, result) => {
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json({ token: result.token, user: publicUser(result.user) });
};

const loginUser = (email, password, role) => {
  const user = readData(USERS_FILE).find((entry) => entry.email === String(email || '').toLowerCase().trim() && entry.role === role);
  if (!user || !passwordMatches(String(password || ''), user)) return null;
  return { user, token: tokenFor(user) };
};

app.post('/api/auth/staff/register', codeRequestLimit, async (req, res) => {
  if (!safeEqual(String(req.body.inviteCode || '').trim(), STAFF_INVITE_CODE)) return res.status(403).json({ error: 'Valid staff verification code required.' });
  replyPending(res, await startRegistration({ role: 'staff', name: req.body.name, email: req.body.email, password: req.body.password }));
});

app.post('/api/auth/staff/register/resend', codeRequestLimit, async (req, res) => {
  replyPending(res, await resendRegistration('staff', req.body.email));
});

app.post('/api/auth/staff/register/verify', codeCheckLimit, (req, res) => {
  replyCreated(res, finishRegistration('staff', req.body.email, req.body.code));
});

app.post('/api/auth/staff/login', (req, res) => {
  const result = loginUser(req.body.email, req.body.password, 'staff');
  if (!result) return res.status(401).json({ error: 'Invalid staff email or password.' });
  res.json({ token: result.token, user: publicUser(result.user) });
});

app.post('/api/auth/staff/forgot-password', codeRequestLimit, async (req, res) => {
  res.json(await startPasswordReset('staff', req.body.email));
});

app.post('/api/auth/staff/reset-password', codeCheckLimit, (req, res) => {
  const result = finishPasswordReset('staff', req.body.email, req.body.code, req.body.password);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Password changed. You can now sign in.' });
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

app.post('/api/auth/register', codeRequestLimit, async (req, res) => {
  const { name, email, password } = req.body;
  replyPending(res, await startRegistration({ role: 'customer', name, email, password }));
});

app.post('/api/auth/register/resend', codeRequestLimit, async (req, res) => {
  replyPending(res, await resendRegistration('customer', req.body.email));
});

app.post('/api/auth/register/verify', codeCheckLimit, (req, res) => {
  replyCreated(res, finishRegistration('customer', req.body.email, req.body.code));
});

app.post('/api/auth/login', (req, res) => {
  const user = readData(USERS_FILE).find((entry) => entry.email === String(req.body.email || '').toLowerCase().trim() && entry.role === 'customer');
  if (!user || !passwordMatches(String(req.body.password || ''), user)) return res.status(401).json({ error: 'Invalid email or password.' });
  res.json({ token: tokenFor(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/forgot-password', codeRequestLimit, async (req, res) => {
  res.json(await startPasswordReset('customer', req.body.email));
});

app.post('/api/auth/reset-password', codeCheckLimit, (req, res) => {
  const result = finishPasswordReset('customer', req.body.email, req.body.code, req.body.password);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Password changed. You can now sign in.' });
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
  if (!MAIL_ENABLED) {
    console.warn('[warn] Email is NOT configured. Set BREVO_API_KEY and MAIL_FROM so verification and reset codes are emailed. Until then, codes are only printed in these logs.');
  } else {
    console.log(`[info] Email enabled via Brevo (from ${MAIL_FROM}).`);
  }
  console.log(`Campus Pickup is running:`);
  console.log(`  Student app : http://localhost:${PORT}`);
  console.log(`  Staff board : http://localhost:${PORT}/staff`);
  console.log(`  Data folder : ${DATA_DIR}`);
  console.log(`  Uploads     : ${UPLOAD_DIR}`);
});