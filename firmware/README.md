# Beepstock scanner bridge (ESP32-C3)

Bridges a Bluetooth LE barcode scanner to WiFi: the ESP32-C3 connects to the scanner, reads the barcodes and sends each one to
Beepstock (`POST /api/scan`). Works with BLE-HID scanners and scanners that send plain text over a vendor GATT service
("BLE serial"). The ESP32-C3 has **no Bluetooth Classic**, so the scanner must be in a BLE mode.

## Build and flash (PlatformIO)

Open **this folder** (`firmware/`) in VS Code, then *Upload* (or `platformio run -t upload`). Set `upload_port` / `monitor_port`
in `platformio.ini` to your COM port. If the chip is not found, hold BOOT, tap RESET, release BOOT.

## Configuration

* Optional build-time defaults: copy `src/secrets.example.h` to `src/secrets.h` (git-ignored) and fill in WiFi and server URL.
* At runtime everything can be changed in the device's **web portal** (values saved there take precedence):
  * If WiFi is missing or fails, the device opens the access point **`Beepstock-Setup`** (captive portal, `http://192.168.4.1/`).
  * Hold the **BOOT** button for 2 s to open it at any time; when connected, the page is also at `http://<device-ip>/`.
  * Choose WiFi, the Beepstock URL (+ token), the scanner (list of nearby BLE devices) and test the server connection.

The serial monitor (115200 baud) shows found devices, raw scanner data, each scan, the URL called and the server's response.
