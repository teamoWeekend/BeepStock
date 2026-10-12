#pragma once
/*
 * Configuration web interface for the bridge.
 *
 *  - Always reachable on port 80 at the device IP (http://<ip>/) once WiFi is connected.
 *  - When WiFi is missing or fails, or the BOOT button (GPIO9) is held for 2 s, the device opens the access point
 *    "Beepstock-Setup" with a captive portal at http://192.168.4.1/ .
 *  - Lets you choose the WiFi network, the Beepstock URL (+ token) and the BLE scanner, and test the server.
 */
namespace portal {

void begin();    // register routes and start the HTTP server (call once in setup, after settings::begin)
void loop();     // call often from loop(): serves requests, DNS, BOOT button, deferred restart
void startAp();  // open the setup access point (idempotent)
bool apActive();
bool clientConnectedToAp();  // someone is using the setup AP right now

}  // namespace portal
