import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import pg from 'pg';

export async function createStore({ url, sqlitePath = 'data/parcelpass.db' } = {}) {
  let pool, sqlite;
  if (url) pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10000 });
  else {
    if (sqlitePath !== ':memory:') mkdirSync('data', { recursive: true });
    sqlite = new DatabaseSync(sqlitePath);
    sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  }
  const query = async (sql, args = []) => {
    if (pool) return pool.query(sql, args);
    const ordered = [];
    const converted = sql.replace(/\$(\d+)/g, (_, n) => { ordered.push(args[Number(n) - 1]); return '?'; });
    const stmt = sqlite.prepare(converted);
    if (/^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql)) return { rows: stmt.all(...ordered) };
    const result = stmt.run(...ordered);
    return { rows: [], rowCount: Number(result.changes) };
  };
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS parcels (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, courier TEXT NOT NULL, tracking TEXT NOT NULL, expected_date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('expected','out_for_delivery','received')), notes TEXT NOT NULL DEFAULT '', received_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1)`,
    `CREATE INDEX IF NOT EXISTS parcels_owner_idx ON parcels(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)`
  ];
  for (const sql of statements) await query(sql);
  return { query, close: async () => pool ? pool.end() : sqlite.close() };
}
