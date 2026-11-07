// Demo para GitHub Pages: reemplaza el servidor con datos simulados en el navegador.
// Intercepta fetch('/api/...') y EventSource. Nada se guarda ni sale de esta página.
(() => {
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  const now0 = Date.now();
  const rand = (a, b) => a + Math.random() * (b - a);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const motel = { id: 1, name: 'Motel Demo', tz, created_at: now0 };
  const user = { id: 1, email: 'demo@ejemplo.com', name: 'Usuario demo', role: 'admin' };
  const users = [
    { ...user, created_at: now0, motel_ids: [1] },
    { id: 2, email: 'recepcion@ejemplo.com', name: 'Recepción', role: 'manager', created_at: now0, motel_ids: [1] },
  ];

  // ---------- historial simulado ----------
  const cycles = [];
  for (let id = 1; id <= 17; id++) {
    let t = now0 - 30 * DAY + rand(0, 120) * MIN;
    for (;;) {
      const occupied_at = t;
      if (Math.random() < 0.03) {
        const left = occupied_at + rand(2, 8) * MIN;
        cycles.push({ room_id: id, occupied_at, vacated_at: left, no_entry: 1 });
        t = left + rand(10, 120) * MIN;
        continue;
      }
      const paid_at = occupied_at + rand(1, 6) * MIN;
      const vacated_at = occupied_at + rand(60, 240) * MIN;
      const clean_ended_at = vacated_at + rand(15, 55) * MIN;
      if (clean_ended_at > now0 - 30 * MIN) break;
      cycles.push({ room_id: id, occupied_at, paid_at, vacated_at, clean_ended_at, no_entry: 0 });
      t = clean_ended_at + rand(10, 300) * MIN;
    }
  }
  cycles.sort((a, b) => a.occupied_at - b.occupied_at);

  // ---------- habitaciones en vivo ----------
  const makeRoom = (id) => {
    const r = {
      id, motel_id: 1, number: String(id), token: `demo-token-${id}`, state: 'libre',
      state_since: now0 - rand(5, 180) * MIN, door: 1, curtain: 0,
      staff_entered_at: null, paid_at: null, curtain_open_since: null,
      last_seen: now0, online: true,
    };
    const dice = id % 5;
    if (dice === 1 || dice === 3) {
      Object.assign(r, { state: 'ocupada', state_since: now0 - rand(20, 200) * MIN, curtain: 1 });
      r.paid_at = r.state_since + 3 * MIN;
    } else if (dice === 2) {
      Object.assign(r, { state: 'limpieza', state_since: now0 - rand(4, 30) * MIN, door: 0 });
    }
    return r;
  };
  const rooms = new Map(Array.from({ length: 17 }, (_, i) => [i + 1, makeRoom(i + 1)]));
  // Casos que conviene ver en el panel:
  Object.assign(rooms.get(4), { state: 'ocupada', state_since: now0 - 3 * MIN, curtain: 1, door: 1, paid_at: null });
  Object.assign(rooms.get(9), { state: 'ocupada', state_since: now0 - 14 * MIN, curtain: 1, door: 1, paid_at: null });
  Object.assign(rooms.get(7), { state: 'limpieza', state_since: now0 - 52 * MIN, curtain: 0, door: 0, paid_at: null });
  Object.assign(rooms.get(12), { online: false, last_seen: now0 - 40 * MIN });

  const liveEvents = new Map();
  const log = (r, kind) => {
    if (!liveEvents.has(r.id)) liveEvents.set(r.id, []);
    liveEvents.get(r.id).unshift({ ts: Date.now(), door: r.door, curtain: r.curtain, kind, user_name: kind.startsWith('manual') ? user.name : null });
  };

  const streams = new Set();
  const publish = (r) => {
    const { token, ...pub } = r;
    for (const s of streams) s._emit('room', JSON.stringify(pub));
  };

  // Cada pocos segundos, una habitación avanza un paso del ciclo.
  function advance(r) {
    const t = Date.now();
    if (r.state === 'libre') {
      Object.assign(r, { state: 'ocupada', state_since: t, curtain: 1, door: 1, paid_at: null, curtain_open_since: null });
      log(r, 'occupied_start');
    } else if (r.state === 'ocupada' && r.paid_at == null) {
      Object.assign(r, { paid_at: t, door: 0 });
      log(r, 'paid');
    } else if (r.state === 'ocupada' && r.curtain_open_since == null) {
      Object.assign(r, { curtain: 0, door: 0, curtain_open_since: t });
      log(r, 'sensor');
    } else if (r.state === 'ocupada') {
      Object.assign(r, { state: 'limpieza', state_since: r.curtain_open_since, curtain_open_since: null, paid_at: null });
      log(r, 'vacated');
    } else {
      Object.assign(r, { state: 'libre', state_since: t, door: 1 });
      log(r, 'cleaning_end');
    }
    r.last_seen = t;
    publish(r);
  }
  setInterval(() => {
    const live = [...rooms.values()].filter((r) => r.online);
    advance(live[Math.floor(Math.random() * live.length)]);
    for (const r of live) r.last_seen = Date.now();
  }, 5000);

  // ---------- reportes ----------
  const round = (x) => Math.round(x * 10) / 10;
  const mins = (a, b) => (a != null && b != null && b >= a ? (b - a) / MIN : null);
  const avg = (xs) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

  function summarize(list) {
    const charge = []; const occ = []; const ready = [];
    let uses = 0; let noEntry = 0;
    for (const c of list) {
      if (c.no_entry) { noEntry++; continue; }
      uses++;
      charge.push(mins(c.occupied_at, c.paid_at));
      occ.push(mins(c.occupied_at, c.vacated_at));
      ready.push(mins(c.vacated_at, c.clean_ended_at));
    }
    return {
      uses, no_entry: noEntry,
      charge_avg_min: avg(charge), occupied_avg_min: avg(occ),
      occupied_total_min: round(occ.reduce((a, b) => a + b, 0)), ready_avg_min: avg(ready),
    };
  }

  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dayStart = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const inRange = (from, to) => cycles.filter((c) => c.occupied_at >= dayStart(from) && c.occupied_at < dayStart(to) + DAY);

  function report(from, to) {
    const list = inRange(from, to);
    const days = new Map();
    for (const c of list) {
      const k = dayKey(c.occupied_at);
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(c);
    }
    const byHour = Array.from({ length: 24 }, () => 0);
    for (const c of list) if (!c.no_entry) byHour[new Date(c.occupied_at).getHours()]++;
    return {
      from, to, tz, total: summarize(list), byHour,
      byRoom: [...rooms.values()].map((r) => ({ room_id: r.id, number: r.number, ...summarize(list.filter((c) => c.room_id === r.id)) })),
      byDay: [...days.keys()].sort().map((k) => ({ day: k, ...summarize(days.get(k)) })),
    };
  }

  function csv(from, to) {
    const dt = (ts) => { if (ts == null) return ''; const d = new Date(ts); return `${dayKey(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
    const num = (x) => (x == null ? '' : String(round(x)));
    const rows = [['Habitación', 'Entrada (cortina cerrada)', 'Cobro (puerta abierta)', 'Salida cliente', 'Lista (puerta cerrada)', 'Minutos para cobrar', 'Minutos en uso', 'Minutos hasta quedar lista', 'Entró sin pasar'].join(',')];
    for (const c of inRange(from, to)) {
      rows.push([c.room_id, dt(c.occupied_at), dt(c.paid_at), dt(c.vacated_at), dt(c.clean_ended_at),
        c.no_entry ? '' : num(mins(c.occupied_at, c.paid_at)), c.no_entry ? '' : num(mins(c.occupied_at, c.vacated_at)),
        c.no_entry ? '' : num(mins(c.vacated_at, c.clean_ended_at)), c.no_entry ? 'sí' : ''].join(','));
    }
    return `﻿${rows.join('\r\n')}\r\n`;
  }

  function roomEvents(id) {
    const past = cycles.filter((c) => c.room_id === id).slice(-8).flatMap((c) => (c.no_entry
      ? [{ ts: c.occupied_at, door: 1, curtain: 1, kind: 'occupied_start' }, { ts: c.vacated_at, door: 1, curtain: 0, kind: 'left_without_entry' }]
      : [
        { ts: c.occupied_at, door: 1, curtain: 1, kind: 'occupied_start' },
        { ts: c.paid_at, door: 0, curtain: 1, kind: 'paid' },
        { ts: c.vacated_at, door: 0, curtain: 0, kind: 'vacated' },
        { ts: c.clean_ended_at, door: 1, curtain: 0, kind: 'cleaning_end' },
      ]));
    return [...(liveEvents.get(id) || []), ...past.sort((a, b) => b.ts - a.ts)].slice(0, 100);
  }

  // ---------- API falsa ----------
  const realFetch = window.fetch.bind(window);
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const p = url.pathname;
    let m;

    if (p === '/api/me' || p === '/api/login') return reply(user);
    if (p === '/api/logout') return reply({ ok: true });
    if (p === '/api/motels' && method === 'GET') return reply([motel]);
    if (p === '/api/users' && method === 'GET') return reply(users);
    if (p === '/api/motels/1/rooms' && method === 'GET') {
      const list = [...rooms.values()].map((r) => ({ ...r }));
      return reply({ now: Date.now(), rooms: list });
    }
    if (p === '/api/motels/1/report') return reply(report(url.searchParams.get('from'), url.searchParams.get('to')));
    if ((m = /^\/api\/rooms\/(\d+)\/events$/.exec(p))) return reply(roomEvents(Number(m[1])));
    if ((m = /^\/api\/rooms\/(\d+)\/state$/.exec(p)) && method === 'POST') {
      const r = rooms.get(Number(m[1]));
      const { state } = JSON.parse(init.body);
      Object.assign(r, { state, state_since: Date.now(), paid_at: state === 'ocupada' ? Date.now() : null, curtain_open_since: null });
      log(r, `manual:${state}`);
      publish(r);
      return reply(r);
    }
    return reply({ error: 'En la demo no se pueden guardar cambios' }, 400);
  };

  class DemoEventSource {
    constructor() {
      this.listeners = {};
      streams.add(this);
      setTimeout(() => this.onopen?.(), 50);
    }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    close() { streams.delete(this); }
    _emit(type, data) { this.listeners[type]?.({ data }); }
  }
  window.EventSource = DemoEventSource;

  // La descarga de Excel es un enlace normal: la generamos aquí.
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href*="report.csv"]');
    if (!a) return;
    e.preventDefault();
    const q = new URL(a.href).searchParams;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv(q.get('from'), q.get('to'))], { type: 'text/csv;charset=utf-8' }));
    link.download = `Motel_Demo_${q.get('from')}_a_${q.get('to')}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }, true);

  // Aviso visible: esto no es el sistema conectado a sensores.
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.textContent = 'Demo con datos simulados: no hay sensores conectados y los cambios no se guardan.';
    b.style.cssText = 'background:#b7861b;color:#fff;font:600 14px/1.4 system-ui,sans-serif;text-align:center;padding:8px 16px';
    document.body.prepend(b);
  });
})();
