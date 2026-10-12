/*
 * Beepstock scanner bridge: BLE HID barcode scanner -> WiFi -> Beepstock REST API.
 *
 * Board:   ESP32-C3 (PlatformIO env "esp32c3", see platformio.ini; USB CDC on boot is enabled there)
 * Library: NimBLE-Arduino 2.x (installed automatically by PlatformIO).
 *
 * The ESP32-C3 only supports Bluetooth LOW ENERGY. The scanner must therefore be put into a
 * BLE HID mode (not Bluetooth Classic HID / SPP). Check the Netum manual for the BLE/"HID BLE"
 * setting barcode. Scanners in Classic-only mode are never found by this sketch.
 *
 * Flow: scan for BLE HID device -> connect + bond -> subscribe to HID input reports ->
 *       decode keyboard reports into text, a line ends with Enter -> POST {"code": "..."} to Beepstock.
 */
#include <Arduino.h>
#include <HTTPClient.h>
#include <NimBLEDevice.h>
#include <WiFi.h>

#include "portal.h"
#include "settings.h"

// Local defaults (WiFi, server) live in secrets.h, which is not committed; see secrets.example.h.
#if __has_include("secrets.h")
#include "secrets.h"
#endif
#ifndef SECRET_WIFI_SSID
#define SECRET_WIFI_SSID "YOUR_WIFI"
#define SECRET_WIFI_PASS "YOUR_PASSWORD"
#define SECRET_SERVER_URL "http://192.168.1.10:8080/api/scan"
#define SECRET_API_TOKEN ""
#endif

// ------------------------------------------------------------------ configuration
// These are only DEFAULTS. Values saved via the web portal (settings.h) take precedence.
static const char* WIFI_SSID = SECRET_WIFI_SSID;
static const char* WIFI_PASS = SECRET_WIFI_PASS;
static const char* SERVER_URL = SECRET_SERVER_URL;  // Beepstock host
static const char* API_TOKEN = SECRET_API_TOKEN;                                     // same as API_TOKEN of Beepstock, "" = none
// Only connect to devices whose BLE name contains this text (case-sensitive). "" = any device offering HID (0x1812).
static const char* SCANNER_NAME_FILTER = "barcode scanner";
static const int LED_PIN = 8;  // many C3 boards: onboard LED on GPIO8, active low. Set -1 to disable.
static const bool LED_ACTIVE_LOW = true;

// ------------------------------------------------------------------ state
static const uint16_t UUID_HID_SERVICE = 0x1812;
static const uint16_t UUID_HID_REPORT = 0x2A4D;
static const uint16_t UUID_BOOT_KEYBOARD_IN = 0x2A22;

struct Code {
  char text[64];
};
static QueueHandle_t codeQueue;  // BLE task -> loop() (HTTP must not run inside the BLE callback)

static NimBLEClient* client = nullptr;
static NimBLEAddress targetAddr;
static volatile bool haveTarget = false;
static volatile bool connected = false;
static volatile bool needCleanup = false;

static uint8_t prevKeys[6] = {0};
static String lineBuf;
static bool serialMode = false;          // true: scanner sends plain text over a vendor GATT service (BLE "SPP")
static volatile uint32_t lastSerialMs = 0;
static SemaphoreHandle_t lineMutex;      // guards lineBuf in serial mode (BLE task vs loop)

// ------------------------------------------------------------------ LED
static void led(bool on) {
  if (LED_PIN < 0) return;
  digitalWrite(LED_PIN, (on != LED_ACTIVE_LOW) ? HIGH : LOW);
}
static void blink(int times, int ms = 60) {
  for (int i = 0; i < times; i++) {
    led(true);
    delay(ms);
    led(false);
    delay(ms);
  }
}

// ------------------------------------------------------------------ HID keyboard decoding (US layout usage IDs)
static char keyToChar(uint8_t k, bool shift) {
  if (k >= 0x04 && k <= 0x1D) return (shift ? 'A' : 'a') + (k - 0x04);
  if (k >= 0x1E && k <= 0x27) {
    static const char plain[] = "1234567890";
    static const char shifted[] = "!@#$%^&*()";
    return shift ? shifted[k - 0x1E] : plain[k - 0x1E];
  }
  if (k >= 0x59 && k <= 0x62) return k == 0x62 ? '0' : ('1' + (k - 0x59));  // keypad 1..9, 0
  switch (k) {
    case 0x2C: return ' ';
    case 0x2D: return shift ? '_' : '-';
    case 0x2E: return shift ? '+' : '=';
    case 0x33: return shift ? ':' : ';';
    case 0x36: return shift ? '<' : ',';
    case 0x37: return shift ? '>' : '.';
    case 0x38: return shift ? '?' : '/';
    case 0x54: return '/';
    case 0x55: return '*';
    case 0x56: return '-';
    case 0x57: return '+';
    case 0x63: return '.';
    default: return 0;
  }
}

