const path = require('path');
const fs = require('fs');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const STAFF_INVITE_CODE = process.env.STAFF_INVITE_CODE || '2006';

// Nylas Email Setup
const NYLAS_API_KEY = String(process.env.NYLAS_API_KEY || '').trim();
const NYLAS_GRANT_ID = String(process.env.NYLAS_GRANT_ID || '').trim();

const EMAIL_CONFIGURED = Boolean(
  NYLAS_API_KEY && NYLAS_GRANT_ID
);

// Helper Function para magpadala ng Verification Code
async function sendVerificationEmail(
  toEmail,
  code,
  subjectTitle = 'Your Verification Code'
) {
  if (!EMAIL_CONFIGURED) {
    throw new Error(
      'Nylas email sending is not configured. Check NYLAS_API_KEY and NYLAS_GRANT_ID in .env.'
    );
  }

  const response = await fetch(
    `https://api.us.nylas.com/v3/grants/${NYLAS_GRANT_ID}/messages/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NYLAS_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        subject: `${subjectTitle} - Campus Pickup`,
        body: `Your Campus Pickup verification code is ${code}. This code expires in 10 minutes.`,
        to: [
          {
            email: toEmail
          }
        ]
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result?.message ||
      result?.error?.message ||
      `Nylas failed to send the email. HTTP ${response.status}`
    );
  }

  console.log(
    `[EMAIL] Verification email sent to ${toEmail}. Message ID: ${result?.data?.id || 'unknown'}`
  );
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// File storage configuration for multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `food-${Date.now()}${ext}`);
  },
});

const upload = multer({ storage });

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

ensureDir(DATA_DIR);

function readJson(fileName, fallback) {
  const filePath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(fileName, data) {
  const filePath = path.join(DATA_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Menu and Order Helpers
function getMenu() {
  const seed = path.join(__dirname, 'data', 'menu.seed.json');

  if (!fs.existsSync(path.join(DATA_DIR, 'menu.json')) && fs.existsSync(seed)) {
    fs.copyFileSync(seed, path.join(DATA_DIR, 'menu.json'));
  }

  return readJson('menu.json', []);
}

function saveMenu(menu) {
  writeJson('menu.json', menu);
}

function getOrders() {
  return readJson('orders.json', []);
}

function saveOrders(orders) {
  writeJson('orders.json', orders);
}

function getUsers() {
  return readJson('users.json', []);
}

function saveUsers(users) {
  writeJson('users.json', users);
}

function getOTPs() {
  return readJson('otps.json', []);
}

function saveOTPs(otps) {
  writeJson('otps.json', otps);
}

function getSuggestions() {
  return readJson('suggestions.json', []);
}

function saveSuggestions(suggestions) {
  writeJson('suggestions.json', suggestions);
}

function getNotifications() {
  return readJson('notifications.json', []);
}

function saveNotifications(notes) {
  writeJson('notifications.json', notes);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Auth Middleware
function authUser(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'Unauthorized access.' });
  }

  const token = authHeader.split(' ')[1];
  const users = getUsers();
  const user = users.find((u) => u.token === token);

  if (!user) {
    return res.status(401).json({
      error: 'Session expired. Please sign in again.',
    });
  }

  req.user = user;
  next();
}

function authStaff(req, res, next) {
  const pin = req.headers['x-staff-pin'];
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(' ')[1] : null;

  if (pin === STAFF_PIN) {
    return next();
  }

  if (token) {
    const users = getUsers();
    const staff = users.find((u) => u.token === token && u.role === 'staff');

    if (staff) {
      req.staff = staff;
      return next();
    }
  }

  return res.status(401).json({
    error: 'Staff access denied.',
  });
}

// ESTIMATE TIME FORMULA
function estimateMinutes(items, queueDelay) {
  const longest = Math.max(...items.map((i) => i.prepMinutes || 5));
  const totalQty = items.reduce((sum, i) => sum + i.qty, 0);

  return longest + Math.ceil((totalQty - 1) / 2) + (queueDelay || 0);
}

/* API ROUTES */

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isGmailAddress(email) {
  return /@gmail\.com$/i.test(email);
}

// 1. AUTH ROUTES

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        error: 'All fields are required.',
      });
    }

    if (String(password).length < 8) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters.',
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();

    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({
        error: 'Please enter a valid email address.',
      });
    }

    if (!isGmailAddress(cleanEmail)) {
      return res.status(400).json({
        error: 'Please use a Gmail address (@gmail.com).',
      });
    }

    const users = getUsers();

    if (users.find((u) => u.email === cleanEmail)) {
      return res.status(400).json({
        error: 'Email is already registered.',
      });
    }

    if (!EMAIL_CONFIGURED) {
      return res.status(503).json({
        error: 'Email service is not configured on the server.',
      });
    }

    const code = generateCode();
    const { salt, hash } = hashPassword(password);

    // Send email first.
    // The OTP is saved only if Gmail accepts the email.
    await sendVerificationEmail(
      cleanEmail,
      code,
      'Verify Your Student Account'
    );

    const otps = getOTPs().filter(
      (o) => o.email !== cleanEmail
    );

    otps.push({
      email: cleanEmail,
      code,
      name,
      salt,
      hash,
      role: 'customer',
      expiresAt: Date.now() + 600000,
    });

    saveOTPs(otps);

    res.json({
      message: 'Verification code sent to your email.',
      email: cleanEmail,
    });
  } catch (err) {
    console.error(
      '[REGISTER] Email send failed:',
      err.message
    );

    res.status(502).json({
      error: 'Could not send the verification email. Please try again.',
    });
  }
});

// RESEND CUSTOMER OTP
app.post('/api/auth/register/resend', async (req, res) => {
  try {
    const cleanEmail = String(req.body.email || '')
      .trim()
      .toLowerCase();

    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({
        error: 'Please enter a valid email address.',
      });
    }

    const otps = getOTPs();

    const existing = otps.find(
      (o) =>
        o.email === cleanEmail &&
        o.role === 'customer'
    );

    if (!existing) {
      return res.status(400).json({
        error: 'No pending registration found for this email.',
      });
    }

    if (!EMAIL_CONFIGURED) {
      return res.status(503).json({
        error: 'Email service is not configured on the server.',
      });
    }

    const code = generateCode();

    await sendVerificationEmail(
      cleanEmail,
      code,
      'Your New Student Verification Code'
    );

    existing.code = code;
    existing.expiresAt = Date.now() + 600000;

    saveOTPs(otps);

    res.json({
      message: 'A new verification code was sent to your email.',
      email: cleanEmail,
    });
  } catch (err) {
    console.error(
      '[RESEND] Email send failed:',
      err.message
    );

    res.status(502).json({
      error: 'Could not resend the verification email. Please try again.',
    });
  }
});

// VERIFY CUSTOMER OTP
app.post('/api/auth/register/verify', (req, res) => {
  const { email, code } = req.body;

  const cleanEmail = email.trim().toLowerCase();

  const otps = getOTPs();

  const otp = otps.find(
    (o) =>
      o.email === cleanEmail &&
      o.code === code &&
      o.expiresAt > Date.now()
  );

  if (!otp) {
    return res.status(400).json({
      error: 'Invalid or expired verification code.',
    });
  }

  const users = getUsers();

  const newUser = {
    id: 'usr-' + Date.now(),
    name: otp.name,
    email: cleanEmail,
    salt: otp.salt,
    hash: otp.hash,
    role: otp.role || 'customer',
    createdAt: new Date().toISOString(),
  };

  users.push(newUser);

  saveUsers(users);

  saveOTPs(
    otps.filter((o) => o.email !== cleanEmail)
  );

  res.json({
    message: 'Account created successfully! You can now sign in.',
  });
});

// LOGIN
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  const cleanEmail = email.trim().toLowerCase();

  const users = getUsers();

  const user = users.find(
    (u) => u.email === cleanEmail
  );

  if (!user) {
    return res.status(400).json({
      error: 'Invalid email or password.',
    });
  }

  const { hash } = hashPassword(
    password,
    user.salt
  );

  if (hash !== user.hash) {
    return res.status(400).json({
      error: 'Invalid email or password.',
    });
  }

  const token = crypto
    .randomBytes(32)
    .toString('hex');

  user.token = token;

  saveUsers(users);

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
});

// FORGOT PASSWORD
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    const cleanEmail = String(email || '')
      .trim()
      .toLowerCase();

    const users = getUsers();

    const user = users.find(
      (u) => u.email === cleanEmail
    );

    if (!user) {
      return res.status(400).json({
        error: 'No account found with that email.',
      });
    }

    if (!EMAIL_CONFIGURED) {
      return res.status(503).json({
        error: 'Email service is not configured on the server.',
      });
    }

    const code = generateCode();

    await sendVerificationEmail(
      cleanEmail,
      code,
      'Reset Your Password'
    );

    const otps = getOTPs().filter(
      (o) => o.email !== cleanEmail
    );

    otps.push({
      email: cleanEmail,
      code,
      expiresAt: Date.now() + 600000,
      type: 'reset',
    });

    saveOTPs(otps);

    res.json({
      message: 'Password reset code sent to your email.',
    });
  } catch (err) {
    console.error(
      '[FORGOT PASSWORD] Email send failed:',
      err.message
    );

    res.status(502).json({
      error: 'Could not send the password reset email. Please try again.',
    });
  }
});

// RESET PASSWORD
app.post('/api/auth/reset-password', (req, res) => {
  const { email, code, password } = req.body;

  const cleanEmail = email.trim().toLowerCase();

  const otps = getOTPs();

  const otp = otps.find(
    (o) =>
      o.email === cleanEmail &&
      o.code === code &&
      o.expiresAt > Date.now()
  );

  if (!otp) {
    return res.status(400).json({
      error: 'Invalid or expired code.',
    });
  }

  const users = getUsers();

  const user = users.find(
    (u) => u.email === cleanEmail
  );

  if (!user) {
    return res.status(400).json({
      error: 'User not found.',
    });
  }

  const { salt, hash } = hashPassword(password);

  user.salt = salt;
  user.hash = hash;

  saveUsers(users);

  saveOTPs(
    otps.filter((o) => o.email !== cleanEmail)
  );

  res.json({
    message: 'Password reset successfully.',
  });
});

// CURRENT USER
app.get('/api/auth/me', authUser, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
    },
  });
});

// LOGOUT
app.post('/api/auth/logout', authUser, (req, res) => {
  const users = getUsers();

  const user = users.find(
    (u) => u.id === req.user.id
  );

  if (user) {
    delete user.token;
  }

  saveUsers(users);

  res.json({
    message: 'Signed out.',
  });
});

// STAFF AUTH ROUTES

app.post('/api/auth/staff/register', async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      inviteCode,
    } = req.body;

    if (inviteCode !== STAFF_INVITE_CODE) {
      return res.status(400).json({
        error: 'Invalid staff verification code.',
      });
    }

    if (!name || !email || !password) {
      return res.status(400).json({
        error: 'All fields are required.',
      });
    }

    const cleanEmail = String(email)
      .trim()
      .toLowerCase();

    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({
        error: 'Please enter a valid email address.',
      });
    }

    const users = getUsers();

    if (users.find((u) => u.email === cleanEmail)) {
      return res.status(400).json({
        error: 'Email already registered.',
      });
    }

    if (!EMAIL_CONFIGURED) {
      return res.status(503).json({
        error: 'Email service is not configured on the server.',
      });
    }

    const code = generateCode();

    const { salt, hash } = hashPassword(password);

    await sendVerificationEmail(
      cleanEmail,
      code,
      'Verify Staff Account'
    );

    const otps = getOTPs().filter(
      (o) => o.email !== cleanEmail
    );

    otps.push({
      email: cleanEmail,
      code,
      name,
      salt,
      hash,
      role: 'staff',
      expiresAt: Date.now() + 600000,
    });

    saveOTPs(otps);

    res.json({
      message: 'Staff verification code sent to email.',
      email: cleanEmail,
    });
  } catch (err) {
    console.error(
      '[STAFF REGISTER] Email send failed:',
      err.message
    );

    res.status(502).json({
      error: 'Could not send the staff verification email. Please try again.',
    });
  }
});

// VERIFY STAFF REGISTRATION
app.post('/api/auth/staff/register/verify', (req, res) => {
  const { email, code } = req.body;

  const cleanEmail = email.trim().toLowerCase();

  const otps = getOTPs();

  const otp = otps.find(
    (o) =>
      o.email === cleanEmail &&
      o.code === code &&
      o.expiresAt > Date.now()
  );

  if (!otp) {
    return res.status(400).json({
      error: 'Invalid or expired code.',
    });
  }

  const users = getUsers();

  const newStaff = {
    id: 'stf-' + Date.now(),
    name: otp.name,
    email: cleanEmail,
    salt: otp.salt,
    hash: otp.hash,
    role: 'staff',
    createdAt: new Date().toISOString(),
  };

  users.push(newStaff);

  saveUsers(users);

  saveOTPs(
    otps.filter((o) => o.email !== cleanEmail)
  );

  res.json({
    message: 'Staff account created successfully.',
  });
});

// STAFF LOGIN
app.post('/api/auth/staff/login', (req, res) => {
  const { email, password } = req.body;

  const cleanEmail = email.trim().toLowerCase();

  const users = getUsers();

  const staff = users.find(
    (u) =>
      u.email === cleanEmail &&
      u.role === 'staff'
  );

  if (!staff) {
    return res.status(400).json({
      error: 'Invalid staff credentials.',
    });
  }

  const { hash } = hashPassword(
    password,
    staff.salt
  );

  if (hash !== staff.hash) {
    return res.status(400).json({
      error: 'Invalid staff credentials.',
    });
  }

  const token = crypto
    .randomBytes(32)
    .toString('hex');

  staff.token = token;

  saveUsers(users);

  res.json({
    token,
    user: {
      id: staff.id,
      name: staff.name,
      email: staff.email,
      role: 'staff',
    },
  });
});

// STAFF PROFILE
app.get('/api/staff/profile', authStaff, (req, res) => {
  if (req.staff) {
    return res.json({
      user: {
        name: req.staff.name,
        email: req.staff.email,
      },
    });
  }

  res.json({
    user: {
      name: 'Staff Administrator',
      email: 'canteen.staff@campus.edu',
    },
  });
});

// UPDATE STAFF PROFILE
app.patch('/api/staff/profile', authStaff, (req, res) => {
  const { name, email } = req.body;

  if (req.staff) {
    const users = getUsers();

    const staff = users.find(
      (u) => u.id === req.staff.id
    );

    if (staff) {
      if (name) {
        staff.name = name.trim();
      }

      if (email) {
        staff.email = email.trim().toLowerCase();
      }

      saveUsers(users);
    }
  }

  res.json({
    message: 'Profile updated.',
  });
});

// MENU & ORDERS ROUTES

app.get('/api/menu', (req, res) => {
  res.json({
    items: getMenu(),
  });
});

app.get('/api/queue', (req, res) => {
  const orders = getOrders();

  const waiting = orders.filter(
    (o) =>
      o.status === 'received' ||
      o.status === 'preparing'
  );

  res.json({
    queueDelayMinutes: waiting.length,
  });
});

// CREATE ORDER
app.post('/api/orders', (req, res) => {
  const {
    customerName,
    note,
    items,
  } = req.body;

  if (
    !customerName ||
    !items ||
    !items.length
  ) {
    return res.status(400).json({
      error: 'Please include items and your name.',
    });
  }

  const menu = getMenu();

  let total = 0;

  const orderItems = [];

  for (const line of items) {
    const menuItem = menu.find(
      (m) => m.id === line.id
    );

    if (!menuItem || !menuItem.available) {
      return res.status(409).json({
        error: `${
          menuItem
            ? menuItem.name
            : 'An item'
        } is sold out.`,
      });
    }

    total += menuItem.price * line.qty;

    orderItems.push({
      id: menuItem.id,
      name: menuItem.name,
      price: menuItem.price,
      prepMinutes: menuItem.prepMinutes,
      qty: line.qty,
    });
  }

  const orders = getOrders();

  const waiting = orders.filter(
    (o) =>
      o.status === 'received' ||
      o.status === 'preparing'
  );

  const prepMins = estimateMinutes(
    orderItems,
    waiting.length
  );

  const order = {
    id: 'ord-' + Date.now(),

    code:
      'A' +
      Math.floor(
        100 + Math.random() * 900
      ),

    customerName,

    note: note || '',

    items: orderItems,

    total,

    status: 'received',

    createdAt:
      new Date().toISOString(),

    estimatedReadyAt:
      new Date(
        Date.now() +
        prepMins * 60000
      ).toISOString(),

    history: [
      {
        status: 'received',
        at: new Date().toISOString(),
      },
    ],
  };

  orders.unshift(order);

  saveOrders(orders);

  res.json({
    order,
  });
});

// GET SINGLE ORDER
app.get('/api/orders/:id', (req, res) => {
  const orders = getOrders();

  const order = orders.find(
    (o) => o.id === req.params.id
  );

  if (!order) {
    return res.status(404).json({
      error: 'Order not found.',
    });
  }

  const waiting = orders.filter(
    (o) =>
      (
        o.status === 'received' ||
        o.status === 'preparing'
      ) &&
      new Date(o.createdAt) <
        new Date(order.createdAt)
  );

  res.json({
    order: {
      ...order,
      ordersAhead: waiting.length,
    },
  });
});

// GET MULTIPLE ORDERS
app.get('/api/orders', (req, res) => {
  const ids = req.query.ids
    ? req.query.ids.split(',')
    : [];

  const orders = getOrders().filter(
    (o) => ids.includes(o.id)
  );

  res.json({
    orders,
  });
});

// STAFF ORDER MANAGEMENT

app.get(
  '/api/staff/orders',
  authStaff,
  (req, res) => {
    const orders = getOrders().filter(
      (o) =>
        o.status !== 'completed' ||
        Date.now() -
          new Date(o.createdAt).getTime() <
          86400000
    );

    res.json({
      orders,
      serverTime:
        new Date().toISOString(),
    });
  }
);

// UPDATE ORDER STATUS
app.patch(
  '/api/staff/orders/:id',
  authStaff,
  (req, res) => {
    const { status } = req.body;

    const orders = getOrders();

    const order = orders.find(
      (o) => o.id === req.params.id
    );

    if (!order) {
      return res.status(404).json({
        error: 'Order not found.',
      });
    }

    order.status = status;

    order.history.push({
      status,
      at: new Date().toISOString(),
    });

    saveOrders(orders);

    res.json({
      order,
    });
  }
);

// UPDATE MENU AVAILABILITY
app.patch(
  '/api/staff/menu/:id',
  authStaff,
  (req, res) => {
    const { available } = req.body;

    const menu = getMenu();

    const item = menu.find(
      (m) => m.id === req.params.id
    );

    if (!item) {
      return res.status(404).json({
        error: 'Item not found.',
      });
    }

    item.available = available;

    saveMenu(menu);

    res.json({
      item,
    });
  }
);

// BREAD ADMIN MENU ROUTES

// ADD MENU ITEM
app.post(
  '/api/admin/menu',
  authStaff,
  upload.single('foodImage'),
  (req, res) => {
    const {
      name,
      category,
      price,
      prepMinutes,
      description,
    } = req.body;

    const menu = getMenu();

    const newItem = {
      id: 'food-' + Date.now(),
      name,
      category,
      price: Number(price),
      prepMinutes: Number(prepMinutes),
      description,
      available: true,
      imageUrl: req.file
        ? `/uploads/${req.file.filename}`
        : '',
    };

    menu.push(newItem);

    saveMenu(menu);

    res.json({
      item: newItem,
    });
  }
);

// UPDATE MENU ITEM
app.put(
  '/api/admin/menu/:id',
  authStaff,
  upload.single('foodImage'),
  (req, res) => {
    const {
      name,
      category,
      price,
      prepMinutes,
      description,
    } = req.body;

    const menu = getMenu();

    const item = menu.find(
      (m) => m.id === req.params.id
    );

    if (!item) {
      return res.status(404).json({
        error: 'Food item not found.',
      });
    }

    if (name) {
      item.name = name;
    }

    if (category) {
      item.category = category;
    }

    if (price) {
      item.price = Number(price);
    }

    if (prepMinutes) {
      item.prepMinutes =
        Number(prepMinutes);
    }

    if (description) {
      item.description =
        description;
    }

    if (req.file) {
      item.imageUrl =
        `/uploads/${req.file.filename}`;
    }

    saveMenu(menu);

    res.json({
      item,
    });
  }
);

// DELETE MENU ITEM
app.delete(
  '/api/admin/menu/:id',
  authStaff,
  (req, res) => {
    let menu = getMenu();

    menu = menu.filter(
      (m) => m.id !== req.params.id
    );

    saveMenu(menu);

    res.json({
      message: 'Food item deleted.',
    });
  }
);

// SUGGESTIONS & NOTIFICATIONS

app.get(
  '/api/suggestions',
  authStaff,
  (req, res) => {
    res.json({
      suggestions:
        getSuggestions(),
    });
  }
);

// CREATE SUGGESTION
app.post('/api/suggestions', (req, res) => {
  const {
    customerName,
    foodName,
    category,
    reason,
  } = req.body;

  const suggestions =
    getSuggestions();

  const newIdea = {
    id: 'sug-' + Date.now(),
    customerName:
      customerName || 'Anonymous',
    foodName,
    category,
    reason,
    status: 'pending',
    createdAt:
      new Date().toISOString(),
  };

  suggestions.unshift(newIdea);

  saveSuggestions(suggestions);

  res.json({
    suggestion: newIdea,
  });
});

// UPDATE SUGGESTION
app.patch(
  '/api/suggestions/:id',
  authStaff,
  (req, res) => {
    const { status } = req.body;

    const suggestions =
      getSuggestions();

    const sug = suggestions.find(
      (s) => s.id === req.params.id
    );

    if (sug) {
      sug.status = status;
      saveSuggestions(suggestions);
    }

    res.json({
      suggestion: sug,
    });
  }
);

// NOTIFICATIONS
app.get('/api/notifications', (req, res) => {
  res.json({
    notifications:
      getNotifications(),
  });
});

// FALLBACK ROUTES

app.get('/staff', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public',
      'staff.html'
    )
  );
});

app.use((req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public',
      'index.html'
    )
  );
});

// START SERVER
const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);

  if (!EMAIL_CONFIGURED) {
    console.warn(
      '[EMAIL] Nylas is NOT configured. Check NYLAS_API_KEY and NYLAS_GRANT_ID in .env.'
    );
  } else {
    console.log('[EMAIL] Nylas is configured and ready.');
  }
});

server.on('error', (err) => {
  console.error('[SERVER ERROR]', err);
});

server.on('close', () => {
  console.error('[SERVER] The HTTP server was closed.');
});

process.on('exit', (code) => {
  console.log(`[PROCESS] Node process is exiting with code ${code}`);
});

process.on('SIGINT', () => {
  console.log('[PROCESS] SIGINT received.');
});

process.on('SIGTERM', () => {
  console.log('[PROCESS] SIGTERM received.');
});