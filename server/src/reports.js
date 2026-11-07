// Reportes a partir de la tabla `cycles`. Todas las fechas se interpretan en la
// zona horaria del motel, no la del servidor.

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

function parts(ts, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(ts).map((x) => [x.type, x.value]));
  return p;
}

function offsetMs(ts, tz) {
  const p = parts(ts, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** 'YYYY-MM-DD' a medianoche en `tz` -> epoch ms */
export function dayStart(dateStr, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) throw new Error('Fecha inválida, usa AAAA-MM-DD');
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  let t = guess - offsetMs(guess, tz);
  const off2 = offsetMs(t, tz);
  if (guess - off2 !== t) t = guess - off2;
  return t;
}

export function dayKey(ts, tz) {
  const p = parts(ts, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localDateTime(ts, tz) {
  if (ts == null) return '';
  const p = parts(ts, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const minutes = (a, b) => (a != null && b != null && b >= a ? (b - a) / 60000 : null);

// charge: entrada -> cobro (se abrió la puerta)
// occupied: entrada -> salida del cliente
// ready: salida del cliente -> habitación lista (espera + limpieza)
export function cycleDurations(c) {
  if (c.no_entry) return { charge: null, occupied: null, ready: null };
  return {
    charge: c.partial ? null : minutes(c.occupied_at, c.paid_at),
    occupied: c.partial ? null : minutes(c.occupied_at, c.vacated_at),
    ready: minutes(c.vacated_at, c.clean_ended_at),
  };
}

function summarize(cycles) {
  const acc = { uses: 0, noEntry: 0, charge: [], occ: [], ready: [] };
  for (const c of cycles) {
    if (c.no_entry) { acc.noEntry++; continue; }
    if (!c.partial) acc.uses++;
    const d = cycleDurations(c);
    if (d.charge != null) acc.charge.push(d.charge);
    if (d.occupied != null) acc.occ.push(d.occupied);
    if (d.ready != null && !c.manual) acc.ready.push(d.ready);
  }
  const avg = (xs) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const sum = (xs) => round(xs.reduce((a, b) => a + b, 0));
  return {
    uses: acc.uses,
    no_entry: acc.noEntry,
    charge_avg_min: avg(acc.charge),
    occupied_avg_min: avg(acc.occ),
    occupied_total_min: sum(acc.occ),
    ready_avg_min: avg(acc.ready),
  };
}

const round = (x) => Math.round(x * 10) / 10;

export function loadCycles(db, motelId, fromMs, toMs) {
  return db.prepare(`
    SELECT c.*, r.number AS room_number
    FROM cycles c JOIN rooms r ON r.id = c.room_id
    WHERE r.motel_id = ? AND c.occupied_at >= ? AND c.occupied_at < ?
    ORDER BY c.occupied_at`).all(motelId, fromMs, toMs);
}

export function buildReport(db, motel, fromStr, toStr) {
  const fromMs = dayStart(fromStr, motel.tz);
  const toMs = dayStart(toStr, motel.tz) + 24 * 3600 * 1000; // `to` incluido
  if (toMs <= fromMs) throw new Error('El rango de fechas está invertido');
  const cycles = loadCycles(db, motel.id, fromMs, toMs);

  const rooms = db.prepare('SELECT id, number FROM rooms WHERE motel_id = ?').all(motel.id)
    .sort((a, b) => a.number.localeCompare(b.number, 'es', { numeric: true }));
  const byRoom = rooms.map((r) => ({
    room_id: r.id, number: r.number,
    ...summarize(cycles.filter((c) => c.room_id === r.id)),
  }));

  const days = new Map();
  for (const c of cycles) {
    const k = dayKey(c.occupied_at, motel.tz);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(c);
  }
  const byDay = [...days.keys()].sort().map((k) => ({ day: k, ...summarize(days.get(k)) }));

  const byHour = Array.from({ length: 24 }, () => 0);
  for (const c of cycles) if (!c.partial && !c.no_entry) byHour[+parts(c.occupied_at, motel.tz).hour]++;

  return { from: fromStr, to: toStr, tz: motel.tz, total: summarize(cycles), byRoom, byDay, byHour };
}

export function cyclesCsv(db, motel, fromStr, toStr) {
  const fromMs = dayStart(fromStr, motel.tz);
  const toMs = dayStart(toStr, motel.tz) + 24 * 3600 * 1000;
  const cycles = loadCycles(db, motel.id, fromMs, toMs);
  const head = ['Habitación', 'Entrada (cortina cerrada)', 'Cobro (puerta abierta)', 'Salida cliente',
    'Lista (puerta cerrada)', 'Minutos para cobrar', 'Minutos en uso', 'Minutos hasta quedar lista',
    'Entró sin pasar', 'Parcial', 'Manual'];
  const fmt = (x) => (x == null ? '' : String(round(x)));
  const esc = (v) => (/[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [head.join(',')];
  for (const c of cycles) {
    const d = cycleDurations(c);
    lines.push([
      c.room_number,
      localDateTime(c.occupied_at, motel.tz),
      localDateTime(c.paid_at, motel.tz),
      localDateTime(c.vacated_at, motel.tz),
      localDateTime(c.clean_ended_at, motel.tz),
      fmt(d.charge), fmt(d.occupied), fmt(d.ready),
      c.no_entry ? 'sí' : '', c.partial ? 'sí' : '', c.manual ? 'sí' : '',
    ].map((v) => esc(String(v))).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM para que Excel lea acentos
}
