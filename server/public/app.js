// Panel web: login, habitaciones en vivo, reportes y administración.

const STATE_LABEL = { libre: 'Libre', ocupada: 'Ocupada', limpieza: 'Limpieza' };
// El cronómetro siempre mide el tiempo en el estado actual; esta etiqueta lo aclara.
const TIMER_LABEL = { libre: 'Disponible hace', ocupada: 'Tiempo en uso', limpieza: 'Tiempo sin estar lista' };
const ROLE_LABEL = { admin: 'Administrador', manager: 'Recepción', viewer: 'Solo lectura' };
const WARN_CLEAN_MIN = 45;  // la tarjeta resalta si la limpieza (incluida la espera) pasa de esto
const WARN_CHARGE_MIN = 10; // ...o si un carro lleva esto adentro sin que se abra la puerta

const app = document.getElementById('app');
const dialog = document.getElementById('dialog');

const S = {
  me: null,
  motels: [],
  motelId: Number(localStorageGet('motelId')) || null,
  rooms: new Map(),
  skew: 0,          // servidor - cliente, para que los cronómetros no dependan del reloj de la PC
  es: null,
  live: false,
};

// ---------- utilidades ----------
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { S.me = null; renderLogin(); throw new Error(data.error || 'Sesión expirada'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

const serverNow = () => Date.now() + S.skew;

function fmtDur(ms) {
  if (ms == null || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
const fmtMin = (m) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.round(m)} min`);
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '');
const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const canManage = () => S.me && (S.me.role === 'admin' || S.me.role === 'manager');
const isAdmin = () => S.me?.role === 'admin';

const LOGO = `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#14161a"/><rect x="8" y="7" width="16" height="19" rx="2" fill="none" stroke="#e9b949" stroke-width="2.5"/><circle cx="20" cy="17" r="1.8" fill="#e9b949"/></svg>`;

// ---------- arranque ----------
async function boot() {
  try {
    S.me = await api('/api/me');
  } catch {
    return renderLogin();
  }
  await loadMotels();
  route();
}

window.addEventListener('hashchange', () => { if (S.me) route(); });

async function loadMotels() {
  S.motels = await api('/api/motels');
  if (!S.motels.some((m) => m.id === S.motelId)) S.motelId = S.motels[0]?.id ?? null;
}

function currentTab() {
  const tab = location.hash.replace('#/', '') || 'panel';
  if (tab === 'admin' && !isAdmin()) return 'panel';
  return ['panel', 'reportes', 'admin'].includes(tab) ? tab : 'panel';
}

function route() {
  const tab = currentTab();
  if (tab !== 'panel') stopStream();
  renderShell(tab);
  if (tab === 'panel') renderPanel();
  else if (tab === 'reportes') renderReports();
  else renderAdmin();
}

// ---------- login ----------
function renderLogin() {
  stopStream();
  app.innerHTML = `
    <div class="login">
      <form class="card" id="loginForm">
        <div class="brand">${LOGO}<span>Control de Habitaciones</span></div>
        <h1>Iniciar sesión</h1>
        <label class="field">Correo<input name="email" type="email" autocomplete="username" required autofocus></label>
        <label class="field">Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
        <div class="error" id="loginError"></div>
        <button class="btn primary" type="submit">Entrar</button>
      </form>
    </div>`;
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      S.me = await api('/api/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      await loadMotels();
      route();
    } catch (err) {
      document.getElementById('loginError').textContent = err.message;
    }
  });
}

// ---------- estructura ----------
function renderShell(tab) {
  const tabs = [['panel', 'Panel'], ['reportes', 'Reportes']];
  if (isAdmin()) tabs.push(['admin', 'Administración']);
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">${LOGO}<span>Control de Habitaciones</span></div>
      <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/${k}" ${k === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
      <div class="spacer"></div>
      ${S.motels.length > 1 ? `<select id="motelSel" aria-label="Motel">${S.motels.map((m) => `<option value="${m.id}" ${m.id === S.motelId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`
        : S.motels.length ? `<strong>${esc(S.motels[0].name)}</strong>` : ''}
      ${tab === 'panel' ? `<span class="conn ${S.live ? 'live' : ''}" id="conn">${S.live ? 'En vivo' : 'Conectando…'}</span>` : ''}
      <button class="btn small" id="userBtn" title="${esc(S.me.email)}">${esc(S.me.name)}</button>
    </header>
    <main id="main"></main>`;
  document.getElementById('motelSel')?.addEventListener('change', (e) => {
    S.motelId = Number(e.target.value);
    localStorageSet('motelId', S.motelId);
    route();
  });
  document.getElementById('userBtn').addEventListener('click', openUserMenu);
}

function setLive(live) {
  S.live = live;
  const el = document.getElementById('conn');
  if (el) { el.classList.toggle('live', live); el.textContent = live ? 'En vivo' : 'Reconectando…'; }
}

function openUserMenu() {
  openDialog(`
    <div class="dlg">
      <div class="head"><h2>${esc(S.me.name)}</h2><button class="btn small" data-close>Cerrar</button></div>
      <div class="muted">${esc(S.me.email)} · ${ROLE_LABEL[S.me.role]}</div>
      <form id="pwForm" class="stack" style="gap:10px">
        <strong>Cambiar contraseña</strong>
        <label class="field">Contraseña actual<input name="current" type="password" required autocomplete="current-password"></label>
        <label class="field">Nueva contraseña (mín. 8)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
        <button class="btn" type="submit">Guardar contraseña</button>
      </form>
      <button class="btn danger" id="logoutBtn">Cerrar sesión</button>
    </div>`);
  dialog.querySelector('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/me/password', { method: 'POST', body: { current: f.get('current'), password: f.get('password') } });
      dialog.close();
      toast('Contraseña actualizada');
    } catch (err) { toast(err.message); }
  });
  dialog.querySelector('#logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    dialog.close();
    S.me = null;
    renderLogin();
  });
}

