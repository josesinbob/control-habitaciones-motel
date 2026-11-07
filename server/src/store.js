import { step, tick, manualTransitions, LIBRE, OCUPADA, LIMPIEZA } from './engine.js';
import { tx } from './db.js';

export const STATES = [LIBRE, OCUPADA, LIMPIEZA];

// Lógica de habitaciones sobre la base de datos. `onChange(room)` se llama
// cada vez que algo visible cambia, para avisar al panel en vivo.
export function createStore(db, cfg, onChange = () => {}) {
  const engineOpts = { minCleanMs: cfg.minCleanMs, curtainGraceMs: cfg.curtainGraceMs };
  const q = {
    roomByToken: db.prepare('SELECT * FROM rooms WHERE token = ?'),
    roomById: db.prepare('SELECT * FROM rooms WHERE id = ?'),
    allRooms: db.prepare('SELECT * FROM rooms'),
    pendingVacate: db.prepare("SELECT * FROM rooms WHERE state = 'ocupada' AND curtain_open_since IS NOT NULL"),
    updateRoom: db.prepare(`UPDATE rooms SET state = ?, state_since = ?, door = ?, curtain = ?, last_seen = ?,
      staff_entered_at = ?, paid_at = ?, curtain_open_since = ?, cycle_id = ? WHERE id = ?`),
    insertEvent: db.prepare('INSERT INTO events (room_id, ts, door, curtain, kind, user_id) VALUES (?, ?, ?, ?, ?, ?)'),
    insertCycle: db.prepare('INSERT INTO cycles (room_id, occupied_at, partial, manual) VALUES (?, ?, ?, ?)'),
    setPaid: db.prepare('UPDATE cycles SET paid_at = ? WHERE id = ? AND paid_at IS NULL'),
    setVacated: db.prepare('UPDATE cycles SET vacated_at = ?, manual = MAX(manual, ?) WHERE id = ?'),
    setNoEntry: db.prepare('UPDATE cycles SET vacated_at = ?, no_entry = 1 WHERE id = ?'),
    setCleanStart: db.prepare('UPDATE cycles SET clean_started_at = ? WHERE id = ?'),
    setCleanEnd: db.prepare('UPDATE cycles SET clean_ended_at = ?, manual = MAX(manual, ?) WHERE id = ?'),
  };

  const isOnline = (r, now) => r.last_seen != null && now - r.last_seen < cfg.offlineMs;
  const lastOnline = new Map(); // room_id -> bool, para detectar cuando un sensor deja de reportar

  function serialize(r, now = Date.now(), { withToken = false } = {}) {
    const out = {
      id: r.id,
      motel_id: r.motel_id,
      number: r.number,
      state: r.state,
      state_since: r.state_since,
      door: r.door,
      curtain: r.curtain,
      staff_entered_at: r.staff_entered_at,
      paid_at: r.paid_at,
      curtain_open_since: r.curtain_open_since,
      last_seen: r.last_seen,
      online: isOnline(r, now),
    };
    if (withToken) out.token = r.token;
    return out;
  }

  function applyTransitions(room, transitions, manual) {
    let cycleId = room.cycle_id;
    const m = manual ? 1 : 0;
    for (const t of transitions) {
      switch (t.type) {
        case 'occupied_start':
          cycleId = Number(q.insertCycle.run(room.id, t.at, t.partial ? 1 : 0, m).lastInsertRowid);
          break;
        case 'paid':
          if (cycleId != null) q.setPaid.run(t.at, cycleId);
          break;
        case 'vacated':
          if (cycleId == null) cycleId = Number(q.insertCycle.run(room.id, t.at, 1, m).lastInsertRowid);
          q.setVacated.run(t.at, m, cycleId);
          break;
        case 'left_without_entry':
          if (cycleId != null) q.setNoEntry.run(t.at, cycleId);
          cycleId = null;
          break;
        case 'cleaning_in':
          if (cycleId != null) q.setCleanStart.run(t.at, cycleId);
          break;
        case 'cleaning_end':
          if (cycleId != null) q.setCleanEnd.run(t.at, m, cycleId);
          cycleId = null;
          break;
        // curtain_reclosed, cleaning_short_visit: solo quedan en la bitácora
      }
    }
    return cycleId;
  }

  // Guarda el resultado del motor para una habitación.
  function save(room, res, { door, curtain, lastSeen, now, userId = null, kind = null, manual = false }) {
    const stateChanged = res.state !== room.state;
    const stateSince = res.state_since ?? (stateChanged || room.state_since == null ? now : room.state_since);
    tx(db, () => {
      const cycleId = applyTransitions(room, res.transitions, manual);
      q.updateRoom.run(res.state, stateSince, door, curtain, lastSeen,
        res.staff_entered_at ?? null, res.paid_at ?? null, res.curtain_open_since ?? null, cycleId, room.id);
      const sensorsChanged = room.door !== door || room.curtain !== curtain;
      if (sensorsChanged || res.transitions.length || kind) {
        const k = kind || res.transitions.map((t) => t.type).join(',') || 'sensor';
        q.insertEvent.run(room.id, now, door, curtain, k, userId);
      }
    });
    return q.roomById.get(room.id);
  }

  const visibleChange = (before, after) => ['state', 'door', 'curtain', 'paid_at', 'curtain_open_since', 'staff_entered_at']
    .some((k) => before[k] !== after[k]);

  /** Lectura de un ESP32. Devuelve la habitación actualizada o null si el token no existe. */
  function processReading(token, door, curtain, now = Date.now()) {
    const room = q.roomByToken.get(token);
    if (!room) return null;
    const wasOnline = isOnline(room, now);
    const res = step(room, { door, curtain }, now, engineOpts);
    const updated = save(room, res, { door, curtain, lastSeen: now, now });
    lastOnline.set(room.id, true);
    if (visibleChange(room, updated) || !wasOnline) onChange(serialize(updated, now));
    return updated;
  }

  /** Recepción corrige el estado desde el panel. */
  function forceState(roomId, target, userId, now = Date.now()) {
    if (!STATES.includes(target)) throw new Error('Estado inválido');
    const room = q.roomById.get(roomId);
    if (!room) return null;
    const transitions = manualTransitions(room.state, target, now);
    if (!transitions.length) return room;
    const res = {
      state: target, state_since: now, transitions,
      staff_entered_at: null, curtain_open_since: null, paid_at: target === OCUPADA ? now : null,
    };
    const updated = save(room, res, {
      door: room.door, curtain: room.curtain, lastSeen: room.last_seen, now,
      userId, kind: `manual:${target}`, manual: true,
    });
    onChange(serialize(updated, now));
    return updated;
  }

  /** Llamar cada pocos segundos: confirma salidas y avisa cuando un sensor deja de reportar. */
  function sweep(now = Date.now()) {
    for (const room of q.pendingVacate.all()) {
      const res = tick(room, now, engineOpts);
      if (!res) continue;
      const updated = save(room, res, { door: room.door, curtain: room.curtain, lastSeen: room.last_seen, now });
      onChange(serialize(updated, now));
    }
    for (const r of q.allRooms.all()) {
      const online = isOnline(r, now);
      const prev = lastOnline.get(r.id);
      if (prev !== undefined && prev !== online) onChange(serialize(r, now));
      lastOnline.set(r.id, online);
    }
  }

  return { processReading, forceState, sweep, serialize };
}
