// Crea un motel de prueba con 17 habitaciones y una semana de historial inventado,
// para ver el panel y los reportes sin hardware. NO usar en el motel real.
// Uso: npm run seed-demo
import { openDb, tx } from '../src/db.js';
import { deviceToken } from '../src/auth.js';

const db = openDb();
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = Date.now();
const MIN = 60_000;

const motelId = Number(db.prepare('INSERT INTO motels (name, tz, created_at) VALUES (?, ?, ?)')
  .run('Motel Demo', tz, now).lastInsertRowid);

const rand = (a, b) => a + Math.random() * (b - a);

tx(db, () => {
  for (let n = 1; n <= 17; n++) {
    const token = deviceToken();
    const roomId = Number(db.prepare('INSERT INTO rooms (motel_id, number, token) VALUES (?, ?, ?)')
      .run(motelId, String(n), token).lastInsertRowid);

    // Historial: ciclos uno tras otro durante los últimos 7 días.
    let t = now - 7 * 24 * 60 * MIN + rand(0, 120) * MIN;
    while (true) {
      const occupied = t;
      if (Math.random() < 0.03) {
        // de vez en cuando, un carro que entra y sale sin pasar
        const left = occupied + rand(2, 8) * MIN;
        db.prepare('INSERT INTO cycles (room_id, occupied_at, vacated_at, no_entry) VALUES (?, ?, ?, 1)')
          .run(roomId, occupied, left);
        t = left + rand(10, 120) * MIN;
        continue;
      }
      const paid = occupied + rand(1, 6) * MIN;
      const vacated = occupied + rand(60, 240) * MIN;
      const ready = vacated + rand(15, 55) * MIN;
      if (ready > now - 30 * MIN) break;
      db.prepare(`INSERT INTO cycles (room_id, occupied_at, paid_at, vacated_at, clean_ended_at)
        VALUES (?, ?, ?, ?, ?)`).run(roomId, occupied, paid, vacated, ready);
      t = ready + rand(10, 300) * MIN;
    }
    console.log(`Habitación ${String(n).padStart(2)}  token: ${token}`);
  }
});
console.log(`\nMotel Demo creado (id ${motelId}). Usa un token con: npm run simulate -- <token>`);
