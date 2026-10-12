#include "portal.h"

#include <DNSServer.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <WiFi.h>

#include "settings.h"

namespace portal {

static const char* AP_SSID = "Beepstock-Setup";
static const char* AP_PASSWORD = "";  // empty = open network (min. 8 chars for WPA2)
static const int BUTTON_PIN = 9;      // BOOT button on most ESP32-C3 boards
static const uint32_t AP_IDLE_STOP_MS = 5UL * 60UL * 1000UL;

static WebServer server(80);
static DNSServer dns;
static bool apOn = false;
static uint32_t lastApClientMs = 0;
static uint32_t restartAt = 0;
static uint32_t pressedSince = 0;
static String networksJson = "[]";

static const char PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beepstock Bridge</title>
<style>
body{font:16px system-ui,sans-serif;margin:0;background:#f4f5f7;color:#1c1f24}
main{max-width:560px;margin:0 auto;padding:14px}
h1{font-size:20px;margin:6px 0 12px}
.card{background:#fff;border:1px solid #e1e4e8;border-radius:12px;padding:14px;margin-bottom:12px}
h2{font-size:16px;margin:0 0 10px}
label{display:block;font-size:14px;color:#6b7380;margin:8px 0 3px}
input,select{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #cfd4da;border-radius:8px;font:inherit}
button{padding:9px 14px;border:1px solid #cfd4da;border-radius:8px;background:#fff;font:inherit;cursor:pointer}
button.p{background:#2563eb;color:#fff;border-color:#2563eb}
.row{display:flex;gap:8px;align-items:center}.grow{flex:1}
.dev{display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #eee;font-size:15px}
.dev input{width:auto}.m{color:#6b7380;font-size:13px}
#msg{min-height:22px;font-weight:600}.ok{color:#16a34a}.err{color:#dc2626}
</style></head><body><main>
<h1>Beepstock Bridge</h1>
<div class="card"><div id="status" class="m">lädt …</div></div>

<form id="f" onsubmit="return false">
<div class="card"><h2>WLAN</h2>
<label>Netzwerk</label>
<div class="row"><select id="nets" class="grow"></select><button type="button" id="rescanWifi">Suchen</button></div>
<label>oder SSID manuell</label><input id="ssid" autocapitalize="none" autocomplete="off">
<label>Passwort <span class="m">(leer = unverändert)</span></label><input id="pass" type="password" autocomplete="new-password">
</div>

<div class="card"><h2>Beepstock-Server</h2>
<label>URL der Scan-Schnittstelle</label><input id="url" placeholder="http://192.168.1.10:8080/api/scan" autocapitalize="none">
<label>API-Token <span class="m">(leer = unverändert, nur nötig wenn am Server gesetzt)</span></label><input id="token" type="password" autocomplete="off">
<label class="m"><input type="checkbox" id="clearToken" style="width:auto"> Token entfernen</label>
<div class="row" style="margin-top:8px"><button type="button" id="test">Verbindung testen</button><span id="testres" class="m"></span></div>
</div>

<div class="card"><h2>Scanner (Bluetooth)</h2>
<div class="m" id="cur"></div>
<div id="devs" style="margin:8px 0"></div>
<button type="button" id="browse">Scanner neu suchen</button>
<div class="m" style="margin-top:6px">Scanner aufwecken (Auslöser drücken), damit er in der Liste erscheint. Während der Suche ist er kurz getrennt.</div>
</div>

<div class="row"><button class="p grow" id="save">Speichern und neu starten</button></div>
<p id="msg"></p>
</form>
</main>
<script>
const $=id=>document.getElementById(id);
let st=null,chosen=null,browsing=false;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function msg(t,c){const m=$('msg');m.textContent=t;m.className=c||'';}
async function j(u,o){const r=await fetch(u,o);return r.json();}
function drawNets(){
  const sel=$('nets');const cur=$('ssid').value;
  sel.innerHTML='<option value="">– Netzwerk wählen –</option>'+st.networks.map(n=>`<option value="${esc(n.ssid)}"${n.ssid===cur?' selected':''}>${esc(n.ssid)} (${n.rssi} dBm)</option>`).join('');
}
function drawDevs(){
  const d=st.devices;
  $('cur').textContent=chosen&&(chosen.addr||chosen.name)?`Gewählt: ${chosen.name||'(ohne Name)'} ${chosen.addr||''}`:'Gewählt: automatisch (erstes HID-Gerät)';
  $('devs').innerHTML=(d.length?'':'<div class="m">Noch kein Gerät gesehen.</div>')+d.map((x,i)=>
   `<label class="dev"><input type="radio" name="dev" value="${i}"${chosen&&chosen.addr===x.addr?' checked':''}>
    <span class="grow"><b>${esc(x.name||'(ohne Name)')}</b> <span class="m">${esc(x.addr)} · ${x.rssi} dBm${x.hid?' · HID':''}</span></span></label>`).join('')+
   `<label class="dev"><input type="radio" name="dev" value="auto"${!chosen||(!chosen.addr&&!chosen.name)?' checked':''}> <span>Automatisch (erstes HID-Gerät)</span></label>`;
  document.querySelectorAll('input[name=dev]').forEach(r=>r.onchange=()=>{
    chosen=r.value==='auto'?{name:'',addr:''}:{name:d[+r.value].name,addr:d[+r.value].addr};drawDevs();});
}
async function load(first){
  st=await j('/api/state');
  if(first){$('ssid').value=st.ssid;$('url').value=st.serverUrl;chosen={name:st.scannerName,addr:st.scannerAddr};}
  $('status').innerHTML=`WLAN: ${st.wifiConnected?'verbunden ('+esc(st.ssid)+', '+esc(st.ip)+')':'<b class="err">nicht verbunden</b>'}<br>Scanner: ${st.scannerConnected?'<b class="ok">verbunden</b>':'nicht verbunden'}`;
  drawNets();drawDevs();browsing=st.browsing;
}
$('nets').onchange=e=>{if(e.target.value)$('ssid').value=e.target.value;};
$('rescanWifi').onclick=async()=>{$('rescanWifi').textContent='…';st.networks=(await j('/api/wifiscan')).networks;drawNets();$('rescanWifi').textContent='Suchen';};
$('browse').onclick=async()=>{await fetch('/api/browse',{method:'POST'});msg('Suche läuft (20 s) …');};
$('test').onclick=async()=>{
  $('testres').textContent='teste …';$('testres').className='m';
  const r=await j('/api/test?url='+encodeURIComponent($('url').value));
  $('testres').textContent=r.ok?`OK (HTTP ${r.status}, ${r.ms} ms)`:`Fehler: ${r.error||('HTTP '+r.status)}`;
  $('testres').className=r.ok?'m ok':'m err';
};
$('save').onclick=async()=>{
  const b=new URLSearchParams({ssid:$('ssid').value,pass:$('pass').value,url:$('url').value,token:$('token').value,
    clearToken:$('clearToken').checked?'1':'0',scannerName:chosen?chosen.name:'',scannerAddr:chosen?chosen.addr:''});
  const r=await j('/api/save',{method:'POST',body:b});
  if(r.ok)msg('Gespeichert, das Gerät startet neu …','ok');else msg(r.error||'Fehler','err');
};
load(true);setInterval(()=>{if(!document.hidden)load(false);},2500);
</script></body></html>)HTML";

static String esc(const String& s) {
  String o;
  o.reserve(s.length() + 8);
  for (size_t i = 0; i < s.length(); i++) {
    const char c = s[i];
    if (c == '"' || c == '\\') {
      o += '\\';
      o += c;
    } else if ((uint8_t)c < 0x20) {
      o += ' ';
    } else {
      o += c;
    }
  }
  return o;
}

static void scanNetworks() {
  const int n = WiFi.scanNetworks();
  String out = "[";
  bool first = true;
  for (int i = 0; i < n; i++) {
    String s = WiFi.SSID(i);
    if (s.length() == 0) continue;
    if (!first) out += ',';
    first = false;
    out += "{\"ssid\":\"" + esc(s) + "\",\"rssi\":" + String(WiFi.RSSI(i)) + "}";
  }
  out += "]";
  networksJson = out;
  WiFi.scanDelete();
}

// ---------------------------------------------------------------- handlers

extern "C" bool bridgeScannerConnected();  // provided by main.cpp

static void handleState() {
  String j = "{";
  j += "\"ssid\":\"" + esc(settings::cfg.ssid) + "\",";
  j += "\"serverUrl\":\"" + esc(settings::cfg.serverUrl) + "\",";
  j += "\"tokenSet\":" + String(settings::cfg.token.length() ? "true" : "false") + ",";
  j += "\"scannerName\":\"" + esc(settings::cfg.scannerName) + "\",";
  j += "\"scannerAddr\":\"" + esc(settings::cfg.scannerAddr) + "\",";
  j += "\"wifiConnected\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false") + ",";
  j += "\"ip\":\"" + (WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("")) + "\",";
  j += "\"ap\":" + String(apOn ? "true" : "false") + ",";
  j += "\"scannerConnected\":" + String(bridgeScannerConnected() ? "true" : "false") + ",";
  j += "\"browsing\":" + String(settings::browsing() ? "true" : "false") + ",";
  j += "\"networks\":" + networksJson + ",\"devices\":[";
  settings::Seen seen[16];
  const int n = settings::devices(seen, 16);
  for (int i = 0; i < n; i++) {
    if (i) j += ',';
    j += "{\"name\":\"" + esc(seen[i].name) + "\",\"addr\":\"" + esc(seen[i].addr) + "\",\"rssi\":" + String(seen[i].rssi) +
         ",\"hid\":" + (seen[i].hid ? "true" : "false") + "}";
  }
  j += "]}";
  server.send(200, "application/json", j);
}

static bool validUrl(const String& u) { return (u.startsWith("http://") || u.startsWith("https://")) && u.length() > 10 && u.length() < 200; }

static void handleSave() {
  String ssid = server.arg("ssid");
  ssid.trim();
  String url = server.arg("url");
  url.trim();
  if (ssid.length() == 0 || ssid.length() > 32) return server.send(400, "application/json", "{\"ok\":false,\"error\":\"SSID fehlt oder ist zu lang\"}");
  if (!validUrl(url)) return server.send(400, "application/json", "{\"ok\":false,\"error\":\"URL muss mit http:// oder https:// beginnen\"}");
  settings::cfg.ssid = ssid;
  if (server.arg("pass").length() > 0) settings::cfg.pass = server.arg("pass");
  settings::cfg.serverUrl = url;
  if (server.arg("token").length() > 0) settings::cfg.token = server.arg("token");
  if (server.arg("clearToken") == "1") settings::cfg.token = "";
  settings::cfg.scannerName = server.arg("scannerName");
  settings::cfg.scannerAddr = server.arg("scannerAddr");
  settings::save();
  server.send(200, "application/json", "{\"ok\":true}");
  restartAt = millis() + 1500;
}

static void handleTest() {
  String url = server.arg("url");
  url.trim();
  if (!validUrl(url)) return server.send(200, "application/json", "{\"ok\":false,\"error\":\"ungültige URL\"}");
  if (WiFi.status() != WL_CONNECTED)
    return server.send(200, "application/json", "{\"ok\":false,\"error\":\"Gerät ist nicht mit dem WLAN verbunden (erst speichern und verbinden)\"}");
  int slash = url.indexOf('/', url.indexOf("://") + 3);
  const String base = slash < 0 ? url : url.substring(0, slash);
  HTTPClient http;
  http.setTimeout(5000);
  if (!http.begin(base + "/healthz")) return server.send(200, "application/json", "{\"ok\":false,\"error\":\"URL nicht nutzbar\"}");
  const uint32_t t0 = millis();
  const int status = http.GET();
  const uint32_t ms = millis() - t0;
  const String err = status < 0 ? HTTPClient::errorToString(status) : String("");
  http.end();
  server.send(200, "application/json",
              "{\"ok\":" + String(status == 200 ? "true" : "false") + ",\"status\":" + String(status) + ",\"ms\":" + String(ms) + ",\"error\":\"" + esc(err) + "\"}");
}

static void handleNotFound() {
  if (apOn && server.hostHeader() != WiFi.softAPIP().toString()) {  // captive portal: send every unknown host to the setup page
    server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/");
    server.send(302, "text/plain", "");
    return;
  }
  server.send(404, "text/plain", "Not found");
}

// ---------------------------------------------------------------- public API

void begin() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  server.on("/", HTTP_GET, []() { server.send_P(200, "text/html; charset=utf-8", PAGE); });
  server.on("/api/state", HTTP_GET, handleState);
  server.on("/api/wifiscan", HTTP_GET, []() {
    scanNetworks();
    server.send(200, "application/json", String("{\"networks\":") + networksJson + "}");
  });
  server.on("/api/browse", HTTP_POST, []() {
    settings::startBrowse(20000);
    server.send(200, "application/json", "{\"ok\":true}");
  });
  server.on("/api/save", HTTP_POST, handleSave);
  server.on("/api/test", HTTP_GET, handleTest);
  // common captive-portal probe URLs
  server.on("/generate_204", HTTP_GET, handleNotFound);
  server.on("/hotspot-detect.html", HTTP_GET, handleNotFound);
  server.on("/connecttest.txt", HTTP_GET, handleNotFound);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("config portal: http server started on port 80");
}

void startAp() {
  if (apOn) return;
  WiFi.mode(WIFI_AP_STA);
  const bool ok = (strlen(AP_PASSWORD) >= 8) ? WiFi.softAP(AP_SSID, AP_PASSWORD) : WiFi.softAP(AP_SSID);
  if (!ok) {
    Serial.println("config portal: softAP failed");
    return;
  }
  dns.start(53, "*", WiFi.softAPIP());
  apOn = true;
  lastApClientMs = millis();
  scanNetworks();
  Serial.printf("config portal: connect to WiFi '%s' and open http://%s/\n", AP_SSID, WiFi.softAPIP().toString().c_str());
}

static void stopAp() {
  dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  apOn = false;
  Serial.println("config portal: setup AP closed");
}

bool apActive() { return apOn; }
bool clientConnectedToAp() { return apOn && WiFi.softAPgetStationNum() > 0; }

void loop() {
  server.handleClient();
  if (apOn) {
    dns.processNextRequest();
    if (WiFi.softAPgetStationNum() > 0) lastApClientMs = millis();
    else if (WiFi.status() == WL_CONNECTED && millis() - lastApClientMs > AP_IDLE_STOP_MS) stopAp();
  }

  if (digitalRead(BUTTON_PIN) == LOW) {  // hold BOOT for 2 s -> open setup AP
    if (!pressedSince) pressedSince = millis();
    else if (millis() - pressedSince > 2000 && !apOn) startAp();
  } else {
    pressedSince = 0;
  }

  if (restartAt && (int32_t)(millis() - restartAt) >= 0) {
    Serial.println("settings saved, restarting ...");
    delay(100);
    ESP.restart();
  }
}

}  // namespace portal