function openDialog(html) {
  dialog.innerHTML = html;
  dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  if (!dialog.open) dialog.showModal();
}

function noMotels(main) {
  main.innerHTML = `<div class="empty card">
    <h2>Aún no hay moteles</h2>
    <p>${isAdmin() ? 'Ve a <a href="#/admin">Administración</a> para crear el motel y sus habitaciones.' : 'Pide al administrador que te asigne un motel.'}</p>
  </div>`;
}

// ---------- panel en vivo ----------
let tickTimer = null;

async function renderPanel() {
  const main = document.getElementById('main');
  if (!S.motelId) return noMotels(main);
  main.innerHTML = `<div class="summary" id="summary"></div><div class="grid" id="grid"></div>`;
  await refreshRooms();
  startStream();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
}

async function refreshRooms() {
  const data = await api(`/api/motels/${S.motelId}/rooms`);
  S.skew = data.now - Date.now();
  S.rooms = new Map(data.rooms.map((r) => [r.id, r]));
  drawRooms();
}

function drawRooms() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const rooms = [...S.rooms.values()];
  if (!rooms.length) {
    grid.outerHTML = `<div class="empty card" id="grid">Este motel no tiene habitaciones. ${isAdmin() ? 'Agrégalas en <a href="#/admin">Administración</a>.' : ''}</div>`;
    drawSummary();
    return;
  }
  grid.innerHTML = rooms.map(roomCard).join('');
  grid.querySelectorAll('.room').forEach((el) => el.addEventListener('click', () => openRoom(Number(el.dataset.id))));
  drawSummary();
}

const neverSeen = (r) => r.door == null && r.state_since == null;

const unpaid = (r) => r.state === 'ocupada' && r.paid_at == null;

