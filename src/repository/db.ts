import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id           TEXT PRIMARY KEY,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'processing', 'classified', 'failed')),
  category     TEXT CHECK (category IN ('billing', 'technical', 'account', 'other')),
  priority     TEXT CHECK (priority IN ('low', 'medium', 'high')),
  summary      TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  lease_until  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK (status != 'classified'
         OR (category IS NOT NULL AND priority IS NOT NULL AND summary IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_tickets_filters
  ON tickets (category, priority, created_at, id);

CREATE INDEX IF NOT EXISTS idx_tickets_status
  ON tickets (status, created_at, id);
`;


export function openDB(path: string): DB {
    const db = Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000"); // wait instead of failing if the db is locked 
    db.exec(SCHEMA);
    return db;
}