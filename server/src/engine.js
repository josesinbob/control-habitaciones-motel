// Motor de estados de una habitación. Función pura: no toca base de datos ni red.
//
// Sensores (1 = cerrado, 0 = abierto):
//   curtain -> cortina eléctrica de la cochera
//   door    -> puerta entre la cochera y la habitación
//
// Cómo opera el motel:
//   1. Habitación lista: cortina abierta, puerta cerrada (con seguro del personal).
//   2. Entra el carro y se cierra la cortina            -> OCUPADA, por cobrar
//   3. Un trabajador cobra y abre la puerta              -> OCUPADA, cobrada
//   4. El cliente se va (normalmente deja la puerta
//      abierta) y se abre la cortina                    -> LIMPIEZA
//   5. La camarera limpia y cierra la puerta             -> LIBRE
//
// Protecciones:
//   - La cortina debe quedar abierta `curtainGraceMs` para contar como salida;
//     si se vuelve a cerrar antes, el cliente sigue adentro (salió al carro, etc.).
//   - Si la cortina se abre sin que la puerta se haya abierto nunca, el carro
//     entró y salió sin pasar: no es ocupación, la habitación vuelve a LIBRE.
//   - Un cierre de puerta antes de `minCleanMs` no cuenta como fin de limpieza.

export const LIBRE = 'libre';
export const OCUPADA = 'ocupada';
export const LIMPIEZA = 'limpieza';

const DEFAULTS = { minCleanMs: 90_000, curtainGraceMs: 180_000 };

/**
 * Procesa una lectura nueva de los sensores.
 * @param room  {state, state_since, door, curtain, staff_entered_at, paid_at, curtain_open_since}
 * @param snap  {door, curtain}
 * @returns {{state, state_since?, staff_entered_at, paid_at, curtain_open_since, transitions}}
 *   `state_since` solo viene cuando cambia el estado (puede ser una hora pasada).
 */
export function step(room, snap, now, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const r = {
    state: room.state,
    staff_entered_at: room.staff_entered_at ?? null,
    paid_at: room.paid_at ?? null,
    curtain_open_since: room.curtain_open_since ?? null,
    transitions: [],
  };
  const set = (state, at = now) => { r.state = state; r.state_since = at; };

  // Primera lectura de este sensor: no hay historia, se infiere del estado físico.
  if (room.door == null || room.curtain == null) {
    if (snap.curtain === 1) {
      set(OCUPADA);
      r.paid_at = now; // no sabemos si se cobró; no la marcamos como "por cobrar"
      r.transitions.push({ type: 'occupied_start', at: now, partial: true });
    } else if (room.state === OCUPADA) {
      set(LIBRE);
    }
    return r;
  }

  const curtainClosed = room.curtain === 0 && snap.curtain === 1;
  const curtainOpened = room.curtain === 1 && snap.curtain === 0;
  const doorOpened = room.door === 1 && snap.door === 0;
  const doorClosed = room.door === 0 && snap.door === 1;

  if (r.state === OCUPADA) {
    if (curtainOpened) {
      r.curtain_open_since = now;
    } else if (curtainClosed && r.curtain_open_since != null) {
      r.curtain_open_since = null;
      r.transitions.push({ type: 'curtain_reclosed', at: now });
    }
    if (doorOpened && r.paid_at == null) {
      r.paid_at = now;
      r.transitions.push({ type: 'paid', at: now });
    }
  } else if (curtainClosed) {
    // Llega un carro (desde LIBRE, o antes de terminar la limpieza).
    set(OCUPADA);
    r.staff_entered_at = null;
    r.curtain_open_since = null;
    r.paid_at = null;
    r.transitions.push({ type: 'occupied_start', at: now });
    if (snap.door === 0) {
      // La puerta ya estaba abierta: el cliente puede pasar sin que nadie le abra.
      r.paid_at = now;
      r.transitions.push({ type: 'paid', at: now, door_was_open: true });
    }
  } else if (r.state === LIMPIEZA) {
    if (doorOpened) {
      r.staff_entered_at = now;
      r.transitions.push({ type: 'cleaning_in', at: now });
    } else if (doorClosed) {
      // Si la puerta quedó abierta al salir el cliente, medimos desde la salida;
      // si estaba cerrada, desde que la camarera la abrió.
      const ref = r.staff_entered_at ?? room.state_since ?? now;
      if (now - ref >= o.minCleanMs) {
        set(LIBRE);
        r.staff_entered_at = null;
        r.transitions.push({ type: 'cleaning_end', at: now });
      } else if (r.staff_entered_at != null) {
        r.staff_entered_at = null;
        r.transitions.push({ type: 'cleaning_short_visit', at: now });
      }
    }
  }

  return mergeTick(r, now, o);
}

/**
 * Revisión por tiempo (el servidor la llama cada pocos segundos): confirma la
 * salida del cliente cuando la cortina lleva abierta el tiempo de gracia.
 * Devuelve null si no hay nada que cambiar.
 */
export function tick(room, now, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (room.state !== OCUPADA || room.curtain_open_since == null) return null;
  if (now - room.curtain_open_since < o.curtainGraceMs) return null;
  const at = room.curtain_open_since;
  const base = { state_since: at, staff_entered_at: null, paid_at: null, curtain_open_since: null };
  if (room.paid_at == null) {
    return { ...base, state: LIBRE, transitions: [{ type: 'left_without_entry', at }] };
  }
  return { ...base, state: LIMPIEZA, transitions: [{ type: 'vacated', at }] };
}

function mergeTick(r, now, o) {
  const t = tick(r, now, o);
  if (!t) return r;
  return { ...t, transitions: [...r.transitions, ...t.transitions] };
}

/** Transiciones para forzar un estado a mano (recepción corrige un error). */
export function manualTransitions(currentState, target, now) {
  if (target === currentState) return [];
  const t = [];
  if (target === OCUPADA) {
    t.push({ type: 'occupied_start', at: now, partial: true });
    t.push({ type: 'paid', at: now });
  } else if (target === LIMPIEZA) {
    if (currentState === LIBRE) t.push({ type: 'occupied_start', at: now, partial: true });
    t.push({ type: 'vacated', at: now });
  } else if (target === LIBRE) {
    if (currentState === OCUPADA) t.push({ type: 'vacated', at: now });
    t.push({ type: 'cleaning_end', at: now });
  }
  return t;
}
