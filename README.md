# Control de Habitaciones para Moteles

Mide automáticamente cuánto tiempo pasa cada habitación **ocupada**, **esperando limpieza** y **en limpieza**, usando dos sensores magnéticos por habitación.

```
 [ESP32 hab. 1] ─┐
 [ESP32 hab. 2] ─┤  WiFi del motel    ┌──────────────────────┐      navegador / celular
       ...       ├──────────────────► │ Raspberry Pi         │ ◄──  (recepción, dueño)
 [ESP32 hab.17] ─┘                    │ servidor + base datos│
                                      └──────────────────────┘
                                         ▲ Tailscale (acceso remoto seguro)
```

- **Funciona sin internet**: todo vive en la Raspberry del motel.
- **Panel en vivo**: las 17 habitaciones con su estado y cronómetro.
- **Reportes**: ocupaciones por día y por habitación, tiempo promedio de uso, espera y limpieza, horas pico, y exportación a Excel.
- **Varios moteles y usuarios**: administrador, recepción y solo lectura.

---

## 1. Cómo decide el estado

| Sensor | Dónde va |
|---|---|
| **Puerta** | puerta entre la cochera y la habitación |
| **Cortina** | cortina eléctrica de la cochera, en el riel lateral cerca del piso |

| Paso | Qué pasa | Estado en el panel |
|---|---|---|
| 1 | Habitación lista: cortina abierta, puerta cerrada con seguro | **Libre** |
| 2 | Entra el carro y se cierra la cortina | **Por cobrar** |
| 3 | Un trabajador cobra y abre la puerta | **Ocupada** (cobrada) |
| 4 | El cliente se va (normalmente deja la puerta abierta) y se abre la cortina | **Limpieza** |
| 5 | La camarera limpia y cierra la puerta | **Libre** |

Lo que mide:
- **Tiempo para cobrar**: del paso 2 al 3.
- **Tiempo en uso**: del paso 2 al 4.
- **Tiempo hasta quedar lista**: del paso 4 al 5 (espera más limpieza).
- **Entradas sin pasar**: se cerró la cortina, la puerta **nunca se abrió** y el carro se fue. No cuenta como ocupación, pero aparece en los reportes para revisarla.

Reglas para evitar errores:
- La cortina debe quedar abierta **3 minutos** para contar como salida. Si el cliente la abre un momento y la vuelve a cerrar, sigue ocupada. Se ajusta con `CURTAIN_GRACE_SECONDS`. La salida queda registrada a la hora en que se abrió la cortina, no 3 minutos después.
- Si el cliente cerró la puerta al irse, la camarera tiene que abrirla y cerrarla para que cuente.
- Una visita de menos de **90 segundos** no cuenta como limpieza. Se ajusta con `MIN_CLEAN_SECONDS`.
- Si llega otro carro durante la limpieza, la habitación pasa a ocupada.
- En el panel, una tarjeta se resalta en rojo si un carro lleva más de 10 minutos sin que se abra la puerta, o si la limpieza pasa de 45 minutos.
- Si un sensor se equivoca, recepción puede **corregir el estado** desde el panel. La corrección queda registrada con su nombre.

---

## 2. Materiales por habitación

- 1 ESP32 DevKit
- 2 sensores magnéticos (reed switch), del tipo **NO** (normalmente abierto)
- Fuente de 5 V USB (cargador de celular) y una caja pequeña
- Cable de alarma de 2 hilos para llevar el sensor de la cortina hasta el ESP32

Conexión (los sensores no tienen polaridad):

```
Sensor PUERTA   ── GPIO 25
                └─ GND
Sensor CORTINA  ── GPIO 26
                └─ GND
```

No hace falta resistencia: el ESP32 usa la suya interna (pull-up).

---

## 3. Instalar la Raspberry Pi

Recomendado: Raspberry Pi 3B+ o más nueva, con Raspberry Pi OS Lite (64 bits).

### 3.1 Darle una IP fija

En el router, reserva una IP para la Raspberry (por ejemplo `192.168.1.50`). Los ESP32 la usan para encontrarla.

### 3.2 Instalar Node.js 22 o más nuevo

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

### 3.3 Copiar el sistema y arrancarlo

Copia la carpeta del proyecto a `/home/pi/moteles` (por USB, `scp` o git). No hay que instalar dependencias: el sistema solo usa lo que trae Node.

```bash
cd /home/pi/moteles/server
npm test                 # prueba la lógica de estados
npm start                # arranca el servidor; Ctrl+C para salir
```

La primera vez imprime el **correo y la contraseña del administrador**. Anótalos y cámbialos desde el panel (clic en tu nombre, arriba a la derecha).

Abre `http://192.168.1.50:3000` desde cualquier equipo de la red del motel.

### 3.4 Que arranque solo al prender la Raspberry

```bash
sudo cp /home/pi/moteles/deploy/moteles.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now moteles
sudo journalctl -u moteles -f      # ver el registro (aquí sale la contraseña inicial)
```