// Resaltar: limpieza que tarda demasiado, o carro esperando cobro demasiado tiempo.
function isWarn(r, now) {
  if (!r.state_since) return false;
  const mins = (now - r.state_since) / 60_000;
  return (r.state === 'limpieza' && mins > WARN_CLEAN_MIN) || (unpaid(r) && mins > WARN_CHARGE_MIN);
}

function roomCard(r) {
  const since = serverNow() - (r.state_since ?? serverNow());
  const warn = isWarn(r, serverNow());
  const cls = neverSeen(r) ? 's-none' : `s-${r.state}`;
  const label = neverSeen(r) ? 'Sin sensor' : unpaid(r) ? 'Por cobrar' : STATE_LABEL[r.state];
  return `
    <button class="room ${cls} ${r.online ? '' : 'offline'} ${warn ? 'warn' : ''}" data-id="${r.id}" aria-label="Habitación ${esc(r.number)}, ${label}">
      <div class="head"><span class="num">${esc(r.number)}</span><span class="pill">${label}</span></div>
      ${neverSeen(r) ? '' : `<div class="timer-label">${TIMER_LABEL[r.state]}</div>`}
      <div class="timer" data-since="${r.state_since ?? ''}">${r.state_since ? fmtDur(since) : '—'}</div>
      <div class="sub">${esc(roomSub(r))}</div>
      <div class="sensors">
        <span>Puerta <b>${sensorLabel(r.door)}</b></span>
        <span>Cortina <b>${sensorLabel(r.curtain)}</b></span>
        ${r.online || neverSeen(r) ? '' : '<span class="offline-tag">Sin señal</span>'}
      </div>
    </button>`;
}

const sensorLabel = (v) => (v == null ? '?' : v === 1 ? 'cerrada' : 'abierta');

function roomSub(r) {
  if (r.state === 'limpieza') {
    return r.staff_entered_at ? `Limpiando desde ${fmtTime(r.staff_entered_at)}` : `Cliente salió ${fmtTime(r.state_since)}`;
  }
  if (r.state === 'ocupada') {
    if (r.curtain_open_since) return `Cortina abierta desde ${fmtTime(r.curtain_open_since)} (¿saliendo?)`;
    if (r.paid_at == null) return `Carro adentro desde ${fmtTime(r.state_since)}, sin abrir la puerta`;
    return `Entró ${fmtTime(r.state_since)} · cobrada ${fmtTime(r.paid_at)}`;
  }
  return r.state_since ? `Lista desde ${fmtTime(r.state_since)}` : 'El ESP32 aún no ha reportado';
}

function drawSummary() {
  const el = document.getElementById('summary');
  if (!el) return;
  const rooms = [...S.rooms.values()];
  const count = (s) => rooms.filter((r) => r.state === s && !neverSeen(r)).length;
  const offline = rooms.filter((r) => !r.online).length;
  el.innerHTML = `
    <div class="stat" style="--c:var(--libre)"><div class="n">${count('libre')}</div><div class="l">Libres</div></div>
    <div class="stat" style="--c:var(--ocupada)"><div class="n">${count('ocupada')}</div><div class="l">Ocupadas</div></div>
    <div class="stat" style="--c:var(--limpieza)"><div class="n">${count('limpieza')}</div><div class="l">En limpieza</div></div>
    <div class="stat" style="--c:var(--offline)"><div class="n">${offline}</div><div class="l">Sensores sin señal</div></div>`;
}

function tick() {
  const now = serverNow();
  document.querySelectorAll('.room .timer[data-since]').forEach((el) => {
    const since = Number(el.dataset.since);
    if (!since) return;
    el.textContent = fmtDur(now - since);
    const card = el.closest('.room');
    const room = S.rooms.get(Number(card.dataset.id));
    if (room) card.classList.toggle('warn', isWarn(room, now));
  });
}

