/**
 * SAP Basis Jahresplaner - Backend Server
 * 
 * Express.js Server mit SQLite-Datenbank und Multi-User-Support
 * Port: 3232
 */

const express = require('express');

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const fs = require('fs');

const app = express();
const PORT = 3232;

// Middleware
const LOG_FILE = path.join(__dirname, 'server.log');
const MAX_LOG_SIZE = 1024 * 1024; // 1MB

app.use(cookieParser());

// Security Headers via Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://cdn.tailwindcss.com"], // Allow React/Babel CDN if used
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"]
    }
  }
}));

// Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // Strict limit for login (10 attempts per 15 min)
  message: { error: 'Zu viele Anmeldeversuche. Bitte versuchen Sie es in 15 Minuten erneut.' }
});
app.use('/api/auth/login', loginLimiter);

// CORS Configuration
// Re-enabled for network/Docker flexibility as requested
app.use(cors());

app.use(express.json({ limit: '10mb' }));

// Serve static files (the HTML frontend)
app.use(express.static(__dirname));

// =========================================================================
// DATABASE SETUP
// =========================================================================

const dbPath = path.join(__dirname, 'sap-planner.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Initialize database schema
const initDatabase = () => {
  db.exec(`
    -- Users & Authentication
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT CHECK(role IN ('admin', 'user')) NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL
    );

    -- Application Settings
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT
    );

    -- Activity Types
    CREATE TABLE IF NOT EXISTS activity_types (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    -- Landscapes
    CREATE TABLE IF NOT EXISTS landscapes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    -- SIDs
    CREATE TABLE IF NOT EXISTS sids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      landscape_id INTEGER REFERENCES landscapes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      is_prd BOOLEAN DEFAULT FALSE,
      notes TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );

    -- Activities
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sid_id INTEGER REFERENCES sids(id) ON DELETE CASCADE,
      type_id TEXT REFERENCES activity_types(id),
      start_date TEXT NOT NULL,
      duration INTEGER DEFAULT 1,
      includes_weekend BOOLEAN DEFAULT FALSE
    );

    -- Maintenance Sundays (Wartungssonntage)
    CREATE TABLE IF NOT EXISTS maintenance_sundays (
      id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 4),
      date TEXT,
      label TEXT DEFAULT ''
    );

    -- Sub-Activities (for Update/Upgrade activities)
    CREATE TABLE IF NOT EXISTS sub_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Sub-Aktivität',
      start_date TEXT NOT NULL,
      duration INTEGER DEFAULT 1,
      includes_weekend BOOLEAN DEFAULT FALSE,
      sort_order INTEGER DEFAULT 0
    );

    -- Application Logs
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      level TEXT CHECK(level IN ('INFO', 'WARN', 'ERROR')) DEFAULT 'INFO',
      user_id INTEGER REFERENCES users(id),
      username TEXT,
      action TEXT NOT NULL,
      details TEXT
    );

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sids_landscape ON sids(landscape_id);
    CREATE INDEX IF NOT EXISTS idx_activities_sid ON activities(sid_id);
    CREATE INDEX IF NOT EXISTS idx_subactivities_activity ON sub_activities(activity_id);
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
  `);

  // Create default admin user if not exists
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const passwordHash = bcrypt.hashSync('buek45$d4R', 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', passwordHash, 'admin');
    console.log('✓ Default admin user created (admin / buek45$d4R)');
  }

  // Create default settings if not exists
  const yearSetting = db.prepare('SELECT id FROM settings WHERE key = ?').get('year');
  if (!yearSetting) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('year', '2026');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('bundesland', 'BW');
    console.log('✓ Default settings created');
  }

  // Create default activity types if not exists
  const typesExist = db.prepare('SELECT COUNT(*) as count FROM activity_types').get();
  if (typesExist.count === 0) {
    const defaultTypes = [
      { id: 'installation', label: 'Installation', color: '#3b82f6' },
      { id: 'update', label: 'Update/Upgrade', color: '#8b5cf6' },
      { id: 'kernel', label: 'Kernel Update', color: '#06b6d4' },
      { id: 'db', label: 'DB Update', color: '#10b981' },
      { id: 'os', label: 'OS Patches', color: '#f59e0b' },
      { id: 'stpi', label: 'ST-PI Patches', color: '#ef4444' },
      { id: 'security', label: 'Security Patches', color: '#ec4899' },
      { id: 'other', label: 'Sonstige', color: '#6b7280' }
    ];
    const insertType = db.prepare('INSERT INTO activity_types (id, label, color, sort_order) VALUES (?, ?, ?, ?)');
    defaultTypes.forEach((type, index) => {
      insertType.run(type.id, type.label, type.color, index);
    });
    console.log('✓ Default activity types created');
  }

  // Create default maintenance sundays if not exists
  const maintenanceExists = db.prepare('SELECT COUNT(*) as count FROM maintenance_sundays').get();
  if (maintenanceExists.count === 0) {
    const insertMaint = db.prepare('INSERT INTO maintenance_sundays (id, date, label) VALUES (?, ?, ?)');
    insertMaint.run(1, '', 'Wartungssonntag I');
    insertMaint.run(2, '', 'Wartungssonntag II');
    insertMaint.run(3, '', 'Wartungssonntag III');
    insertMaint.run(4, '', 'Wartungssonntag IV');
    console.log('✓ Default maintenance sundays created');
  }

  // Migration: Add notes column to sids table if not exists
  try {
    db.exec(`ALTER TABLE sids ADD COLUMN notes TEXT DEFAULT ''`);
    console.log('✓ Added notes column to sids table');
  } catch (e) {
    // Column already exists, ignore
  }

  console.log('✓ Database initialized');
};