### 3.5 Respaldos diarios

La tarjeta SD se puede dañar con apagones. Programa un respaldo diario a una memoria USB:

```bash
crontab -e
# agrega esta línea (respaldo a las 4:00 am, conserva los últimos 30):
0 4 * * * cd /home/pi/moteles/server && /usr/bin/node --disable-warning=ExperimentalWarning tools/backup.js /media/pi/USB/respaldos
```

Si se puede, conecta la Raspberry a un **UPS** (no-break).

### 3.6 Ver el panel desde fuera del motel (Tailscale)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Instala Tailscale en tu celular con la misma cuenta. Abre `http://<nombre-de-la-raspberry>:3000`. No hay que abrir puertos en el router.

---

## 4. Configurar el sistema

1. Entra como administrador y abre **Administración**.
2. Crea el motel (nombre y zona horaria).
3. Agrega las habitaciones con un rango, por ejemplo **del 1 al 17**.
4. Cada habitación muestra un **token**. Ese token se graba en el ESP32 de esa habitación.
5. Crea usuarios para recepción (rol **Recepción**) y asígnales el motel.

| Rol | Puede |
|---|---|
| Administrador | todo, en todos los moteles |
| Recepción | ver panel y reportes, corregir estados |
| Solo lectura | ver panel y reportes |

---

## 5. Programar cada ESP32

1. Instala **Arduino IDE** y, en *Gestor de tarjetas*, el paquete **esp32 de Espressif**.
2. Abre `firmware/room_node/room_node.ino`.
3. Llena la parte de configuración:
   ```cpp
   const char* WIFI_SSID     = "...";
   const char* WIFI_PASSWORD = "...";
   const char* SERVER_URL    = "http://192.168.1.50:3000";
   const char* DEVICE_TOKEN  = "token de esa habitación";
   ```
4. Placa **ESP32 Dev Module**. Sube el programa.
5. Abre el *Monitor serie* a 115200 y mueve los imanes. Deberías ver `Enviado ... -> 200` y la tarjeta cambiar en el panel.

LED de la placa: **parpadea** = sin WiFi; **encendido** = tiene un cambio sin enviar; **apagado** = todo bien.

Si tu sensor es **NC** (normalmente cerrado) y el panel muestra todo al revés, cambia `INVERT_DOOR` / `INVERT_CURTAIN` a `true`.

---

## 6. Probar sin hardware

En una PC con Node 22 o más nuevo:

```bash
cd server
npm run seed-demo         # crea "Motel Demo" con 17 habitaciones y una semana de historial
npm start
npm run simulate -- <token> http://localhost:3000 4 normal   # en otra terminal: simula un ciclo
```

Escenarios del simulador: `normal`, `sin-cobro` (el carro entra y sale sin que se abra la puerta) y `cortina` (el cliente abre la cortina un momento). Para que el ciclo termine rápido, arranca el servidor con `CURTAIN_GRACE_SECONDS=5` y `MIN_CLEAN_SECONDS=5`.

`seed-demo` es solo para pruebas. No lo corras en la base de datos del motel real.

---

### Demo publicada en GitHub Pages

La carpeta `docs/` se publica como página web. GitHub Pages no puede correr el servidor, así que `docs/demo/` usa el mismo panel con datos simulados en el navegador (`docs/demo/demo-api.js`). No se conecta a sensores ni guarda cambios.

Si cambias algo en `server/public`, actualiza la demo antes de subirla:

```bash
npm run build-demo
```

---

## 7. Ajustes (variables de entorno)

| Variable | Por defecto | Qué hace |
|---|---|---|
| `PORT` | 3000 | puerto web |
| `MIN_CLEAN_SECONDS` | 90 | visita mínima del personal para contar como limpieza |
| `CURTAIN_GRACE_SECONDS` | 180 | tiempo que la cortina debe quedar abierta para contar como salida |
| `OFFLINE_SECONDS` | 90 | sin reportes por este tiempo = "sin señal" |
| `SESSION_HOURS` | 12 | duración del inicio de sesión |
| `DATA_DIR` | `server/data` | dónde se guarda la base de datos |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | administrador inicial (solo en el primer arranque) |

Usuarios desde la terminal (por ejemplo, si olvidas la contraseña del administrador):

```bash
npm run create-user -- correo@ejemplo.com "Nombre" admin
```

---

## 8. Estructura

```
server/
  src/engine.js     lógica de estados (pura, con pruebas)
  src/store.js      aplica lecturas a la base de datos
  src/reports.js    reportes y CSV
  src/server.js     API, sesiones, tiempo real
  public/           panel web
  tools/            crear usuarios, demo, simulador, respaldos
  test/             pruebas
firmware/room_node/ programa del ESP32
deploy/             servicio systemd para la Raspberry
```

## Siguiente fase (pendiente)

- Envío del historial de cada motel a un servidor en la nube, para ver todos los moteles juntos en un tablero.
