require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
const { sendPasswordResetEmail } = require('./email-service');

const app = express();
const authPort = process.env.AUTH_PORT || 3468;
const jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const bridgeUrl = process.env.BRIDGE_URL || 'https://claude-bridge-standalone.procyss-automation.com';
const bridgeName = process.env.BRIDGE_NAME || 'Claude Code Bridge Standalone';

const dbPath = path.join(__dirname, 'auth.db');
const db = new Database(dbPath);

// -- Production credential delegation (Adlux Production users table) ----------
// Logins are verified against the live production users table so the bridge
// uses the exact same email + password as the production Adlux app. The local
// auth.db still owns the pane mapping (home_path) and sessions; only the
// password check is delegated. bcrypt ($2y$) hashes verify fine under bcryptjs.
const mysql = require("mysql2/promise");
const prodPool = mysql.createPool({
  host: process.env.PROD_DB_HOST,
  port: +(process.env.PROD_DB_PORT || 3306),
  user: process.env.PROD_DB_USERNAME,
  password: process.env.PROD_DB_PASSWORD,
  database: process.env.PROD_DB_DATABASE,
  connectionLimit: 5,
  waitForConnections: true,
});

async function verifyProdPassword(email, password) {
  try {
    const [rows] = await prodPool.query("SELECT password FROM users WHERE email = ? LIMIT 1", [email]);
    if (!rows.length || !rows[0].password) return false;
    return bcrypt.compareSync(password, rows[0].password);
  } catch (err) {
    console.error("[auth] prod password check failed:", err.code || err.message);
    return false; // fail closed
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Initialize database if needed
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Migration: add home_path column if it doesn't exist
try {
  db.exec(`ALTER TABLE users ADD COLUMN home_path TEXT NOT NULL DEFAULT '/peter'`);
} catch (e) {
  // column already exists, ignore
}

// Utility functions
function verifySessionToken(token) {
  try {
    const decoded = jwt.verify(token, jwtSecret);
    const session = db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
    return session ? decoded : null;
  } catch (err) {
    return null;
  }
}

function createSessionToken(userId) {
  const token = jwt.sign({ userId }, jwtSecret, { expiresIn: '7d' });
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(
    userId,
    token,
    expiresAt
  );

  return token;
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createPasswordResetToken(userId) {
  const token = generateResetToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(
    userId,
    token,
    expiresAt
  );

  return token;
}

function verifyResetToken(token) {
  const resetToken = db.prepare(
    "SELECT user_id FROM password_reset_tokens WHERE token = ? AND expires_at > datetime('now')"
  ).get(token);

  return resetToken ? resetToken.user_id : null;
}

function deleteResetToken(token) {
  db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
}

// Middleware to check authentication
function checkAuth(req, res, next) {
  const token = req.cookies.bridge_session;
  const user = verifySessionToken(token);

  if (user) {
    req.user = user;
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// HTML Templates
function getLoginForm(error = null) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - ${bridgeName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.2);
      width: 100%;
      max-width: 400px;
    }
    h1 {
      color: #333;
      margin-bottom: 8px;
      font-size: 24px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      color: #333;
      font-weight: 500;
      margin-bottom: 8px;
      font-size: 14px;
    }
    input[type="text"],
    input[type="email"],
    input[type="password"] {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      transition: border-color 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    button {
      width: 100%;
      padding: 10px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      font-weight: 600;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    }
    button:hover {
      background: #5568d3;
    }
    .error {
      background: #fee;
      border: 1px solid #fcc;
      color: #c00;
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 20px;
      font-size: 13px;
    }
    .links {
      text-align: center;
      margin-top: 20px;
      font-size: 13px;
    }
    .links a {
      color: #667eea;
      text-decoration: none;
    }
    .links a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${bridgeName}</h1>
    <div class="subtitle">Sign in to continue</div>

    ${error ? `<div class="error">${error}</div>` : ''}

    <form method="POST" action="/auth/login">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autofocus>
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required>
      </div>
      <button type="submit">Sign In</button>
    </form>

    <div class="links">
      <a href="/auth/forgot-password">Forgot password?</a>
    </div>
  </div>
</body>
</html>
  `;
}

function getForgotPasswordForm(error = null, success = null) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Forgot Password - ${bridgeName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.2);
      width: 100%;
      max-width: 400px;
    }
    h1 {
      color: #333;
      margin-bottom: 8px;
      font-size: 24px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      color: #333;
      font-weight: 500;
      margin-bottom: 8px;
      font-size: 14px;
    }
    input[type="email"] {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    button {
      width: 100%;
      padding: 10px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      font-weight: 600;
      cursor: pointer;
      font-size: 14px;
    }
    button:hover {
      background: #5568d3;
    }
    .error {
      background: #fee;
      border: 1px solid #fcc;
      color: #c00;
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 20px;
      font-size: 13px;
    }
    .success {
      background: #efe;
      border: 1px solid #cfc;
      color: #060;
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 20px;
      font-size: 13px;
    }
    .links {
      text-align: center;
      margin-top: 20px;
      font-size: 13px;
    }
    .links a {
      color: #667eea;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Reset Password</h1>
    <div class="subtitle">Manage your password in the Adlux Production app - the bridge uses the same login.</div>

    ${error ? `<div class="error">${error}</div>` : ''}
    ${success ? `<div class="success">${success}</div>` : ''}

    <form method="POST" action="/auth/forgot-password">
      <div class="form-group">
        <label for="email">Email Address</label>
        <input type="email" id="email" name="email" required autofocus>
      </div>
      <button type="submit">Send Reset Link</button>
    </form>

    <div class="links">
      <a href="/auth/login">Back to login</a>
    </div>
  </div>
</body>
</html>
  `;
}

function getResetPasswordForm(token, error = null) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Password - ${bridgeName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.2);
      width: 100%;
      max-width: 400px;
    }
    h1 {
      color: #333;
      margin-bottom: 8px;
      font-size: 24px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      color: #333;
      font-weight: 500;
      margin-bottom: 8px;
      font-size: 14px;
    }
    input[type="password"] {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    button {
      width: 100%;
      padding: 10px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      font-weight: 600;
      cursor: pointer;
      font-size: 14px;
    }
    button:hover {
      background: #5568d3;
    }
    .error {
      background: #fee;
      border: 1px solid #fcc;
      color: #c00;
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 20px;
      font-size: 13px;
    }
    .links {
      text-align: center;
      margin-top: 20px;
      font-size: 13px;
    }
    .links a {
      color: #667eea;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Create New Password</h1>
    <div class="subtitle">Enter your new password</div>

    ${error ? `<div class="error">${error}</div>` : ''}

    <form method="POST" action="/auth/reset-password">
      <input type="hidden" name="token" value="${token}">
      <div class="form-group">
        <label for="password">New Password</label>
        <input type="password" id="password" name="password" required autofocus>
      </div>
      <div class="form-group">
        <label for="confirm">Confirm Password</label>
        <input type="password" id="confirm" name="confirm" required>
      </div>
      <button type="submit">Reset Password</button>
    </form>

    <div class="links">
      <a href="/auth/login">Back to login</a>
    </div>
  </div>
</body>
</html>
  `;
}

// Routes
app.get('/auth/login', (req, res) => {
  const error = req.query.error || null;
  res.set('Content-Type', 'text/html').send(getLoginForm(error));
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.set('Content-Type', 'text/html').send(getLoginForm('Username and password are required'));
  }

  // Accept either the bridge username or the production email as the identifier.
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);

  // Password is verified against the live production users table (single source of truth).
  if (!user || !(await verifyProdPassword(user.email, password))) {
    return res.set('Content-Type', 'text/html').send(getLoginForm('Invalid username or password'));
  }

  const token = createSessionToken(user.id);
  res.cookie('bridge_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.redirect(user.home_path || '/');
});

app.get('/auth/logout', (req, res) => {
  const token = req.cookies.bridge_session;
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.clearCookie('bridge_session');
  res.redirect('/auth/login');
});

app.get('/auth/forgot-password', (req, res) => {
  const error = req.query.error || null;
  const success = req.query.success || null;
  res.set('Content-Type', 'text/html').send(getForgotPasswordForm(error, success));
});

app.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.set('Content-Type', 'text/html').send(getForgotPasswordForm('Email is required'));
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (user) {
    const resetToken = createPasswordResetToken(user.id);

    try {
      await sendPasswordResetEmail(email, resetToken, bridgeUrl);
    } catch (err) {
      console.error('Failed to send email:', err);
      return res.set('Content-Type', 'text/html').send(
        getForgotPasswordForm('Failed to send email. Please try again later.')
      );
    }
  }

  // Always show success message for security (don't leak if email exists)
  res.set('Content-Type', 'text/html').send(
    getForgotPasswordForm(null, 'If that email exists, a reset link has been sent')
  );
});

app.get('/auth/reset-password', (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.redirect('/auth/login');
  }

  const userId = verifyResetToken(token);
  if (!userId) {
    return res.set('Content-Type', 'text/html').send(
      getResetPasswordForm(token, 'Password reset link is invalid or has expired')
    );
  }

  res.set('Content-Type', 'text/html').send(getResetPasswordForm(token));
});

app.post('/auth/reset-password', (req, res) => {
  const { token, password, confirm } = req.body;

  if (!password || !confirm) {
    return res.set('Content-Type', 'text/html').send(getResetPasswordForm(token, 'Password is required'));
  }

  if (password !== confirm) {
    return res.set('Content-Type', 'text/html').send(getResetPasswordForm(token, 'Passwords do not match'));
  }

  if (password.length < 8) {
    return res.set('Content-Type', 'text/html').send(getResetPasswordForm(token, 'Password must be at least 8 characters'));
  }

  const userId = verifyResetToken(token);
  if (!userId) {
    return res.set('Content-Type', 'text/html').send(getResetPasswordForm(token, 'Reset link is invalid or expired'));
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(passwordHash, userId);
  deleteResetToken(token);

  res.redirect('/auth/login?message=Password reset successfully, please sign in');
});

// Verify endpoint (used by nginx)
app.get('/auth/verify', (req, res) => {
  const token = req.cookies.bridge_session;
  const decoded = verifySessionToken(token);

  if (!decoded) {
    return res.status(401).json({ valid: false });
  }

  // Cross-user path isolation check
  const originalUri = req.headers['x-original-uri'] || '';
  const user = db.prepare('SELECT home_path FROM users WHERE id = ?').get(decoded.userId);

  if (user && user.home_path) {
    // Exempt /auth/ paths from path check (login/logout/reset)
    if (!originalUri.startsWith('/auth/') && !originalUri.startsWith(user.home_path)) {
      return res.status(403).json({ valid: false, reason: 'path_mismatch' });
    }
  }

  res.status(200).json({ valid: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(authPort, '0.0.0.0', () => {
  console.log(`✓ Auth server listening on port ${authPort}`);
  console.log(`  Bridge: ${bridgeName}`);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Reset token expiry: 1 hour`);
  console.log(`  Session token expiry: 7 days`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
