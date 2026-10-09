import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', '..', 'data', 'transcribe.db');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db: Database.Database = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

try {
  const schemaPath = path.join(__dirname, 'schema.sql');
  db.exec(fs.readFileSync(schemaPath, 'utf-8'));
  console.log('✅ Schema loaded');
} catch (err: any) {
  console.error('❌ Schema error:', err?.message);
}

// Seed test users if not exist
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get('free@test.com');
if (!existing) {
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('password123', 10);

  const u1 = db.prepare('INSERT INTO users (email, password, plan) VALUES (?, ?, ?)').run('free@test.com', hash, 'free');
  db.prepare('INSERT INTO api_keys (key, user_id, plan, limit_hr, label) VALUES (?, ?, ?, ?, ?)').run('test-key-free-123', u1.lastInsertRowid, 'free', 10, 'Test Free');

  const u2 = db.prepare('INSERT INTO users (email, password, plan) VALUES (?, ?, ?)').run('premium@test.com', hash, 'premium');
  db.prepare('INSERT INTO api_keys (key, user_id, plan, limit_hr, label) VALUES (?, ?, ?, ?, ?)').run('test-key-premium-456', u2.lastInsertRowid, 'premium', 100, 'Test Premium');

  console.log('✅ Test users seeded');
}

console.log(`✅ DB ready: ${DB_PATH} (WAL)`);
export default db;
