// Copia consistente de la base de datos (funciona con el servidor encendido).
// Uso: npm run backup -- [carpeta destino]   (por defecto data/backups)
// Conserva las últimas 30 copias.
import fs from 'node:fs';
import path from 'node:path';
import { openDb, DATA_DIR } from '../src/db.js';

const dest = process.argv[2] || path.join(DATA_DIR, 'backups');
fs.mkdirSync(dest, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const file = path.join(dest, `moteles-${stamp}.db`);

const db = openDb();
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
console.log(`Respaldo creado: ${file}`);

const old = fs.readdirSync(dest).filter((f) => /^moteles-.*\.db$/.test(f)).sort().slice(0, -30);
for (const f of old) fs.unlinkSync(path.join(dest, f));
