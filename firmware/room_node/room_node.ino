/*
  Nodo de habitación — ESP32 + 2 sensores magnéticos (reed switch)

  Lee la puerta y la cortina de la cochera y avisa al servidor (Raspberry Pi):
    - al instante cuando algo cambia
    - cada 30 s como "latido", para que el panel sepa que el sensor está vivo

  Conexión (cada sensor tiene 2 cables, no tienen polaridad):
    Sensor PUERTA   -> GPIO 25  y  GND
    Sensor CORTINA  -> GPIO 26  y  GND
  Se usa la resistencia pull-up interna, no hace falta resistencia externa.

  Con un sensor normalmente abierto (NO, el más común):
    imán junto al sensor (cerrado)  -> contacto cerrado -> pin en LOW  -> se envía 1
    imán lejos (abierto)            -> contacto abierto -> pin en HIGH -> se envía 0
  Si tu sensor es normalmente cerrado (NC), cambia INVERT_* a true.

  Placa en Arduino IDE: "ESP32 Dev Module" (paquete esp32 de Espressif).
*/

#include <WiFi.h>
#include <HTTPClient.h>

// =================== CONFIGURA ESTO PARA CADA HABITACIÓN ===================
const char* WIFI_SSID     = "NOMBRE_DE_TU_WIFI";
const char* WIFI_PASSWORD = "CLAVE_DE_TU_WIFI";
const char* SERVER_URL    = "http://192.168.1.50:3000";   // IP fija de la Raspberry
const char* DEVICE_TOKEN  = "PEGA_AQUI_EL_TOKEN";          // de Administración > Habitaciones
// ===========================================================================

const int  PIN_DOOR        = 25;
const int  PIN_CURTAIN     = 26;
const bool INVERT_DOOR     = false;
const bool INVERT_CURTAIN  = false;
const int  PIN_LED         = 2;        // LED azul de la placa (en la mayoría de ESP32 DevKit)

const unsigned long DEBOUNCE_MS        = 300;     // el contacto debe estar estable este tiempo
const unsigned long HEARTBEAT_MS       = 30000;   // latido aunque no cambie nada
const unsigned long RETRY_MS           = 5000;    // reintento si el servidor no respondió
const unsigned long WIFI_RESTART_MS    = 180000;  // sin WiFi 3 min -> reiniciar la placa

struct Input {
  int pin;
  bool invert;
  int stable;           // valor confirmado (1 cerrado, 0 abierto)
  int lastRaw;
  unsigned long changedAt;
};

Input door    = { PIN_DOOR,    INVERT_DOOR,    -1, -1, 0 };
Input curtain = { PIN_CURTAIN, INVERT_CURTAIN, -1, -1, 0 };

bool pending = true;               // hay una lectura que el servidor aún no confirmó
unsigned long lastSentAt = 0;
unsigned long lastAttemptAt = 0;
unsigned long wifiLostAt = 0;

int readClosed(const Input& in) {
  int raw = digitalRead(in.pin) == LOW ? 1 : 0;
  return in.invert ? 1 - raw : raw;
}

// Devuelve true si el valor estable cambió.
bool updateInput(Input& in) {
  int raw = readClosed(in);
  unsigned long now = millis();
  if (raw != in.lastRaw) {
    in.lastRaw = raw;
    in.changedAt = now;
  }
  if (raw != in.stable && now - in.changedAt >= DEBOUNCE_MS) {
    in.stable = raw;
    return true;
  }
  return false;
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);            // respuesta más rápida; la placa va conectada a corriente
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Conectando a WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(250);
    Serial.print(".");
    digitalWrite(PIN_LED, !digitalRead(PIN_LED));
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi OK, IP: ");
    Serial.println(WiFi.localIP());
  }
}

bool sendReading() {
  if (WiFi.status() != WL_CONNECTED || door.stable < 0 || curtain.stable < 0) return false;

  HTTPClient http;
  http.setTimeout(4000);
  http.begin(String(SERVER_URL) + "/api/device/reading");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  String body = String("{\"door\":") + door.stable + ",\"curtain\":" + curtain.stable + "}";
  int code = http.POST(body);
  String resp = code > 0 ? http.getString() : http.errorToString(code);
  http.end();

  Serial.printf("Enviado puerta=%d cortina=%d -> %d %s\n", door.stable, curtain.stable, code, resp.c_str());
  if (code == 401) Serial.println("¡Token incorrecto! Revisa DEVICE_TOKEN.");
  return code == 200;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_DOOR, INPUT_PULLUP);
  pinMode(PIN_CURTAIN, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  delay(100);

  door.stable = door.lastRaw = readClosed(door);
  curtain.stable = curtain.lastRaw = readClosed(curtain);
  Serial.printf("\nNodo de habitación. Puerta=%d Cortina=%d\n", door.stable, curtain.stable);

  connectWifi();
}

void loop() {
  unsigned long now = millis();

  if (updateInput(door) | updateInput(curtain)) {   // | (no ||) para leer ambos siempre
    Serial.printf("Cambio: puerta=%d cortina=%d\n", door.stable, curtain.stable);
    pending = true;
    lastAttemptAt = 0;   // enviar ya, sin esperar el reintento
  }

  if (WiFi.status() != WL_CONNECTED) {
    if (wifiLostAt == 0) wifiLostAt = now;
    if (now - wifiLostAt > WIFI_RESTART_MS) {
      Serial.println("Sin WiFi demasiado tiempo, reiniciando...");
      ESP.restart();
    }
    digitalWrite(PIN_LED, (now / 500) % 2);   // parpadeo = sin WiFi
  } else {
    wifiLostAt = 0;
    digitalWrite(PIN_LED, pending ? HIGH : LOW);
  }

  bool heartbeatDue = now - lastSentAt >= HEARTBEAT_MS;
  bool retryDue = lastAttemptAt == 0 || now - lastAttemptAt >= RETRY_MS;
  if ((pending || heartbeatDue) && retryDue) {
    lastAttemptAt = now;
    if (sendReading()) {
      pending = false;
      lastSentAt = now;
    }
  }

  delay(20);
}
