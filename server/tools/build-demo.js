// Copia el panel a docs/demo para publicarlo en GitHub Pages con datos simulados.
// Correr después de cambiar server/public: npm run build-demo
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = path.join(root, 'server', 'public');
const dest = path.join(root, 'docs', 'demo');

fs.copyFileSync(path.join(src, 'app.js'), path.join(dest, 'app.js'));
fs.copyFileSync(path.join(src, 'style.css'), path.join(dest, 'style.css'));

const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8')
  .replace('<title>Control de Habitaciones</title>', '<title>Control de Habitaciones (demo)</title>')
  .replace('<script type="module" src="app.js"></script>',
    '<script src="demo-api.js"></script>\n  <script type="module" src="app.js"></script>');
fs.writeFileSync(path.join(dest, 'index.html'), html);

console.log(`Demo actualizada en ${dest}`);