function startStream() {
  stopStream();
  const motelId = S.motelId;
  const es = new EventSource(`/api/motels/${motelId}/stream`);
  S.es = es;
  es.onopen = () => {
    setLive(true);
    refreshRooms().catch(() => {}); // al reconectar, ponerse al día con lo que se haya perdido
  };
  es.onerror = () => setLive(false);
  es.addEventListener('room', (e) => {
    const room = JSON.parse(e.data);
    if (room.motel_id !== S.motelId) return;
    const prev = S.rooms.get(room.id);
    S.rooms.set(room.id, { ...prev, ...room });
    const el = document.querySelector(`.room[data-id="${room.id}"]`);
    if (el) {
      el.outerHTML = roomCard(S.rooms.get(room.id));
      document.querySelector(`.room[data-id="${room.id}"]`).addEventListener('click', () => openRoom(room.id));
      drawSummary();
    } else {
      drawRooms();
    }
  });
}

function stopStream() {
  if (S.es) { S.es.close(); S.es = null; }
  clearInterval(tickTimer);
  S.live = false;
}

const EVENT_LABEL = {
  sensor: 'Cambio de sensor',
  occupied_start: 'Entra carro (cortina cerrada)',
  paid: 'Cobrada (se abrió la puerta)',
  curtain_reclosed: 'Cortina abierta un momento (no cuenta como salida)',
  vacated: 'Sale cliente',
  left_without_entry: 'Entró y salió sin pasar a la habitación',
  cleaning_in: 'Entra limpieza',
  cleaning_end: 'Habitación lista (puerta cerrada)',
  cleaning_short_visit: 'Visita corta (no cuenta)',
};
const eventLabel = (k) => k.split(',').map((p) => (p.startsWith('manual:') ? `Cambio manual a ${STATE_LABEL[p.slice(7)]}` : EVENT_LABEL[p] || p)).join(' · ');

async function openRoom(id) {
  const r = S.rooms.get(id);
  openDialog(`<div class="dlg"><div class="head"><h2>Habitación ${esc(r.number)}</h2><button class="btn small" data-close>Cerrar</button></div><div class="muted">Cargando…</div></div>`);
  let events = [];
  try { events = await api(`/api/rooms/${id}/events`); } catch (err) { toast(err.message); }
  const manual = canManage() ? `
    <div class="stack" style="gap:8px">
      <strong>Corregir estado</strong>
      <span class="muted" style="font-size:.85rem">Úsalo solo si el sensor se equivocó. Queda registrado con tu nombre.</span>
      <div class="row">${['libre', 'ocupada', 'limpieza'].filter((s) => s !== r.state)
        .map((s) => `<button class="btn" data-state="${s}">Marcar ${STATE_LABEL[s].toLowerCase()}</button>`).join('')}</div>
    </div>` : '';
  openDialog(`
    <div class="dlg">
      <div class="head"><h2>Habitación ${esc(r.number)}</h2><button class="btn small" data-close>Cerrar</button></div>
      <div class="row" style="align-items:center">
        <span class="room s-${r.state}" style="all:unset"><span class="pill" style="--c:var(--${r.state});--cbg:var(--${r.state}-bg)">${STATE_LABEL[r.state]}</span></span>
        <span class="muted">${esc(roomSub(r))}</span>
      </div>
      <div class="muted" style="font-size:.85rem">Último reporte del sensor: ${r.last_seen ? fmtDateTime(r.last_seen) : 'nunca'} ${r.online ? '' : '· <b style="color:var(--ocupada)">sin señal</b>'}</div>
      ${manual}
      <div>
        <strong>Últimos movimientos</strong>
        <div class="events table-wrap"><table><tbody>
          ${events.length ? events.map((e) => `<tr><td class="muted">${fmtDateTime(e.ts)}</td><td>${esc(eventLabel(e.kind))}${e.user_name ? ` <span class="muted">(${esc(e.user_name)})</span>` : ''}</td><td class="muted">P:${sensorLabel(e.door)} C:${sensorLabel(e.curtain)}</td></tr>`).join('')
            : '<tr><td class="muted">Sin movimientos todavía</td></tr>'}
        </tbody></table></div>
      </div>
    </div>`);
  dialog.querySelectorAll('[data-state]').forEach((b) => b.addEventListener('click', async () => {
    const state = b.dataset.state;
    if (!confirm(`¿Marcar la habitación ${r.number} como ${STATE_LABEL[state].toLowerCase()}?`)) return;
    try {
      const updated = await api(`/api/rooms/${id}/state`, { method: 'POST', body: { state } });
      S.rooms.set(id, { ...r, ...updated });
      drawRooms();
      dialog.close();
      toast(`Habitación ${r.number}: ${STATE_LABEL[state]}`);
    } catch (err) { toast(err.message); }
  }));
}

