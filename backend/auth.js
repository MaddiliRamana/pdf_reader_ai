const Database  = require('better-sqlite3');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path       = require('path');

const JWT_SECRET = process.env.JWT_SECRET || 'cognitive-curator-secret-2024';
const db = new Database(path.join(__dirname, 'users.db'));

// ── CREATE TABLES ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_pdfs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_data BLOB NOT NULL,
    extracted_text TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS user_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    pdf_id INTEGER,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// Add email column to existing DBs safely
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch (_) {}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── REGISTER ──────────────────────────────────────────────────────────────────
function registerUser(username, password, phone, email) {
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username))
    return { error: 'Username already taken' };
  if (db.prepare('SELECT id FROM users WHERE phone = ?').get(phone))
    return { error: 'Phone number already registered' };
  if (email && db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(email.toLowerCase()))
    return { error: 'Email already registered' };

  const hashed = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (username, password, phone, email) VALUES (?, ?, ?, ?)'
  ).run(username, hashed, phone, email || '');
  return { success: true, userId: result.lastInsertRowid };
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
function loginUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return { error: 'Invalid username or password' };
  if (!bcrypt.compareSync(password, user.password)) return { error: 'Invalid username or password' };
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  return { success: true, token, username: user.username };
}

// ── EMAIL OTP ─────────────────────────────────────────────────────────────────
const emailOtpStore = {};

async function sendOTPByEmail(email) {
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email.toLowerCase());
  if (!user) return { error: 'No account found with this email address' };

  const code    = generateOTP();
  const expires = Date.now() + 2 * 60 * 1000; // 2 minutes
  emailOtpStore[email.toLowerCase()] = { code, expires };

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (gmailUser && gmailPass && gmailUser !== 'your_gmail@gmail.com') {
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: gmailUser, pass: gmailPass },
        tls: { rejectUnauthorized: false }
      });
      await transporter.sendMail({
        from: `"Cognitive Curator" <${gmailUser}>`,
        to: email,
        subject: 'Your OTP Code — Cognitive Curator',
        html: `
          <div style="font-family:sans-serif;max-width:420px;margin:auto;padding:32px;
                      background:#1e1e3a;color:#e2e8f0;border-radius:16px;text-align:center">
            <h2 style="color:#a78bfa;margin-bottom:8px">🧠 Cognitive Curator</h2>
            <p style="color:#94a3b8;margin-bottom:24px">Your login OTP code is:</p>
            <div style="font-size:2.8rem;font-weight:900;letter-spacing:12px;color:#ffd700;
                        background:#0f0f1a;padding:20px;border-radius:12px;margin-bottom:20px">
              ${code}
            </div>
            <p style="color:#94a3b8;font-size:0.85rem">
              Valid for 2 minutes. Do not share this code.
            </p>
          </div>`
      });
      console.log(`✅ OTP email sent to ${email}`);
      return { success: true, message: `OTP sent to ${email}` };
    } catch (e) {
      console.error('Gmail failed:', e.message);
      return { success: true, code, message: `Email failed: ${e.message}` };
    }
  }

  // Dev mode
  console.log(`\n📧 [DEV] OTP for ${email}: ${code}\n`);
  return { success: true, code, message: 'Dev mode: set GMAIL_USER and GMAIL_APP_PASSWORD in .env' };
}

function verifyOTPLoginByEmail(email, code) {
  const key    = email.toLowerCase();
  const stored = emailOtpStore[key];
  if (!stored)                      return { error: 'No OTP requested for this email' };
  if (Date.now() > stored.expires)  return { error: 'OTP expired. Request a new one.' };
  if (stored.code !== code)         return { error: 'Invalid OTP code' };

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(key);
  if (!user) return { error: 'No account found with this email' };

  delete emailOtpStore[key];
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  return { success: true, token, username: user.username };
}

// ── LIBRARY: PDFs ─────────────────────────────────────────────────────────────
function savePDF(userId, originalName, fileBuffer, extractedText) {
  const filename = Date.now() + '-' + originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const result = db.prepare(
    'INSERT INTO user_pdfs (user_id, filename, original_name, file_data, extracted_text) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, filename, originalName, fileBuffer, extractedText || '');
  return { id: result.lastInsertRowid, filename, originalName };
}

function getUserPDFs(userId) {
  return db.prepare(
    'SELECT id, original_name, filename, uploaded_at FROM user_pdfs WHERE user_id = ? ORDER BY uploaded_at DESC'
  ).all(userId);
}

function getPDFById(pdfId, userId) {
  return db.prepare('SELECT * FROM user_pdfs WHERE id = ? AND user_id = ?').get(pdfId, userId);
}

function deletePDF(pdfId, userId) {
  db.prepare('DELETE FROM user_notes WHERE pdf_id = ? AND user_id = ?').run(pdfId, userId);
  return db.prepare('DELETE FROM user_pdfs WHERE id = ? AND user_id = ?').run(pdfId, userId).changes > 0;
}

// ── LIBRARY: NOTES ────────────────────────────────────────────────────────────
function saveNotes(userId, title, content, pdfId = null) {
  const result = db.prepare(
    'INSERT INTO user_notes (user_id, pdf_id, title, content) VALUES (?, ?, ?, ?)'
  ).run(userId, pdfId, title, content);
  return { id: result.lastInsertRowid };
}

function getUserNotes(userId) {
  return db.prepare(`
    SELECT n.id, n.title, n.created_at, p.original_name as pdf_name
    FROM user_notes n
    LEFT JOIN user_pdfs p ON n.pdf_id = p.id
    WHERE n.user_id = ? ORDER BY n.created_at DESC
  `).all(userId);
}

function getNoteById(noteId, userId) {
  return db.prepare('SELECT * FROM user_notes WHERE id = ? AND user_id = ?').get(noteId, userId);
}

function deleteNote(noteId, userId) {
  return db.prepare('DELETE FROM user_notes WHERE id = ? AND user_id = ?').run(noteId, userId).changes > 0;
}

// ── JWT ───────────────────────────────────────────────────────────────────────
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

module.exports = {
  registerUser, loginUser, verifyToken,
  sendOTPByEmail, verifyOTPLoginByEmail,
  savePDF, getUserPDFs, getPDFById, deletePDF,
  saveNotes, getUserNotes, getNoteById, deleteNote
};
