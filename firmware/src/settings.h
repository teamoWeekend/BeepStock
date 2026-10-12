#pragma once
/*
 * Persistent settings (NVS flash) + list of BLE devices seen, shared between the bridge code and the web portal.
 * Values that were never saved fall back to the defaults passed to begin(), i.e. the constants in main.cpp.
 */
#include <Arduino.h>
#include <string>

namespace settings {

struct Config {
  String ssid;
  String pass;
  String serverUrl;    // full URL of the scan endpoint, e.g. http://192.168.1.10:8080/api/scan
  String token;        // Beepstock API_TOKEN, "" = none
  String scannerName;  // substring of the BLE name, "" = not used
  String scannerAddr;  // BLE address of the chosen scanner, "" = not used (falls back to name / HID service)
};

extern Config cfg;

void begin(const char* defSsid, const char* defPass, const char* defUrl, const char* defToken, const char* defScannerName);
void save();

// ---- BLE devices seen while scanning (filled from the BLE callback, read by the portal)
struct Seen {
  String name;
  String addr;
  int rssi;
  bool hid;
  uint32_t lastMs;
};
void noteDevice(const std::string& name, const std::string& addr, int rssi, bool hid);
int devices(Seen* out, int max);  // newest first

// Does this advertising device match the configured scanner?
bool matchesScanner(const std::string& name, const std::string& addr, bool hasHid);

// "Browse" mode: scanning goes on, but no connection is made so that the portal can list devices.
void startBrowse(uint32_t ms);
bool browsing();
bool browseJustEnded();  // true exactly once after browsing ended

}  // namespace settings