initDatabase();

// =========================================================================
// LOGGING HELPER
// =========================================================================

const logAction = (userId, username, action, details = null) => {
  try {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${username || 'SYSTEM'}] ${action}: ${details ? JSON.stringify(details) : ''}\n`;

    // Check file size and rotate if needed
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size >= MAX_LOG_SIZE) {
        // Log rotation: Read file, drop oldest 20%, write back
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = content.split('\n');
        const splitIndex = Math.floor(lines.length * 0.2);
        const newContent = lines.slice(splitIndex).join('\n');
        fs.writeFileSync(LOG_FILE, newContent);
      }
    }

    fs.appendFileSync(LOG_FILE, logLine);
  } catch (e) {
    console.error('Logging error:', e);
  }
};

// =========================================================================
// AUTHENTICATION MIDDLEWARE
// =========================================================================

const authenticate = (req, res, next) => {
  // Check cookie first, or fallback to header (optional, but we enforce cookie now for security)
  const token = req.cookies.auth_token;

  if (!token) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  const session = db.prepare(`
    SELECT s.*, u.id as user_id, u.username, u.role 
    FROM sessions s 
    JOIN users u ON s.user_id = u.id 
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);

  if (!session) {
    return res.status(401).json({ error: 'Session abgelaufen oder ungültig' });
  }

  req.user = {
    id: session.user_id,
    username: session.username,
    role: session.role
  };
  next();
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Berechtigung erforderlich' });
  }
  next();
};

// =========================================================================
// AUTH ROUTES
// =========================================================================

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    // Create session token
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

    db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expiresAt);

    // Clean up old sessions
    db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

    // Set HttpOnly Cookie
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: false, // Set to true if HTTPS is enabled (localhost is usually http)
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Serverfehler beim Login' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies.auth_token;
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.clearCookie('auth_token');
  res.json({ success: true });
});

// Get current user
app.get('/api/auth/me', authenticate, (req, res) => {
  res.json(req.user);
});

// Change own password
app.post('/api/auth/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Aktuelles und neues Passwort erforderlich' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Neues Passwort muss mindestens 6 Zeichen haben' });
    }

    // Verify current password
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const passwordValid = await bcrypt.compare(currentPassword, user.password_hash);

    if (!passwordValid) {
      return res.status(401).json({ error: 'Aktuelles Passwort ist falsch' });
    }

    // Update password
    const newHash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);

    res.json({ success: true, message: 'Passwort erfolgreich geändert' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Serverfehler beim Passwort ändern' });
  }
});

// =========================================================================
// SETTINGS ROUTES
// =========================================================================

