// Simula el ESP32 de una habitación enviando lecturas al servidor.
// Uso: npm run simulate -- <token> [url=http://localhost:3000] [segundosPorPaso=3] [normal|sin-cobro|cortina]
//
// Para que el ciclo se complete rápido, arranca el servidor con
// CURTAIN_GRACE_SECONDS=5 y MIN_CLEAN_SECONDS=5 (en el motel real son 180 y 90).
const [token, base = 'http://localhost:3000', stepSec = '3', scenario = 'normal'] = process.argv.slice(2);
if (!token) {
  console.log('Uso: npm run simulate -- <token> [url] [segundosPorPaso] [normal|sin-cobro|cortina]');
  process.exit(1);
}

// [descripción, door, curtain]   1 = cerrado, 0 = abierto
const SCENARIOS = {
  normal: [
    ['Habitación lista', 1, 0],
    ['Entra el carro, se cierra la cortina', 1, 1],
    ['Cobran y abren la puerta', 0, 1],
    ['El cliente cierra la puerta por dentro', 1, 1],
    ['El cliente sale a la cochera (deja la puerta abierta)', 0, 1],
    ['Se abre la cortina', 0, 0],
    ['Esperando confirmar la salida...', 0, 0],
    ['Limpiando...', 0, 0],
    ['La camarera cierra la puerta', 1, 0],
  ],
  'sin-cobro': [
    ['Habitación lista', 1, 0],
    ['Entra el carro, se cierra la cortina', 1, 1],
    ['Nadie abre la puerta...', 1, 1],
    ['Se abre la cortina y el carro se va', 1, 0],
    ['Esperando confirmar...', 1, 0],
  ],
  cortina: [
    ['Habitación lista', 1, 0],
    ['Entra el carro, se cierra la cortina', 1, 1],
    ['Cobran y abren la puerta', 0, 1],
    ['El cliente abre la cortina un momento', 0, 0],
    ['La vuelve a cerrar', 0, 1],
  ],
};

const steps = SCENARIOS[scenario];
if (!steps) {
  console.log(`Escenario desconocido: ${scenario}. Opciones: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [label, door, curtain] of steps) {
  const res = await fetch(`${base}/api/device/reading`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Token': token },
    body: JSON.stringify({ door, curtain }),
  });
  const body = await res.json();
  console.log(`${label.padEnd(55)} puerta=${door} cortina=${curtain} -> ${res.ok ? body.state : 'ERROR ' + body.error}`);
  await sleep(Number(stepSec) * 1000);
}
