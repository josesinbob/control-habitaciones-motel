import test from 'node:test';
import assert from 'node:assert/strict';
import { step, tick, manualTransitions, LIBRE, OCUPADA, LIMPIEZA } from '../src/engine.js';

const OPTS = { minCleanMs: 90_000, curtainGraceMs: 180_000 };

// Aplica una secuencia de [segundos, door, curtain] (o [segundos, 'tick']) y
// devuelve el estado final y los tipos de transición. 1 = cerrado, 0 = abierto.
function run(seq, opts = OPTS) {
  let room = { state: LIBRE, state_since: null, door: null, curtain: null };
  const types = [];
  const apply = (res, extra) => {
    room = { ...room, ...res, ...extra, state_since: res.state_since ?? room.state_since };
    types.push(...res.transitions.map((t) => t.type));
  };
  for (const [sec, door, curtain] of seq) {
    const now = sec * 1000;
    if (door === 'tick') {
      const res = tick(room, now, opts);
      if (res) apply(res, {});
    } else {
      apply(step(room, { door, curtain }, now, opts), { door, curtain });
    }
  }
  return { room, types };
}

test('ciclo normal del motel', () => {
  const { room, types } = run([
    [0, 1, 0],       // lista: puerta cerrada, cortina abierta
    [10, 1, 1],      // entra el carro, se cierra la cortina -> por cobrar
    [70, 0, 1],      // cobran y abren la puerta
    [80, 1, 1],      // el cliente cierra por dentro
    [3600, 0, 1],    // el cliente sale a la cochera, deja la puerta abierta
    [3620, 0, 0],    // abre la cortina
    [3800, 'tick'],  // pasan 3 min con la cortina abierta -> salida confirmada
    [5000, 1, 0],    // la camarera termina y cierra la puerta
  ]);
  assert.equal(room.state, LIBRE);
  assert.deepEqual(types, ['occupied_start', 'paid', 'vacated', 'cleaning_end']);
});

test('la salida se fecha cuando se abrió la cortina, no cuando se confirmó', () => {
  const { room } = run([[0, 1, 0], [10, 1, 1], [20, 0, 1], [1000, 0, 0], [1200, 'tick']]);
  assert.equal(room.state, LIMPIEZA);
  assert.equal(room.state_since, 1000 * 1000);
});

test('abrir la cortina un momento no termina la ocupación', () => {
  const { room, types } = run([
    [0, 1, 0], [10, 1, 1], [20, 0, 1],
    [500, 0, 0],     // el cliente abre la cortina
    [560, 0, 1],     // la cierra al minuto
    [900, 'tick'],
  ]);
  assert.equal(room.state, OCUPADA);
  assert.equal(room.curtain_open_since, null);
  assert.deepEqual(types, ['occupied_start', 'paid', 'curtain_reclosed']);
});

test('carro que entra y sale sin que se abra la puerta: no es ocupación', () => {
  const { room, types } = run([[0, 1, 0], [10, 1, 1], [200, 1, 0], [400, 'tick']]);
  assert.equal(room.state, LIBRE);
  assert.deepEqual(types, ['occupied_start', 'left_without_entry']);
});

test('cerrar la puerta justo después de que se va el cliente no la deja lista', () => {
  const { room } = run([
    [0, 1, 0], [10, 1, 1], [20, 0, 1],
    [1000, 0, 0],    // abre la cortina
    [1030, 1, 0],    // el cliente cierra la puerta al irse
    [1200, 'tick'],
  ]);
  assert.equal(room.state, LIMPIEZA); // sigue pendiente: la camarera aún no entra
});

test('si el cliente cerró la puerta, la camarera debe abrirla y cerrarla', () => {
  const { room, types } = run([
    [0, 1, 0], [10, 1, 1], [20, 0, 1], [900, 1, 1],
    [1000, 1, 0], [1200, 'tick'],
    [1500, 0, 0],    // entra la camarera
    [2700, 1, 0],    // sale
  ]);
  assert.equal(room.state, LIBRE);
  assert.deepEqual(types, ['occupied_start', 'paid', 'vacated', 'cleaning_in', 'cleaning_end']);
});

test('llega un carro con la puerta abierta: se marca cobrada al instante', () => {
  const { room, types } = run([[0, 0, 0], [10, 0, 1]]);
  assert.equal(room.state, OCUPADA);
  assert.ok(room.paid_at);
  assert.deepEqual(types, ['occupied_start', 'paid']);
});

test('la primera lectura con cortina cerrada marca ocupada parcial', () => {
  const r = step({ state: LIBRE, door: null, curtain: null }, { door: 1, curtain: 1 }, 1000);
  assert.equal(r.state, OCUPADA);
  assert.equal(r.transitions[0].partial, true);
});

test('lecturas repetidas (latido) no generan transiciones', () => {
  const { types } = run([[0, 1, 0], [30, 1, 0], [60, 1, 0]]);
  assert.deepEqual(types, []);
});

test('corrección manual', () => {
  assert.deepEqual(manualTransitions(OCUPADA, LIBRE, 5).map((t) => t.type), ['vacated', 'cleaning_end']);
  assert.deepEqual(manualTransitions(LIBRE, LIMPIEZA, 5).map((t) => t.type), ['occupied_start', 'vacated']);
  assert.deepEqual(manualTransitions(LIBRE, LIBRE, 5), []);
});
