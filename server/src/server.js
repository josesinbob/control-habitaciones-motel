import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.js';
import { createStore, STATES } from './store.js';
import { buildReport, cyclesCsv } from './reports.js';
import {
  hashPassword, verifyPassword, randomToken, sha256, deviceToken, randomPassword,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const cfg = {
  port: Number(process.env.PORT) || 3000,
  minCleanMs: (Number(process.env.MIN_CLEAN_SECONDS) || 90) * 1000,
  curtainGraceMs: (Number(process.env.CURTAIN_GRACE_SECONDS ?? 180)) * 1000,
  offlineMs: (Number(process.env.OFFLINE_SECONDS) || 90) * 1000,
  sessionMs: (Number(process.env.SESSION_HOURS) || 12) * 3600 * 1000,
  secureCookie: process.env.COOKIE_SECURE === '1',
};
const DEFAULT_TZ = process.env.TZ_DEFAULT || Intl.DateTimeFormat().resolvedOptions().timeZone;

const db = openDb();

// ---------- Tiempo real (Server-Sent Events) ----------
const subscribers = new Map(); // motel_id -> Set<res>
function broadcast(room) {
  const subs = subscribers.get(room.motel_id);
  if (!subs) return;
  const msg = `event: room\ndata: ${JSON.stringify(room)}\n\n`;
  for (const res of subs) res.write(msg);
}
setInterval(() => {
  for (const subs of subscribers.values()) for (const res of subs) res.write(': ping\n\n');
}, 25_000).unref();

const store = createStore(db, cfg, broadcast);
setInterval(() => store.sweep(), 5_000).unref();
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600_000).unref();

// ---------- Primer arranque: crear administrador ----------
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const email = process.env.ADMIN_EMAIL || 'admin@motel.local';
  const password = process.env.ADMIN_PASSWORD || randomPassword();
  db.prepare('INSERT INTO users (email, name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(email, 'Administrador', 'admin', hashPassword(password), Date.now());
  console.log('\n=============================================');
  console.log(' Usuario administrador creado (anótalo):');
  console.log(`   correo:     ${email}`);
  console.log(`   contraseña: ${password}`);
  console.log('=============================================\n');
}

// ---------- Utilidades HTTP ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) { reject(new HttpError(413, 'Cuerpo demasiado grande')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(bad('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(value, maxAgeSec) {
  return `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${cfg.secureCookie ? '; Secure' : ''}`;
}

function currentUser(req) {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(sid), Date.now());
  return row ? { ...row } : null;
}

function motelIdsFor(user) {
  if (user.role === 'admin') return db.prepare('SELECT id FROM motels').all().map((r) => r.id);
  return db.prepare('SELECT motel_id FROM user_motels WHERE user_id = ?').all(user.id).map((r) => r.motel_id);
}

function requireMotel(user, motelId) {
  const motel = db.prepare('SELECT * FROM motels WHERE id = ?').get(motelId);
  if (!motel || !motelIdsFor(user).includes(motel.id)) throw new HttpError(404, 'Motel no encontrado');
  return motel;
}

function requireRoom(user, roomId) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) throw new HttpError(404, 'Habitación no encontrada');
  requireMotel(user, room.motel_id);
  return room;
}

function validTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

const sortRooms = (rooms) => rooms.sort((a, b) => a.number.localeCompare(b.number, 'es', { numeric: true }));

// Límite simple de intentos fallidos de login por IP (se borra al entrar bien).
const loginAttempts = new Map();
function checkLoginRate(ip) {
  const a = loginAttempts.get(ip);
  if (a && a.until > Date.now() && a.count >= 10) throw new HttpError(429, 'Demasiados intentos fallidos, espera 5 minutos');
}
function recordLoginFailure(ip) {
  const now = Date.now();
  const a = loginAttempts.get(ip);
  if (!a || a.until <= now) loginAttempts.set(ip, { count: 1, until: now + 5 * 60_000 });
  else a.count++;
}