// ---------- reportes ----------
async function renderReports() {
  stopStream();
  const main = document.getElementById('main');
  if (!S.motelId) return noMotels(main);
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 6 * 86400_000);
  const from = localStorageGet('rep_from') || isoDay(weekAgo);
  const to = localStorageGet('rep_to') || isoDay(today);
  main.innerHTML = `
    <div class="stack">
      <form class="row card" id="repForm">
        <label class="field">Desde<input type="date" name="from" value="${from}" required></label>
        <label class="field">Hasta<input type="date" name="to" value="${to}" required></label>
        <div class="row" style="gap:6px">
          <button class="btn" type="button" data-range="0">Hoy</button>
          <button class="btn" type="button" data-range="6">7 días</button>
          <button class="btn" type="button" data-range="29">30 días</button>
        </div>
        <div style="flex:1"></div>
        <button class="btn primary" type="submit">Ver reporte</button>
        <a class="btn" id="csvBtn">Descargar Excel (CSV)</a>
      </form>
      <div id="repOut"><div class="muted">Cargando…</div></div>
    </div>`;
  const form = document.getElementById('repForm');
  const load = () => {
    const f = new FormData(form);
    localStorageSet('rep_from', f.get('from'));
    localStorageSet('rep_to', f.get('to'));
    document.getElementById('csvBtn').href = `/api/motels/${S.motelId}/report.csv?from=${f.get('from')}&to=${f.get('to')}`;
    loadReport(f.get('from'), f.get('to'));
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  form.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
    const t = new Date();
    form.to.value = isoDay(t);
    form.from.value = isoDay(new Date(t.getTime() - Number(b.dataset.range) * 86400_000));
    load();
  }));
  load();
}