static void flushLine() {
  lineBuf.trim();
  if (lineBuf.length() > 0) {
    Serial.printf("scan: '%s'\n", lineBuf.c_str());
    Code c;
    strlcpy(c.text, lineBuf.c_str(), sizeof(c.text));
    if (xQueueSend(codeQueue, &c, 0) != pdTRUE) Serial.println("queue full, code dropped");
  }
  lineBuf = "";
}

// Standard boot keyboard report: [modifiers, reserved, key1..key6]; some devices prefix a report ID (9 bytes).
static void feedReport(const uint8_t* d, size_t len) {
  if (len == 9) {
    d++;
    len--;
  }
  if (len < 8) return;
  const bool shift = (d[0] & 0x22) != 0;  // left or right shift
  const uint8_t* keys = d + 2;
  for (int i = 0; i < 6; i++) {
    const uint8_t k = keys[i];
    if (k < 0x04) continue;  // 0 = none, 1..3 = rollover/error
    bool wasDown = false;
    for (int j = 0; j < 6; j++) wasDown |= (prevKeys[j] == k);
    if (wasDown) continue;  // only react to newly pressed keys
    if (k == 0x28 || k == 0x58) {
      flushLine();
    } else if (char ch = keyToChar(k, shift)) {
      if (lineBuf.length() < 60) lineBuf += ch;
    }
  }
  memcpy(prevKeys, keys, 6);
}

static void onNotify(NimBLERemoteCharacteristic*, uint8_t* data, size_t len, bool) {
  feedReport(data, len);
}

// Serial/vendor mode: the payload is the barcode as ASCII, usually terminated by CR/LF.
static void onSerialNotify(NimBLERemoteCharacteristic*, uint8_t* data, size_t len, bool) {
  Serial.printf("raw (%u bytes):", (unsigned)len);
  for (size_t i = 0; i < len && i < 32; i++) Serial.printf(" %02X", data[i]);
  Serial.println();
  xSemaphoreTake(lineMutex, portMAX_DELAY);
  for (size_t i = 0; i < len; i++) {
    const uint8_t b = data[i];
    if (b == '\r' || b == '\n') {
      flushLine();
    } else if (b >= 0x20 && b < 0x7F && lineBuf.length() < 60) {
      lineBuf += (char)b;
    }
  }
  lastSerialMs = millis();
  xSemaphoreGive(lineMutex);
}

// ------------------------------------------------------------------ BLE callbacks
class ScanCallbacks : public NimBLEScanCallbacks {
  void onResult(const NimBLEAdvertisedDevice* dev) override {
    const bool hasHid = dev->isAdvertisingService(NimBLEUUID(UUID_HID_SERVICE));
    settings::noteDevice(dev->getName(), dev->getAddress().toString(), dev->getRSSI(), hasHid);  // for the web portal
    if (haveTarget || connected || settings::browsing()) return;
    // Diagnostics: list every BLE device once (helps to see how the scanner advertises itself)
    static std::string seen[24];
    static int seenCount = 0;
    const std::string addr = dev->getAddress().toString();
    bool known = false;
    for (int i = 0; i < seenCount; i++) known |= (seen[i] == addr);
    if (!known) {
      if (seenCount < 24) seen[seenCount++] = addr;
      Serial.printf("BLE device: '%s' %s rssi=%d hid=%d services=%d first=%s\n", dev->getName().c_str(), addr.c_str(), dev->getRSSI(),
                    dev->isAdvertisingService(NimBLEUUID(UUID_HID_SERVICE)) ? 1 : 0, (int)dev->getServiceUUIDCount(),
                    dev->getServiceUUIDCount() > 0 ? dev->getServiceUUID(0).toString().c_str() : "-");
    }
    if (!settings::matchesScanner(dev->getName(), addr, hasHid)) return;
    Serial.printf("found scanner: %s (%s)\n", dev->getName().c_str(), dev->getAddress().toString().c_str());
    targetAddr = dev->getAddress();
    haveTarget = true;
    NimBLEDevice::getScan()->stop();
  }
} scanCallbacks;

