import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
export const DB_FILE = path.join(DATA_DIR, 'moteles.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS motels (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  tz          TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id               INTEGER PRIMARY KEY,
  motel_id         INTEGER NOT NULL REFERENCES motels(id) ON DELETE CASCADE,
  number           TEXT NOT NULL,
  token            TEXT NOT NULL UNIQUE,
  state            TEXT NOT NULL DEFAULT 'libre',
  state_since      INTEGER,
  door             INTEGER,
  curtain          INTEGER,
  last_seen        INTEGER,
  staff_entered_at INTEGER,
  cycle_id         INTEGER,
  UNIQUE (motel_id, number)
);

-- Un ciclo = una ocupación completa: entrada, salida, limpieza.
CREATE TABLE IF NOT EXISTS cycles (
  id               INTEGER PRIMARY KEY,
  room_id          INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  occupied_at      INTEGER NOT NULL,
  vacated_at       INTEGER,
  clean_started_at INTEGER,
  clean_ended_at   INTEGER,
  partial          INTEGER NOT NULL DEFAULT 0,  -- no vimos el inicio real (arranque o corrección manual)
  manual           INTEGER NOT NULL DEFAULT 0   -- alguien forzó el estado desde el panel
);
CREATE INDEX IF NOT EXISTS idx_cycles_room_time ON cycles(room_id, occupied_at);

-- Bitácora cruda de sensores y transiciones, para auditar.
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY,
  room_id  INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  ts       INTEGER NOT NULL,
  door     INTEGER,
  curtain  INTEGER,
  kind     TEXT NOT NULL,
  user_id  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_room_time ON events(room_id, ts);

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'viewer')),
  pass_hash   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_motels (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  motel_id  INTEGER NOT NULL REFERENCES motels(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, motel_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
`;

export function openDb(file = DB_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columnas agregadas después de la primera versión: se añaden si faltan,
// así una base de datos existente se actualiza sola.
function migrate(db) {
  const add = (table, column, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  };
  add('rooms', 'paid_at', 'INTEGER');            // cuándo se abrió la puerta (cobro) en la ocupación actual
  add('rooms', 'curtain_open_since', 'INTEGER'); // cortina abierta, esperando confirmar la salida
  add('cycles', 'paid_at', 'INTEGER');
  add('cycles', 'no_entry', 'INTEGER NOT NULL DEFAULT 0'); // el carro entró y salió sin pasar
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