async function loadReport(from, to) {
  const out = document.getElementById('repOut');
  let rep;
  try { rep = await api(`/api/motels/${S.motelId}/report?from=${from}&to=${to}`); }
  catch (err) { out.innerHTML = `<div class="error">${esc(err.message)}</div>`; return; }
  const t = rep.total;
  const days = rep.byDay;
  const maxDay = Math.max(1, ...days.map((d) => d.uses));
  const maxHour = Math.max(1, ...rep.byHour);
  out.innerHTML = `
    <div class="stack">
      <div class="kpis">
        <div class="kpi"><div class="v">${t.uses}</div><div class="l">Ocupaciones</div></div>
        <div class="kpi"><div class="v">${fmtMin(t.occupied_avg_min)}</div><div class="l">Tiempo promedio en uso</div></div>
        <div class="kpi"><div class="v">${fmtMin(t.charge_avg_min)}</div><div class="l">Tiempo promedio para cobrar</div></div>
        <div class="kpi"><div class="v">${fmtMin(t.ready_avg_min)}</div><div class="l">Promedio hasta quedar lista</div></div>
        <div class="kpi"><div class="v">${fmtMin(t.occupied_total_min)}</div><div class="l">Horas totales en uso</div></div>
        <div class="kpi" ${t.no_entry ? 'style="border-color:var(--ocupada)"' : ''}><div class="v">${t.no_entry}</div><div class="l">Entraron y salieron sin pasar</div></div>
      </div>

      <div class="card">
        <h2>Ocupaciones por día</h2>
        ${days.length ? `<div class="bars">${days.map((d) => `
          <div class="b" title="${d.day}: ${d.uses} ocupaciones">
            <em>${d.uses}</em><i style="height:${(d.uses / maxDay) * 100}%"></i><span>${d.day.slice(5)}</span>
          </div>`).join('')}</div>` : '<p class="muted">Sin datos en este rango.</p>'}
      </div>

      <div class="card">
        <h2>Horas de mayor entrada</h2>
        <div class="bars">${rep.byHour.map((n, h) => `
          <div class="b" title="${h}:00 – ${n} entradas">
            <em>${n || ''}</em><i style="height:${(n / maxHour) * 100}%"></i><span>${h}</span>
          </div>`).join('')}</div>
      </div>

      <div class="card">
        <h2>Por habitación</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Hab.</th><th class="num">Ocupaciones</th><th class="num">Uso promedio</th><th class="num">Horas en uso</th><th class="num">Para cobrar</th><th class="num">Hasta quedar lista</th><th class="num">Sin pasar</th></tr></thead>
          <tbody>${rep.byRoom.map((r) => `<tr>
            <td><strong>${esc(r.number)}</strong></td>
            <td class="num">${r.uses}</td>
            <td class="num">${fmtMin(r.occupied_avg_min)}</td>
            <td class="num">${fmtMin(r.occupied_total_min)}</td>
            <td class="num">${fmtMin(r.charge_avg_min)}</td>
            <td class="num">${fmtMin(r.ready_avg_min)}</td>
            <td class="num" ${r.no_entry ? 'style="color:var(--ocupada);font-weight:650"' : ''}>${r.no_entry}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>

      <div class="card">
        <h2>Por día</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Día</th><th class="num">Ocupaciones</th><th class="num">Uso promedio</th><th class="num">Para cobrar</th><th class="num">Hasta quedar lista</th><th class="num">Sin pasar</th></tr></thead>
          <tbody>${days.map((d) => `<tr><td>${d.day}</td><td class="num">${d.uses}</td><td class="num">${fmtMin(d.occupied_avg_min)}</td><td class="num">${fmtMin(d.charge_avg_min)}</td><td class="num">${fmtMin(d.ready_avg_min)}</td><td class="num">${d.no_entry}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>
    </div>`;
}

// ---------- administración ----------
async function renderAdmin() {
  stopStream();
  const main = document.getElementById('main');
  main.innerHTML = '<div class="muted">Cargando…</div>';
  const [users, roomsData] = await Promise.all([
    api('/api/users'),
    S.motelId ? api(`/api/motels/${S.motelId}/rooms`) : Promise.resolve({ rooms: [] }),
  ]);
  const motel = S.motels.find((m) => m.id === S.motelId);
  const origin = location.origin;

  main.innerHTML = `
    <div class="stack">
      <section class="card stack" style="gap:14px">
        <h2>Moteles</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Nombre</th><th>Zona horaria</th><th></th></tr></thead>
          <tbody>${S.motels.map((m) => `<tr>
            <td><strong>${esc(m.name)}</strong></td><td class="muted">${esc(m.tz)}</td>
            <td class="num"><button class="btn small" data-edit-motel="${m.id}">Editar</button>
              <button class="btn small danger" data-del-motel="${m.id}">Eliminar</button></td></tr>`).join('') || '<tr><td class="muted" colspan="3">Ninguno todavía</td></tr>'}
          </tbody></table></div>
        <form class="row" id="motelForm">
          <label class="field" style="flex:1">Nombre del motel<input name="name" required placeholder="Motel Las Palmas"></label>
          <label class="field">Zona horaria<input name="tz" value="${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}" required></label>
          <button class="btn primary" type="submit">Crear motel</button>
        </form>
      </section>

      ${motel ? `
      <section class="card stack" style="gap:14px">
        <h2>Habitaciones de ${esc(motel.name)}</h2>
        <p class="muted" style="margin:0">Cada habitación tiene un <b>token</b> que se graba en su ESP32. Servidor para el ESP32: <span class="mono">${esc(origin)}</span></p>
        <form class="row" id="roomsForm">
          <label class="field">Desde el número<input name="from" type="number" min="0" value="1" required style="width:120px"></label>
          <label class="field">Hasta el número<input name="to" type="number" min="0" value="17" required style="width:120px"></label>
          <button class="btn primary" type="submit">Agregar habitaciones</button>
        </form>
        <form class="row" id="roomOneForm">
          <label class="field">O una habitación con nombre<input name="number" placeholder="Suite 1" required></label>
          <button class="btn" type="submit">Agregar</button>
        </form>
        <div class="table-wrap"><table>
          <thead><tr><th>Hab.</th><th>Token del ESP32</th><th>Último reporte</th><th></th></tr></thead>
          <tbody>${roomsData.rooms.map((r) => `<tr>
            <td><strong>${esc(r.number)}</strong></td>
            <td><span class="mono">${esc(r.token)}</span> <button class="btn small" data-copy="${esc(r.token)}">Copiar</button></td>
            <td class="muted">${r.last_seen ? fmtDateTime(r.last_seen) : 'nunca'}</td>
            <td class="num"><button class="btn small" data-token="${r.id}">Nuevo token</button>
              <button class="btn small danger" data-del-room="${r.id}" data-num="${esc(r.number)}">Eliminar</button></td></tr>`).join('') || '<tr><td class="muted" colspan="4">Sin habitaciones</td></tr>'}
          </tbody></table></div>
      </section>` : ''}

      <section class="card stack" style="gap:14px">
        <h2>Usuarios</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Moteles</th><th></th></tr></thead>
          <tbody>${users.map((u) => `<tr>
            <td><strong>${esc(u.name)}</strong></td><td>${esc(u.email)}</td><td>${ROLE_LABEL[u.role]}</td>
            <td class="muted">${u.role === 'admin' ? 'Todos' : esc(u.motel_ids.map((id) => S.motels.find((m) => m.id === id)?.name).filter(Boolean).join(', ') || '—')}</td>
            <td class="num"><button class="btn small" data-edit-user="${u.id}">Editar</button>
              ${u.id !== S.me.id ? `<button class="btn small danger" data-del-user="${u.id}">Eliminar</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>
        <button class="btn primary" id="newUser" style="justify-self:start">Nuevo usuario</button>
        <p class="muted" style="margin:0;font-size:.85rem"><b>Recepción</b>: ve el panel y reportes, y puede corregir estados. <b>Solo lectura</b>: ve el panel y reportes. <b>Administrador</b>: todo, en todos los moteles.</p>
      </section>
    </div>`;

  const reload = async () => { await loadMotels(); route(); };
  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); await reload(); } catch (err) { toast(err.message); } };

  main.querySelector('#motelForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    act(async () => {
      const m = await api('/api/motels', { method: 'POST', body: { name: f.get('name'), tz: f.get('tz') } });
      S.motelId = m.id;
      localStorageSet('motelId', m.id);
    }, 'Motel creado');
  });
  main.querySelectorAll('[data-edit-motel]').forEach((b) => b.addEventListener('click', () => {
    const m = S.motels.find((x) => x.id === Number(b.dataset.editMotel));
    const name = prompt('Nombre del motel', m.name);
    if (name == null) return;
    const tz = prompt('Zona horaria (ej. America/Mexico_City)', m.tz);
    if (tz == null) return;
    act(() => api(`/api/motels/${m.id}`, { method: 'PATCH', body: { name, tz } }), 'Motel actualizado');
  }));
  main.querySelectorAll('[data-del-motel]').forEach((b) => b.addEventListener('click', () => {
    const m = S.motels.find((x) => x.id === Number(b.dataset.delMotel));
    if (prompt(`Esto borra el motel, sus habitaciones y TODO su historial.\nEscribe el nombre "${m.name}" para confirmar:`) !== m.name) return;
    act(() => api(`/api/motels/${m.id}`, { method: 'DELETE' }), 'Motel eliminado');
  }));

  main.querySelector('#roomsForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    act(async () => {
      const r = await api(`/api/motels/${S.motelId}/rooms`, { method: 'POST', body: { from: f.get('from'), to: f.get('to') } });
      toast(`${r.created.length} creadas${r.skipped.length ? `, ${r.skipped.length} ya existían` : ''}`);
    });
  });
  main.querySelector('#roomOneForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    act(() => api(`/api/motels/${S.motelId}/rooms`, { method: 'POST', body: { numbers: [f.get('number')] } }), 'Habitación agregada');
  });
  main.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Token copiado'); }
    catch { prompt('Copia el token:', b.dataset.copy); }
  }));
  main.querySelectorAll('[data-token]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('El ESP32 actual dejará de funcionar hasta que le grabes el token nuevo. ¿Continuar?')) return;
    act(() => api(`/api/rooms/${b.dataset.token}/token`, { method: 'POST' }), 'Token regenerado');
  }));
  main.querySelectorAll('[data-del-room]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm(`¿Eliminar la habitación ${b.dataset.num} y todo su historial?`)) return;
    act(() => api(`/api/rooms/${b.dataset.delRoom}`, { method: 'DELETE' }), 'Habitación eliminada');
  }));

  main.querySelector('#newUser').addEventListener('click', () => userDialog(null, act));
  main.querySelectorAll('[data-edit-user]').forEach((b) => b.addEventListener('click', () =>
    userDialog(users.find((u) => u.id === Number(b.dataset.editUser)), act)));
  main.querySelectorAll('[data-del-user]').forEach((b) => b.addEventListener('click', () => {
    const u = users.find((x) => x.id === Number(b.dataset.delUser));
    if (!confirm(`¿Eliminar al usuario ${u.name}?`)) return;
    act(() => api(`/api/users/${u.id}`, { method: 'DELETE' }), 'Usuario eliminado');
  }));
}