class ClientCallbacks : public NimBLEClientCallbacks {
  void onDisconnect(NimBLEClient*, int reason) override {
    Serial.printf("scanner disconnected (reason %d)\n", reason);
    connected = false;
    needCleanup = true;
    lineBuf = "";
    memset(prevKeys, 0, sizeof(prevKeys));
  }
} clientCallbacks;

static bool subscribeHid(NimBLEClient* c) {
  NimBLERemoteService* svc = c->getService(NimBLEUUID(UUID_HID_SERVICE));
  if (!svc) {
    Serial.println("no HID service on device");
    return false;
  }
  int n = 0;
  for (auto* ch : svc->getCharacteristics(true)) {
    if (ch->getUUID() == NimBLEUUID(UUID_HID_REPORT) && ch->canNotify()) {
      if (ch->subscribe(true, onNotify)) n++;
    }
  }
  if (n == 0) {  // fall back to the boot keyboard input report
    NimBLERemoteCharacteristic* boot = svc->getCharacteristic(NimBLEUUID(UUID_BOOT_KEYBOARD_IN));
    if (boot && boot->canNotify() && boot->subscribe(true, onNotify)) n++;
  }
  Serial.printf("subscribed to %d HID report(s)\n", n);
  return n > 0;
}

// Subscribes to every notifiable characteristic except the generic GAP/GATT/device-info services.
static bool subscribeSerial(NimBLEClient* c) {
  int n = 0;
  for (auto* svc : c->getServices(true)) {
    const NimBLEUUID u = svc->getUUID();
    Serial.printf("service %s\n", u.toString().c_str());
    if (u == NimBLEUUID((uint16_t)0x1800) || u == NimBLEUUID((uint16_t)0x1801) || u == NimBLEUUID((uint16_t)0x180A)) continue;
    for (auto* ch : svc->getCharacteristics(true)) {
      Serial.printf("  characteristic %s notify=%d indicate=%d\n", ch->getUUID().toString().c_str(), ch->canNotify(), ch->canIndicate());
      if (ch->canNotify() && ch->subscribe(true, onSerialNotify)) n++;
      else if (ch->canIndicate() && ch->subscribe(false, onSerialNotify)) n++;
    }
  }
  Serial.printf("serial mode: subscribed to %d characteristic(s)\n", n);
  return n > 0;
}

static void connectScanner() {
  haveTarget = false;
  client = NimBLEDevice::createClient();
  client->setClientCallbacks(&clientCallbacks, false);
  client->setConnectTimeout(10000);
  Serial.printf("connecting to %s ...\n", targetAddr.toString().c_str());
  if (!client->connect(targetAddr)) {
    Serial.println("connect failed");
    NimBLEDevice::deleteClient(client);
    client = nullptr;
    return;
  }
  serialMode = (client->getService(NimBLEUUID(UUID_HID_SERVICE)) == nullptr);
  if (serialMode) {
    if (!subscribeSerial(client)) {
      client->disconnect();
      return;
    }
  } else {
    client->secureConnection();  // HID devices usually want an encrypted (bonded) link; best effort
    if (!subscribeHid(client)) {
      client->disconnect();
      return;
    }
  }
  connected = true;
  Serial.println("scanner ready");
  blink(3);
}

// ------------------------------------------------------------------ WiFi + HTTP
static void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  static uint32_t lastTry = 0;
  if (lastTry && millis() - lastTry < 30000) return;  // retry every 30 s; the setup portal keeps running meanwhile
  if (portal::clientConnectedToAp()) return;          // don't disturb someone who is configuring the device
  lastTry = millis();
  Serial.printf("WiFi connecting to %s ...\n", settings::cfg.ssid.c_str());
  if (!portal::apActive()) WiFi.mode(WIFI_STA);
  WiFi.begin(settings::cfg.ssid.c_str(), settings::cfg.pass.c_str());
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    portal::loop();
    delay(50);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("WiFi ok, IP %s (config page: http://%s/)\n", WiFi.localIP().toString().c_str(), WiFi.localIP().toString().c_str());
  } else {
    Serial.println("WiFi failed, opening setup portal");
    portal::startAp();
  }
}