app.get('/api/settings', authenticate, (req, res) => {
  const settings = db.prepare('SELECT key, value FROM settings').all();
  const settingsObj = {};
  settings.forEach(s => {
    settingsObj[s.key] = s.value;
  });
  res.json(settingsObj);
});

app.put('/api/settings', authenticate, requireAdmin, (req, res) => {
  const { year, bundesland } = req.body;

  if (year !== undefined) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(year), 'year');
  }
  if (bundesland !== undefined) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(bundesland, 'bundesland');
  }

  res.json({ success: true });
});

// =========================================================================
// ACTIVITY TYPES ROUTES
// =========================================================================

app.get('/api/activity-types', authenticate, (req, res) => {
  const types = db.prepare('SELECT * FROM activity_types ORDER BY sort_order').all();
  res.json(types);
});

app.post('/api/activity-types', authenticate, requireAdmin, (req, res) => {
  const { id, label, color } = req.body;

  if (!id || !label || !color) {
    return res.status(400).json({ error: 'id, label und color erforderlich' });
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM activity_types').get();
  const sortOrder = (maxOrder.max || 0) + 1;

  try {
    db.prepare('INSERT INTO activity_types (id, label, color, sort_order) VALUES (?, ?, ?, ?)').run(id, label, color, sortOrder);
    res.json({ id, label, color, sort_order: sortOrder });
  } catch (error) {
    res.status(400).json({ error: 'Aktivitätstyp existiert bereits' });
  }
});

app.put('/api/activity-types/:id', authenticate, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { label, color } = req.body;

  const updates = [];
  const values = [];

  if (label !== undefined) {
    updates.push('label = ?');
    values.push(label);
  }
  if (color !== undefined) {
    updates.push('color = ?');
    values.push(color);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Keine Änderungen angegeben' });
  }

  values.push(id);
  db.prepare(`UPDATE activity_types SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

app.delete('/api/activity-types/:id', authenticate, requireAdmin, (req, res) => {
  const { id } = req.params;

  // Check if type is in use
  const inUse = db.prepare('SELECT COUNT(*) as count FROM activities WHERE type_id = ?').get(id);
  if (inUse.count > 0) {
    return res.status(400).json({ error: 'Aktivitätstyp wird noch verwendet und kann nicht gelöscht werden' });
  }

  db.prepare('DELETE FROM activity_types WHERE id = ?').run(id);
  res.json({ success: true });
});

// =========================================================================
// LANDSCAPES ROUTES
// =========================================================================

app.get('/api/landscapes', authenticate, (req, res) => {
  const landscapes = db.prepare('SELECT * FROM landscapes ORDER BY sort_order').all();

  // Get SIDs and activities for each landscape
  const result = landscapes.map(landscape => {
    const sids = db.prepare('SELECT * FROM sids WHERE landscape_id = ? ORDER BY sort_order').all(landscape.id);

    const sidsWithActivities = sids.map(sid => {
      const activities = db.prepare('SELECT * FROM activities WHERE sid_id = ? ORDER BY start_date').all(sid.id);
      return {
        ...sid,
        isPRD: !!sid.is_prd,
        activities: activities.map(a => {
          // Get sub-activities for this activity
          const subActivities = db.prepare('SELECT * FROM sub_activities WHERE activity_id = ? ORDER BY sort_order').all(a.id);
          return {
            ...a,
            type: a.type_id,
            startDate: a.start_date,
            includesWeekend: !!a.includes_weekend,
            subActivities: subActivities.map(sa => ({
              id: sa.id,
              name: sa.name,
              startDate: sa.start_date,
              duration: sa.duration,
              includesWeekend: !!sa.includes_weekend,
              sort_order: sa.sort_order
            }))
          };
        })
      };
    });

    return {
      ...landscape,
      sids: sidsWithActivities
    };
  });

  res.json(result);
});

app.post('/api/landscapes', authenticate, requireAdmin, (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name erforderlich' });
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM landscapes').get();
  const sortOrder = (maxOrder.max || 0) + 1;

  const result = db.prepare('INSERT INTO landscapes (name, sort_order) VALUES (?, ?)').run(name, sortOrder);
  res.json({ id: result.lastInsertRowid, name, sort_order: sortOrder, sids: [] });
});

app.put('/api/landscapes/:id', authenticate, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name erforderlich' });
  }

  db.prepare('UPDATE landscapes SET name = ? WHERE id = ?').run(name, id);
  res.json({ success: true });
});

app.delete('/api/landscapes/:id', authenticate, requireAdmin, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM landscapes WHERE id = ?').run(id);
  res.json({ success: true });
});

// =========================================================================
// SIDS ROUTES
// =========================================================================

app.post('/api/sids', authenticate, requireAdmin, (req, res) => {
  const { landscape_id, name, is_prd } = req.body;

  if (!landscape_id) {
    return res.status(400).json({ error: 'landscape_id erforderlich' });
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM sids WHERE landscape_id = ?').get(landscape_id);
  const sortOrder = (maxOrder?.max || 0) + 1;

  const result = db.prepare('INSERT INTO sids (landscape_id, name, is_prd, sort_order) VALUES (?, ?, ?, ?)').run(
    landscape_id,
    name || '',
    is_prd ? 1 : 0,
    sortOrder
  );

  res.json({
    id: result.lastInsertRowid,
    landscape_id,
    name: name || '',
    isPRD: !!is_prd,
    sort_order: sortOrder,
    activities: []
  });
});

app.put('/api/sids/:id', authenticate, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { name, is_prd, notes } = req.body;

  const updates = [];
  const values = [];

  if (name !== undefined) {
    updates.push('name = ?');
    values.push(name);
  }
  if (is_prd !== undefined) {
    updates.push('is_prd = ?');
    values.push(is_prd ? 1 : 0);
  }
  if (notes !== undefined) {
    updates.push('notes = ?');
    values.push(notes.substring(0, 5000)); // Limit to 5000 chars
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Keine Änderungen angegeben' });
  }

  values.push(id);
  db.prepare(`UPDATE sids SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

app.delete('/api/sids/:id', authenticate, requireAdmin, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM sids WHERE id = ?').run(id);
  res.json({ success: true });
});

// =========================================================================
// ACTIVITIES ROUTES
// =========================================================================

app.post('/api/activities', authenticate, requireAdmin, (req, res) => {
  const { sid_id, type_id, start_date, duration, includes_weekend } = req.body;

  if (!sid_id || !type_id || !start_date) {
    return res.status(400).json({ error: 'sid_id, type_id und start_date erforderlich' });
  }

  const result = db.prepare(`
    INSERT INTO activities (sid_id, type_id, start_date, duration, includes_weekend) 
    VALUES (?, ?, ?, ?, ?)
  `).run(sid_id, type_id, start_date, duration || 1, includes_weekend ? 1 : 0);

  logAction(req.user.id, req.user.username, 'ACTIVITY_CREATE', { sid_id, type_id, start_date, duration });

  res.json({
    id: result.lastInsertRowid,
    sid_id,
    type: type_id,
    startDate: start_date,
    duration: duration || 1,
    includesWeekend: !!includes_weekend
  });
});

app.put('/api/activities/:id', authenticate, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { type_id, start_date, duration, includes_weekend } = req.body;

  const updates = [];
  const values = [];

  if (type_id !== undefined) {
    updates.push('type_id = ?');
    values.push(type_id);
  }
  if (start_date !== undefined) {
    updates.push('start_date = ?');
    values.push(start_date);
  }
  if (duration !== undefined) {
    updates.push('duration = ?');
    values.push(duration);
  }
  if (includes_weekend !== undefined) {
    updates.push('includes_weekend = ?');
    values.push(includes_weekend ? 1 : 0);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Keine Änderungen angegeben' });
  }

  values.push(id);
  db.prepare(`UPDATE activities SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

app.delete('/api/activities/:id', authenticate, requireAdmin, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM activities WHERE id = ?').run(id);
  res.json({ success: true });
});

// =========================================================================
// SUB-ACTIVITIES ROUTES
// =========================================================================

// Create sub-activity
app.post('/api/sub-activities', authenticate, requireAdmin, (req, res) => {
  const { activity_id, name, start_date, duration, includes_weekend } = req.body;

  if (!activity_id || !start_date) {
    return res.status(400).json({ error: 'activity_id und start_date erforderlich' });
  }

  // Verify parent activity exists
  const parentActivity = db.prepare('SELECT id, type_id FROM activities WHERE id = ?').get(activity_id);
  if (!parentActivity) {
    return res.status(404).json({ error: 'Übergeordnete Aktivität nicht gefunden' });
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM sub_activities WHERE activity_id = ?').get(activity_id);
  const sortOrder = (maxOrder?.max || 0) + 1;

  const result = db.prepare(`
    INSERT INTO sub_activities (activity_id, name, start_date, duration, includes_weekend, sort_order) 
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(activity_id, name || 'Sub-Aktivität', start_date, duration || 1, includes_weekend ? 1 : 0, sortOrder);

  logAction(req.user.id, req.user.username, 'SUBACTIVITY_CREATE', { activity_id, name, start_date, duration });

  res.json({
    id: result.lastInsertRowid,
    activity_id,
    name: name || 'Sub-Aktivität',
    startDate: start_date,
    duration: duration || 1,
    includesWeekend: !!includes_weekend,
    sort_order: sortOrder
  });
});

// Update sub-activity
app.put('/api/sub-activities/:id', authenticate, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { name, start_date, duration, includes_weekend } = req.body;

  const updates = [];
  const values = [];

  if (name !== undefined) {
    updates.push('name = ?');
    values.push(name);
  }
  if (start_date !== undefined) {
    updates.push('start_date = ?');
    values.push(start_date);
  }
  if (duration !== undefined) {
    updates.push('duration = ?');
    values.push(duration);
  }
  if (includes_weekend !== undefined) {
    updates.push('includes_weekend = ?');
    values.push(includes_weekend ? 1 : 0);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Keine Änderungen angegeben' });
  }

  values.push(id);
  db.prepare(`UPDATE sub_activities SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

// Delete sub-activity
app.delete('/api/sub-activities/:id', authenticate, requireAdmin, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM sub_activities WHERE id = ?').run(id);
  res.json({ success: true });
});

// =========================================================================
// USER MANAGEMENT ROUTES (Admin only)
// =========================================================================

app.get('/api/users', authenticate, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all();
  res.json(users);
});

app.post('/api/users', authenticate, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }

  if (role && !['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Ungültige Rolle' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
      username,
      passwordHash,
      role || 'user'
    );
    res.json({ id: result.lastInsertRowid, username, role: role || 'user' });
  } catch (error) {
    res.status(400).json({ error: 'Benutzername existiert bereits' });
  }
});

app.put('/api/users/:id', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { username, password, role } = req.body;

  const updates = [];
  const values = [];

  if (username !== undefined) {
    updates.push('username = ?');
    values.push(username);
  }
  if (password !== undefined) {
    const passwordHash = await bcrypt.hash(password, 10);
    updates.push('password_hash = ?');
    values.push(passwordHash);
  }
  if (role !== undefined) {
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Ungültige Rolle' });
    }
    updates.push('role = ?');
    values.push(role);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Keine Änderungen angegeben' });
  }

  values.push(id);
  try {
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: 'Benutzername existiert bereits' });
  }
});

app.delete('/api/users/:id', authenticate, requireAdmin, (req, res) => {
  const { id } = req.params;

  // Prevent deleting self
  if (parseInt(id) === req.user.id) {
    return res.status(400).json({ error: 'Sie können sich nicht selbst löschen' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ success: true });
});

// =========================================================================
// JSON IMPORT ROUTE
// =========================================================================

app.post('/api/import/json', authenticate, requireAdmin, (req, res) => {
  const data = req.body;

  if (!data) {
    return res.status(400).json({ error: 'JSON-Daten erforderlich' });
  }

  try {
    // Start transaction
    const transaction = db.transaction(() => {
      // Import settings
      if (data.year) {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(data.year), 'year');
      }
      if (data.bundesland) {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(data.bundesland, 'bundesland');
      }

      // Import activity types
      if (data.activityTypes && Array.isArray(data.activityTypes)) {
        // Clear existing types that are not in use
        const usedTypes = db.prepare('SELECT DISTINCT type_id FROM activities').all().map(r => r.type_id);
        db.prepare('DELETE FROM activity_types WHERE id NOT IN (SELECT DISTINCT type_id FROM activities)').run();

        const insertOrUpdateType = db.prepare(`
          INSERT INTO activity_types (id, label, color, sort_order) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET label = excluded.label, color = excluded.color, sort_order = excluded.sort_order
        `);

        data.activityTypes.forEach((type, index) => {
          insertOrUpdateType.run(type.id, type.label, type.color, index);
        });
      }

      // Import landscapes
      if (data.landscapes && Array.isArray(data.landscapes)) {
        // Clear existing data
        db.prepare('DELETE FROM activities').run();
        db.prepare('DELETE FROM sids').run();
        db.prepare('DELETE FROM landscapes').run();

        data.landscapes.forEach((landscape, landscapeIndex) => {
          const landscapeResult = db.prepare('INSERT INTO landscapes (name, sort_order) VALUES (?, ?)').run(
            landscape.name,
            landscapeIndex
          );
          const newLandscapeId = landscapeResult.lastInsertRowid;

          if (landscape.sids && Array.isArray(landscape.sids)) {
            landscape.sids.forEach((sid, sidIndex) => {
              const sidResult = db.prepare('INSERT INTO sids (landscape_id, name, is_prd, sort_order) VALUES (?, ?, ?, ?)').run(
                newLandscapeId,
                sid.name || '',
                sid.isPRD ? 1 : 0,
                sidIndex
              );
              const newSidId = sidResult.lastInsertRowid;

              if (sid.activities && Array.isArray(sid.activities)) {
                sid.activities.forEach(activity => {
                  db.prepare(`
                    INSERT INTO activities (sid_id, type_id, start_date, duration, includes_weekend) 
                    VALUES (?, ?, ?, ?, ?)
                  `).run(
                    newSidId,
                    activity.type,
                    activity.startDate,
                    activity.duration || 1,
                    activity.includesWeekend ? 1 : 0
                  );
                });
              }
            });
          }
        });
      }
    });

    transaction();
    res.json({ success: true, message: 'Daten erfolgreich importiert' });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Fehler beim Import: ' + error.message });
  }
});

// =========================================================================
// LOGS API
// =========================================================================

// Get logs (admin only)
// Get logs (admin only)
app.get('/api/logs', authenticate, requireAdmin, (req, res) => {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      res.json({ logs: content });
    } else {
      res.json({ logs: '' });
    }
  } catch (error) {
    console.error('Error reading logs:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Logs' });
  }
});

// =========================================================================
// MAINTENANCE SUNDAYS API
// =========================================================================

// Get all maintenance sundays
app.get('/api/maintenance-sundays', authenticate, (req, res) => {
  try {
    const sundays = db.prepare('SELECT id, date, label FROM maintenance_sundays ORDER BY id').all();
    res.json(sundays);
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Wartungssonntage' });
  }
});

// Update maintenance sunday (admin only)
app.put('/api/maintenance-sundays/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { date, label } = req.body;

    if (id < 1 || id > 4) {
      return res.status(400).json({ error: 'Ungültige Wartungssonntag-ID (1-4)' });
    }

    db.prepare('UPDATE maintenance_sundays SET date = ?, label = ? WHERE id = ?').run(date || '', label || '', id);

    logAction(req.user.id, req.user.username, 'MAINTENANCE_SUNDAY_UPDATE', { id, date, label });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Aktualisieren des Wartungssonntags' });
  }
});

// =========================================================================
// SERVE FRONTEND
// =========================================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'sap-planner.html'));
});

// =========================================================================
// START SERVER
// =========================================================================

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   SAP Basis Jahresplaner Server                              ║
║                                                               ║
║   Server läuft auf: http://localhost:${PORT}                   ║
║   Datenbank: ${path.basename(dbPath)}                                   ║
║                                                               ║
║   Standard-Login: admin / buek45$$d4R                         ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nServer wird beendet...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nServer wird beendet...');
  db.close();
  process.exit(0);
});
