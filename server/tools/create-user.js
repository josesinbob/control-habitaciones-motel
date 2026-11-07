// Crea o reinicia un usuario desde la terminal de la Raspberry.
// Uso: npm run create-user -- correo@ejemplo.com "Nombre" admin|manager|viewer [contraseña]
import { openDb } from '../src/db.js';
import { hashPassword, randomPassword } from '../src/auth.js';

const [email, name, role = 'admin', given] = process.argv.slice(2);
if (!email || !name || !['admin', 'manager', 'viewer'].includes(role)) {
  console.log('Uso: npm run create-user -- correo@ejemplo.com "Nombre" admin|manager|viewer [contraseña]');
  process.exit(1);
}
const password = given || randomPassword();
const db = openDb();
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (existing) {
  db.prepare('UPDATE users SET name = ?, role = ?, pass_hash = ? WHERE id = ?').run(name, role, hashPassword(password), existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`Usuario actualizado: ${email}`);
} else {
  db.prepare('INSERT INTO users (email, name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(email, name, role, hashPassword(password), Date.now());
  console.log(`Usuario creado: ${email}`);
}
if (!given) console.log(`Contraseña: ${password}`);