static bool postCode(const char* code) {
  if (WiFi.status() != WL_CONNECTED) return false;
  String body = "{\"source\":\"esp32\",\"code\":\"";
  for (const char* p = code; *p; p++) {
    if (*p == '"' || *p == '\\') body += '\\';
    if ((uint8_t)*p >= 0x20) body += *p;
  }
  body += "\"}";
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(settings::cfg.serverUrl)) return false;
  http.addHeader("Content-Type", "application/json");
  if (settings::cfg.token.length() > 0) http.addHeader("Authorization", String("Bearer ") + settings::cfg.token);
  Serial.printf("-> POST %s\n   body: %s\n   WiFi: ip=%s rssi=%d dBm\n", settings::cfg.serverUrl.c_str(), body.c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
  const uint32_t t0 = millis();
  const int status = http.POST(body);
  String response = status > 0 ? http.getString() : HTTPClient::errorToString(status);
  http.end();
  if (response.length() > 300) response = response.substring(0, 300) + "...";
  const char* meaning = status == 200 ? "OK" : status == 401 ? "Token fehlt/falsch (API_TOKEN)" : status == 404 ? "URL/Pfad falsch" : status >= 500 ? "Serverfehler" :
                        status == HTTPC_ERROR_CONNECTION_REFUSED ? "Verbindung abgelehnt: Server/Port/Firewall" : status == HTTPC_ERROR_READ_TIMEOUT ? "Timeout beim Lesen" :
                        status == HTTPC_ERROR_CONNECTION_LOST ? "Verbindung verloren" : status < 0 ? "Verbindungsfehler" : "";
  Serial.printf("<- HTTP %d (%s) after %u ms: %s\n", status, meaning, (unsigned)(millis() - t0), response.c_str());
  return status >= 200 && status < 300;
}

// ------------------------------------------------------------------ Arduino entry points
void setup() {
  Serial.begin(115200);
  if (LED_PIN >= 0) {
    pinMode(LED_PIN, OUTPUT);
    led(false);
  }
  settings::begin(WIFI_SSID, WIFI_PASS, SERVER_URL, API_TOKEN, SCANNER_NAME_FILTER);
  WiFi.mode(WIFI_STA);  // initialises the TCP/IP stack; the web server must not start before this
  portal::begin();
  codeQueue = xQueueCreate(16, sizeof(Code));
  lineMutex = xSemaphoreCreateMutex();

  NimBLEDevice::init("beepstock-bridge");
  NimBLEDevice::setSecurityAuth(true, false, true);  // bonding, no MITM, secure connections
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setScanCallbacks(&scanCallbacks, false);
  scan->setActiveScan(true);
  scan->setInterval(100);
  scan->setWindow(99);
  ensureWifi();
}

extern "C" bool bridgeScannerConnected() { return connected; }  // used by the web portal status

void loop() {
  portal::loop();
  ensureWifi();

  // Portal "search scanner": drop the current connection so that scanning can list all devices;
  // when browsing ends restart the scan so the configured scanner is picked up again.
  if (settings::browsing() && connected && client) client->disconnect();
  if (settings::browseJustEnded()) NimBLEDevice::getScan()->stop();

  if (needCleanup) {  // never delete the client from inside its own callback
    needCleanup = false;
    if (client) {
      NimBLEDevice::deleteClient(client);
      client = nullptr;
    }
  }

  if (!connected) {
    if (haveTarget) {
      connectScanner();
    } else if (!NimBLEDevice::getScan()->isScanning()) {
      Serial.println("scanning for BLE HID scanner (wake it / press the trigger) ...");
      NimBLEDevice::getScan()->start(0, false);
    }
  }

  // Serial mode without terminator: flush a line that has been idle for 200 ms.
  if (connected && serialMode && lineBuf.length() > 0 && millis() - lastSerialMs > 200) {
    xSemaphoreTake(lineMutex, portMAX_DELAY);
    flushLine();
    xSemaphoreGive(lineMutex);
  }

  Code c;
  if (xQueuePeek(codeQueue, &c, 0) == pdTRUE) {
    if (postCode(c.text)) {
      xQueueReceive(codeQueue, &c, 0);
      blink(1, 40);
    } else {
      blink(4, 40);
      delay(1000);  // retry the same code
    }
  }
  delay(10);
}
