#include "settings.h"

#include <Preferences.h>

namespace settings {

Config cfg;

static const char* NS = "pantry";
static const int MAX_SEEN = 16;
static Seen seen[MAX_SEEN];
static int seenCount = 0;
static SemaphoreHandle_t seenMutex = nullptr;
static uint32_t browseUntil = 0;
static bool browseActive = false;
static bool browseEnded = false;

void begin(const char* defSsid, const char* defPass, const char* defUrl, const char* defToken, const char* defScannerName) {
  seenMutex = xSemaphoreCreateMutex();
  Preferences p;
  p.begin(NS, false);  // read-write so the namespace is created on first boot (read-only gives NOT_FOUND)
  cfg.ssid = p.getString("ssid", defSsid);
  cfg.pass = p.getString("pass", defPass);
  cfg.serverUrl = p.getString("url", defUrl);
  cfg.token = p.getString("token", defToken);
  cfg.scannerName = p.getString("sname", defScannerName);
  cfg.scannerAddr = p.getString("saddr", "");
  p.end();
}

void save() {
  Preferences p;
  p.begin(NS, false);
  p.putString("ssid", cfg.ssid);
  p.putString("pass", cfg.pass);
  p.putString("url", cfg.serverUrl);
  p.putString("token", cfg.token);
  p.putString("sname", cfg.scannerName);
  p.putString("saddr", cfg.scannerAddr);
  p.end();
}

void noteDevice(const std::string& name, const std::string& addr, int rssi, bool hid) {
  if (!seenMutex) return;
  xSemaphoreTake(seenMutex, portMAX_DELAY);
  int idx = -1;
  for (int i = 0; i < seenCount; i++) {
    if (seen[i].addr.equalsIgnoreCase(addr.c_str())) idx = i;
  }
  if (idx < 0) {
    if (seenCount < MAX_SEEN) {
      idx = seenCount++;
    } else {  // replace the oldest entry
      idx = 0;
      for (int i = 1; i < MAX_SEEN; i++)
        if (seen[i].lastMs < seen[idx].lastMs) idx = i;
    }
    seen[idx].addr = addr.c_str();
  }
  if (name.length() > 0) seen[idx].name = name.c_str();  // scan responses may omit the name
  seen[idx].rssi = rssi;
  seen[idx].hid = seen[idx].hid || hid;
  seen[idx].lastMs = millis();
  xSemaphoreGive(seenMutex);
}

int devices(Seen* out, int max) {
  if (!seenMutex) return 0;
  xSemaphoreTake(seenMutex, portMAX_DELAY);
  int n = seenCount < max ? seenCount : max;
  for (int i = 0; i < n; i++) out[i] = seen[i];
  xSemaphoreGive(seenMutex);
  // newest first (insertion sort, tiny list)
  for (int i = 1; i < n; i++) {
    Seen s = out[i];
    int j = i - 1;
    while (j >= 0 && out[j].lastMs < s.lastMs) {
      out[j + 1] = out[j];
      j--;
    }
    out[j + 1] = s;
  }
  return n;
}

bool matchesScanner(const std::string& name, const std::string& addr, bool hasHid) {
  const bool haveAddr = cfg.scannerAddr.length() > 0;
  const bool haveName = cfg.scannerName.length() > 0;
  if (!haveAddr && !haveName) return hasHid;
  // Either matches: the address is exact, the name survives scanners that change their (random) BLE address.
  if (haveAddr && cfg.scannerAddr.equalsIgnoreCase(addr.c_str())) return true;
  return haveName && name.find(cfg.scannerName.c_str()) != std::string::npos;
}

void startBrowse(uint32_t ms) {
  browseUntil = millis() + ms;
  browseActive = true;
}

bool browsing() {
  if (browseActive && (int32_t)(millis() - browseUntil) >= 0) {
    browseActive = false;
    browseEnded = true;
  }
  return browseActive;
}

bool browseJustEnded() {
  browsing();  // refresh state
  const bool e = browseEnded;
  browseEnded = false;
  return e;
}

}  // namespace settings