function userDialog(u, act) {
  const editing = !!u;
  openDialog(`
    <form class="dlg" id="userForm">
      <div class="head"><h2>${editing ? 'Editar usuario' : 'Nuevo usuario'}</h2><button type="button" class="btn small" data-close>Cerrar</button></div>
      <label class="field">Nombre<input name="name" required value="${esc(u?.name)}"></label>
      <label class="field">Correo<input name="email" type="email" required value="${esc(u?.email)}" ${editing ? 'disabled' : ''}></label>
      <label class="field">Rol<select name="role">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${(u?.role || 'manager') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">${editing ? 'Nueva contraseña (vacío = no cambiar)' : 'Contraseña (mín. 8)'}<input name="password" type="password" minlength="8" ${editing ? '' : 'required'} autocomplete="new-password"></label>
      <fieldset style="border:1px solid var(--line);border-radius:8px;padding:10px">
        <legend class="muted" style="font-size:.85rem">Moteles a los que tiene acceso</legend>
        ${S.motels.map((m) => `<label style="display:flex;gap:8px;align-items:center;padding:3px 0"><input type="checkbox" name="motel" value="${m.id}" ${u?.motel_ids.includes(m.id) ? 'checked' : ''}>${esc(m.name)}</label>`).join('') || '<span class="muted">No hay moteles</span>'}
      </fieldset>
      <button class="btn primary" type="submit">Guardar</button>
    </form>`);
  dialog.querySelector('#userForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      name: f.get('name'), role: f.get('role'),
      motel_ids: f.getAll('motel').map(Number),
    };
    if (f.get('password')) body.password = f.get('password');
    dialog.close();
    if (editing) act(() => api(`/api/users/${u.id}`, { method: 'PATCH', body }), 'Usuario actualizado');
    else act(() => api('/api/users', { method: 'POST', body: { ...body, email: f.get('email') } }), 'Usuario creado');
  });
}

boot();