// ---------- Rutas ----------
// auth: 'none' | 'device' | 'user' | 'manager' | 'admin'
const routes = [];
const route = (method, pattern, auth, handler) =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/:(\w+)/g, '(?<$1>\\d+)')}$`), auth, handler });

// --- Dispositivos (ESP32) ---
route('POST', '/api/device/reading', 'device', ({ req, body }) => {
  const token = req.headers['x-device-token'];
  const door = Number(body.door);
  const curtain = Number(body.curtain);
  if (![0, 1].includes(door) || ![0, 1].includes(curtain)) throw bad('door y curtain deben ser 0 o 1');
  const room = store.processReading(String(token || ''), door, curtain);
  if (!room) throw new HttpError(401, 'Token de dispositivo desconocido');
  return { ok: true, room: room.number, state: room.state, now: Date.now() };
});

// --- Sesión ---
route('POST', '/api/login', 'none', ({ req, res, body }) => {
  checkLoginRate(req.socket.remoteAddress);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(body.email || '').trim());
  if (!user || !verifyPassword(String(body.password || ''), user.pass_hash)) {
    recordLoginFailure(req.socket.remoteAddress);
    throw new HttpError(401, 'Correo o contraseña incorrectos');
  }
  loginAttempts.delete(req.socket.remoteAddress);
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), user.id, Date.now() + cfg.sessionMs);
  res.setHeader('Set-Cookie', sessionCookie(token, cfg.sessionMs / 1000));
  return { id: user.id, email: user.email, name: user.name, role: user.role };
});

route('POST', '/api/logout', 'none', ({ req, res }) => {
  const sid = cookies(req).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(sid));
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
});

route('GET', '/api/me', 'user', ({ user }) => user);

route('POST', '/api/me/password', 'user', ({ user, body }) => {
  const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(user.id);
  if (!verifyPassword(String(body.current || ''), row.pass_hash)) throw bad('La contraseña actual no es correcta');
  if (String(body.password || '').length < 8) throw bad('La nueva contraseña debe tener al menos 8 caracteres');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(body.password), user.id);
  return { ok: true };
});

// --- Moteles y habitaciones ---
route('GET', '/api/motels', 'user', ({ user }) => {
  const ids = motelIdsFor(user);
  return db.prepare('SELECT * FROM motels ORDER BY name').all().filter((m) => ids.includes(m.id));
});

route('POST', '/api/motels', 'admin', ({ body }) => {
  const name = String(body.name || '').trim();
  const tz = String(body.tz || DEFAULT_TZ);
  if (!name) throw bad('Falta el nombre');
  if (!validTz(tz)) throw bad('Zona horaria inválida');
  const r = db.prepare('INSERT INTO motels (name, tz, created_at) VALUES (?, ?, ?)').run(name, tz, Date.now());
  return db.prepare('SELECT * FROM motels WHERE id = ?').get(r.lastInsertRowid);
});

route('PATCH', '/api/motels/:id', 'admin', ({ user, params, body }) => {
  const motel = requireMotel(user, +params.id);
  const name = body.name != null ? String(body.name).trim() : motel.name;
  const tz = body.tz != null ? String(body.tz) : motel.tz;
  if (!name) throw bad('Falta el nombre');
  if (!validTz(tz)) throw bad('Zona horaria inválida');
  db.prepare('UPDATE motels SET name = ?, tz = ? WHERE id = ?').run(name, tz, motel.id);
  return db.prepare('SELECT * FROM motels WHERE id = ?').get(motel.id);
});

route('DELETE', '/api/motels/:id', 'admin', ({ user, params }) => {
  const motel = requireMotel(user, +params.id);
  db.prepare('DELETE FROM motels WHERE id = ?').run(motel.id);
  return { ok: true };
});

route('GET', '/api/motels/:id/rooms', 'user', ({ user, params }) => {
  const motel = requireMotel(user, +params.id);
  const now = Date.now();
  const withToken = user.role === 'admin';
  const rooms = db.prepare('SELECT * FROM rooms WHERE motel_id = ?').all(motel.id)
    .map((r) => store.serialize(r, now, { withToken }));
  return { now, rooms: sortRooms(rooms) };
});

route('POST', '/api/motels/:id/rooms', 'admin', ({ user, params, body }) => {
  const motel = requireMotel(user, +params.id);
  let numbers = [];
  if (Array.isArray(body.numbers)) numbers = body.numbers.map((n) => String(n).trim()).filter(Boolean);
  else if (body.from != null && body.to != null) {
    const from = parseInt(body.from, 10);
    const to = parseInt(body.to, 10);
    if (!(from >= 0 && to >= from && to - from < 500)) throw bad('Rango inválido');
    for (let n = from; n <= to; n++) numbers.push(String(n));
  }
  if (!numbers.length) throw bad('Indica el número de habitación o un rango');
  const existing = new Set(db.prepare('SELECT number FROM rooms WHERE motel_id = ?').all(motel.id).map((r) => r.number));
  const insert = db.prepare('INSERT INTO rooms (motel_id, number, token) VALUES (?, ?, ?)');
  const created = tx(db, () => numbers.filter((n) => !existing.has(n)).map((n) => {
    insert.run(motel.id, n, deviceToken());
    return n;
  }));
  return { created, skipped: numbers.filter((n) => existing.has(n)) };
});

route('DELETE', '/api/rooms/:id', 'admin', ({ user, params }) => {
  const room = requireRoom(user, +params.id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  return { ok: true };
});

route('POST', '/api/rooms/:id/token', 'admin', ({ user, params }) => {
  const room = requireRoom(user, +params.id);
  const token = deviceToken();
  db.prepare('UPDATE rooms SET token = ? WHERE id = ?').run(token, room.id);
  return { token };
});

route('POST', '/api/rooms/:id/state', 'manager', ({ user, params, body }) => {
  const room = requireRoom(user, +params.id);
  if (!STATES.includes(body.state)) throw bad('Estado inválido');
  return store.serialize(store.forceState(room.id, body.state, user.id));
});

route('GET', '/api/rooms/:id/events', 'user', ({ user, params }) => {
  const room = requireRoom(user, +params.id);
  return db.prepare(`SELECT e.ts, e.door, e.curtain, e.kind, u.name AS user_name
    FROM events e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.room_id = ? ORDER BY e.ts DESC LIMIT 100`).all(room.id);
});

route('GET', '/api/motels/:id/stream', 'user', ({ user, params, req, res }) => {
  const motel = requireMotel(user, +params.id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  if (!subscribers.has(motel.id)) subscribers.set(motel.id, new Set());
  subscribers.get(motel.id).add(res);
  req.on('close', () => subscribers.get(motel.id)?.delete(res));
  return undefined; // la respuesta queda abierta
});

// --- Reportes ---
route('GET', '/api/motels/:id/report', 'user', ({ user, params, url }) => {
  const motel = requireMotel(user, +params.id);
  try { return buildReport(db, motel, url.searchParams.get('from'), url.searchParams.get('to')); }
  catch (e) { throw bad(e.message); }
});

route('GET', '/api/motels/:id/report.csv', 'user', ({ user, params, url, res }) => {
  const motel = requireMotel(user, +params.id);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  let csv;
  try { csv = cyclesCsv(db, motel, from, to); } catch (e) { throw bad(e.message); }
  const file = `${motel.name.replace(/[^\w-]+/g, '_')}_${from}_a_${to}.csv`;
  send(res, 200, csv, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${file}"`,
  });
  return undefined;
});

// --- Usuarios (solo admin) ---
function userWithMotels(id) {
  const u = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(id);
  if (!u) return null;
  return { ...u, motel_ids: db.prepare('SELECT motel_id FROM user_motels WHERE user_id = ?').all(id).map((r) => r.motel_id) };
}

function setUserMotels(userId, motelIds) {
  if (!Array.isArray(motelIds)) return;
  const valid = new Set(db.prepare('SELECT id FROM motels').all().map((m) => m.id));
  db.prepare('DELETE FROM user_motels WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO user_motels (user_id, motel_id) VALUES (?, ?)');
  for (const id of new Set(motelIds.map(Number))) if (valid.has(id)) ins.run(userId, id);
}

const ROLES = ['admin', 'manager', 'viewer'];

route('GET', '/api/users', 'admin', () =>
  db.prepare('SELECT id FROM users ORDER BY name').all().map((u) => userWithMotels(u.id)));

route('POST', '/api/users', 'admin', ({ body }) => {
  const email = String(body.email || '').trim();
  const name = String(body.name || '').trim();
  const role = String(body.role || 'viewer');
  const password = String(body.password || '');
  if (!/^\S+@\S+$/.test(email)) throw bad('Correo inválido');
  if (!name) throw bad('Falta el nombre');
  if (!ROLES.includes(role)) throw bad('Rol inválido');
  if (password.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw bad('Ya existe un usuario con ese correo');
  const id = tx(db, () => {
    const r = db.prepare('INSERT INTO users (email, name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(email, name, role, hashPassword(password), Date.now());
    setUserMotels(Number(r.lastInsertRowid), body.motel_ids);
    return Number(r.lastInsertRowid);
  });
  return userWithMotels(id);
});

route('PATCH', '/api/users/:id', 'admin', ({ user, params, body }) => {
  const target = userWithMotels(+params.id);
  if (!target) throw new HttpError(404, 'Usuario no encontrado');
  const name = body.name != null ? String(body.name).trim() : target.name;
  const role = body.role != null ? String(body.role) : target.role;
  if (!name) throw bad('Falta el nombre');
  if (!ROLES.includes(role)) throw bad('Rol inválido');
  if (target.id === user.id && role !== 'admin') throw bad('No puedes quitarte el rol de administrador');
  tx(db, () => {
    db.prepare('UPDATE users SET name = ?, role = ? WHERE id = ?').run(name, role, target.id);
    if (body.password) {
      if (String(body.password).length < 8) throw bad('La contraseña debe tener al menos 8 caracteres');
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), target.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    }
    setUserMotels(target.id, body.motel_ids);
  });
  return userWithMotels(target.id);
});

route('DELETE', '/api/users/:id', 'admin', ({ user, params }) => {
  if (+params.id === user.id) throw bad('No puedes eliminar tu propio usuario');
  db.prepare('DELETE FROM users WHERE id = ?').run(+params.id);
  return { ok: true };
});

route('GET', '/api/health', 'none', () => ({ ok: true, now: Date.now() }));

// ---------- Archivos estáticos ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Prohibido');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'No encontrado');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- Servidor ----------
const ROLE_RANK = { viewer: 1, manager: 2, admin: 3 };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido');
      return serveStatic(req, res, url.pathname);
    }

    let match = null;
    let r = null;
    for (const candidate of routes) {
      if (candidate.method !== req.method) continue;
      match = candidate.re.exec(url.pathname);
      if (match) { r = candidate; break; }
    }
    if (!r) throw new HttpError(404, 'Ruta no encontrada');

    // Las peticiones que modifican datos deben ser JSON: evita envíos desde formularios de otros sitios.
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) {
      throw new HttpError(415, 'Se espera application/json');
    }

    let user = null;
    if (r.auth !== 'none' && r.auth !== 'device') {
      user = currentUser(req);
      if (!user) throw new HttpError(401, 'Inicia sesión');
      const need = { user: 1, manager: 2, admin: 3 }[r.auth];
      if (ROLE_RANK[user.role] < need) throw new HttpError(403, 'No tienes permiso para esto');
    }

    const body = req.method === 'GET' ? {} : await readBody(req);
    const out = await r.handler({ req, res, url, body, user, params: match.groups || {} });
    if (out !== undefined && !res.headersSent) send(res, 200, out);
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: 'Error interno del servidor' });
  }
});

server.listen(cfg.port, () => {
  console.log(`Sistema de moteles escuchando en http://0.0.0.0:${cfg.port}`);
});
