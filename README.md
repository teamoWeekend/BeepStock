<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="branding/logo-wordmark-dark.svg">
    <img src="branding/logo-wordmark.svg" alt="Beepstock" width="380">
  </picture>
</p>

<p align="center"><b>Scan it. Stock it. Waste less.</b></p>

**Beepstock** ist eine selbst gehostete Vorratsverwaltung für den Kühlschrank: Barcode scannen (Hardware-Scanner, ESP32-Bridge oder Handykamera),
Produktdaten und Nährwerte kommen von [Open Food Facts](https://world.openfoodfacts.org) und seinen Schwesterdatenbanken. Daraus entstehen Vorrat,
Einkaufsliste, Anbruch-Verwaltung, Inventur und eine Auswertung, wie viel du aufbrauchst und wie viel du wegwirfst.

Node.js + TypeScript (Fastify), PostgreSQL über Drizzle ORM, Web-UI ohne Build-Schritt, Betrieb per Docker. Lizenz: [MIT](LICENSE).

## Start

```sh
cp .env.example .env     # POSTGRES_PASSWORD anpassen
docker compose up -d --build
```

Einstellungen für Ports, Passwort, Hostnamen und Token stehen in der `.env` (Vorlage: `.env.example`).

Dann `http://<host>:8080` im Browser öffnen (Tablet/Handy am Kühlschrank, Seite offen lassen).
Optional: `API_TOKEN=geheim` und `POSTGRES_PASSWORD=…` in einer `.env` neben der `docker-compose.yml`.

Entwicklung: `npm install`, Postgres starten (`docker compose up -d db`, Port-Mapping `5432:5432` ergänzen),
`DATABASE_URL=postgres://pantry:pantry@localhost:5432/pantry npm run dev`.

## Scanner anbinden

Die App ist scanner-agnostisch, alle Wege landen in derselben Logik:

| Weg | Wie |
|---|---|
| **USB-/Bluetooth-/Dongle-Scanner als Tastatur (HID)** | Scanner mit dem Gerät koppeln, das die Seite offen hat. Die Seite erkennt schnelle Tasteneingaben + Enter global, kein Fokus nötig. |
| **REST** | `POST /api/scan` mit `{"code":"4006381333931"}` oder `GET /api/scan?code=…` |
| **WebSocket** | `ws://host:8080/ws`: Barcode als Text (oder `{"code":"…"}`) senden. Ergebnisse, Zustand und Änderungen kommen als `{type,data}` zurück. |
| **Scanner-Apps / ESP32 / Skripte** | über REST oder WebSocket; mit Token: `Authorization: Bearer …` oder `?token=…` |

## Kamera-Scanner (Handy/Tablet)

Knopf **Kamera** (oben rechts, auf dem Handy der runde Knopf unten rechts, auf der Scan-Seite „Mit der Kamera scannen“).
Erkennung und Auslösen laufen komplett im Browser: eingebaute `BarcodeDetector`-API, sonst ZXing (wird vom Server
ausgeliefert und nur bei Bedarf geladen). Das Overlay bleibt offen und scannt fortlaufend (gleicher Code wird 3 s lang
nur einmal gezählt), mit Vibration/Ton, Licht, Zoom und Kamerawechsel. Unten lassen sich Modus, Lagerort, MHD
(+1 T … +6 M, nach dem Einlagern), Menge, Rückgängig und Eintippen direkt bedienen. Ein Foto-Fallback gibt es, wenn
keine Live-Kamera möglich ist.

**HTTPS ist nötig**, weil Browser die Kamera nur auf `https://` oder `localhost` freigeben. Die docker-compose.yml
startet deshalb zusätzlich `https://<server>:8443` mit einem selbst signierten Zertifikat (Warnung einmal pro Gerät
bestätigen, bei Chrome „Erweitert → Weiter“). Trage die LAN-IP des Servers in eine `.env` ein: `TLS_HOSTS=192.168.1.10`
(mehrere mit Komma). WebSocket und alles andere laufen auch über 8443. `HTTPS_PORT=0` schaltet es ab.
Mit `?camdry=1` an der Adresse zeigt der Scanner nur, was er erkennt, ohne etwas zu buchen.

## Schnellsuche

Knopf **Suchen** oben rechts oder die Taste `/` (auf jeder Seite). Ein paar Buchstaben aus Name, Marke oder Barcode genügen, mehrere
Wörter in beliebiger Reihenfolge („milch weide“). Was im Vorrat ist, steht oben, mit Anzahl, Lagerort, Anbruch und nächstem MHD.
Pfeiltasten wählen, Enter öffnet die Produktdetails, Esc schließt.

## Modi und Steuercodes

Unter **Steuercodes** gibt es druckbare Code-128-Barcodes (am Kühlschrank aufhängen). Sie nutzen nur Buchstaben
und Ziffern (ohne Y/Z), damit sie auch bei falschem Tastaturlayout am HID-Scanner ankommen.

* **Modus** (bleibt aktiv, bis ein anderer gescannt wird): `PCADD` Einlagern, `PCCONSUME` Verbrauchen,
  `PCOPEN` Anbrechen, `PCWASTE` Wegwerfen, `PCSHOP` Einkaufsliste, `PCINFO` nur Info, `PCINV` Inventur.
* **Lagerort** (`PCLOC1`, `PCLOC2`, …): gilt für alle folgenden Produkte, bis ein anderer Lagerort gescannt wird.
  Lagerorte (Kühlschrank, Tiefkühler, Vorratsschrank, Keller vorbelegt) legst du im Tab „Steuercodes“ an, benennst sie um
  oder löschst sie; der Barcode-Bogen passt sich an. Pro Packung lässt sich der Lagerort im Vorrat nachträglich ändern.
* **MHD (optional, NACH dem Produkt)**: erst Produkt scannen, dann bei Bedarf das MHD. `PCD3` = heute + 3 Tage, `PCW2` = +2 Wochen,
  `PCM1` = +1 Monat, `PCJ1` = +1 Jahr, `PCT20261231` = festes Datum. Oder eintippen mit `PCN0`…`PCN9`, dann `PCNOK`
  (1–3 Ziffern = Tage, `TTMM`, `TTMMJJ`, `TTMMJJJJ`). Das Datum gilt für die zuletzt eingelagerte(n) Packung(en), solange
  danach nichts anderes gescannt wurde; ein erneuter MHD-Code korrigiert es. Ohne vorherigen Einlagerungsscan wird er verworfen.
* `PCQ2`…: Menge für den nächsten Scan. `PCUNDO`: letzte Aktion rückgängig. `PCCLEAR`: Menge verwerfen.

Beispiel Einkauf einräumen: `PCADD` → `PCLOC1` → Joghurt scannen → `PCD3` → Milch scannen → `PCLOC3` → Nudeln scannen → `PCM6` …
Ohne MHD-Scan gilt die pro Produkt hinterlegte Standard-Haltbarkeit, sonst wird ohne MHD eingelagert (das ist in Ordnung).

## Inventur

Tab **Inventur**: zählen, was wirklich da ist, und mit dem Bestand vergleichen.

1. **Starten**: Lagerorte wählen und „Inventur starten“ (schaltet den Modus **Inventur** ein, Code `PCINV`). Per Scanner geht es
   auch ohne Klick: `PCINV` scannen, der Ort wird beim ersten Scan automatisch aufgenommen.
2. **Zählen**: Lagerort-Code scannen, dann jede Packung dieses Ortes scannen (auch mit Kamera, `PCQ3` für mehrere). Beim Zählen wird
   nichts gebucht. Orte, in denen gescannt wurde, gelten als gezählt; nicht gescannte Produkte erscheinen mit Inventurwert 0.
3. **Vergleichen**: je Produkt und Lagerort **Vorher** (Bestand in der App) gegen **Inventur** (gezählt), mit +/− zum Korrigieren.
   Pro Zeile ein Klick: „Vorher behalten“ (nichts ändert sich) oder „Inventur übernehmen“ (Bestand wird auf den gezählten Wert gesetzt).
   Oben gibt es dieselben Entscheidungen für alle offenen Abweichungen auf einmal.
4. **Abschließen** beendet die Zählung.

Übernehmen fügt fehlende Packungen ohne MHD hinzu oder nimmt überzählige heraus (zuerst angebrochene, dann früheste MHD). Entnommene
Packungen bekommen den Status „korrigiert“, **nicht** „aufgebraucht“ oder „weggeworfen“, die Auswertung bleibt also sauber. Fällt ein Produkt dadurch
unter den Mindestbestand, kommt es auf die Einkaufsliste. `PCUNDO` nimmt den letzten Zählscan bzw. die letzte Übernahme zurück.

## Steuercodes drucken

Tab **Steuercodes** → **Drucken** (Browser-Druckdialog; „Tatsächliche Größe / 100 %“, Ränder „Keine“, Kopf-/Fußzeilen aus):

* **Übersicht A4**: eine gestaltete DIN-A4-Seite mit allen Codes, farbig nach Gruppen (Modus, Lagerort, MHD, Ziffern, Sonstiges).
* **Etiketten**: dieselben Codes auf Etikettenpapier, voreingestellt für den A4-Bogen 4 × 16 à 48,5 × 16,9 mm (64 pro Bogen),
  also dasselbe Papier wie in `etiketten.py`. Einstellbar sind Raster, Maße, Abstände, Ränder, Innenrand, Druckerversatz
  (+ = rechts/oben), bereits benutzte Etiketten (angebrochener Bogen), Kopien pro Code, enthaltene Gruppen, Rahmen für
  einen Testdruck auf normalem Papier und der Klartext unter dem Barcode. Die Einstellungen merkt sich der Browser.
  Geometrie wie im Skript (Raster mittig auf A4, Balkenmodul höchstens 0,45 mm, Warnung unter 0,19 mm).

## Logik

* **Vorrat**: eine Zeile pro Packung. Verbrauchen/Wegwerfen nimmt zuerst angebrochene, dann die mit dem frühesten MHD.
* **Anbruch**: Anbrechen markiert die Packung mit dem frühesten MHD. Pro Produkt kann „haltbar nach Anbruch (Tage)“
  gesetzt werden; das effektive Ablaufdatum ist das frühere von MHD und Anbruch + Tage.
* **Einkaufsliste**: manuell, per Scan (`PCSHOP`) oder automatisch, wenn der **Mindestbestand** eines Produkts unterschritten wird.
  Einlagern hakt offene Einträge des Produkts ab.
* **Verlauf**: weggeworfen / verbraucht mit Zeitstempel; Kennzahlen der letzten 30 Tage auf dem Scan-Tab.
* **Nährwerte**: je 100 g/ml, Nutri-Score, Zutaten, Allergene in den Produktdetails. Unbekannte Produkte werden angelegt
  und sofort zum Benennen angeboten; Open Food Facts wird später automatisch erneut gefragt.

## Einstellungen (Tab „Einstellungen“)

* **Lagerorte**: Namen, **Typ** (Kühlschrank / Tiefkühler / Vorrat / Sonstiges), Anlegen, Löschen; zeigt den Steuercode (`PCLOC<n>`).
  Der Typ steuert die automatische Zuordnung der Produkte und das Umlagern beim Anbrechen (Vorrat → Kühlschrank).
* **Läden**: anlegen, umbenennen, löschen, Reihenfolge (bestimmt die Sortierung der Einkaufsliste).
* **Scannen und Verhalten** (gilt für alle Geräte, in der Datenbank gespeichert, Umgebungsvariablen liefern nur die Vorgabe):
  Modus nach Leerlauf, Leerlaufzeit, Verfall von MHD/Menge, Schwelle „Läuft bald ab“, Einkaufsliste auch beim Wegwerfen.
* **Produktdatenbanken**: Open Food/Beauty/Products/Pet Food Facts einzeln an/aus und in der Abfrage-Reihenfolge.
* **Darstellung und Kamera** (pro Gerät): Design, Signalton, Vibration.
* **Wartung**: Standard-Lagerorte neu berechnen (nach geänderten Typen), unbekannte Produkte erneut abfragen,
  **Datensicherung** als JSON-Download. **System**: Version, Datenmengen, Adressen, HTTPS, Token-Status.

Port, Datenbank, `API_TOKEN` und HTTPS bleiben Umgebungsvariablen (`docker-compose.yml` / `.env`), sie lassen sich nicht aus der
Oberfläche ändern.

## Produktbilder (lokaler Cache)

Produktbilder werden beim ersten Scan einmal von den Open-*-Facts-Servern geladen und in einem Docker-Volume (`images`, `IMAGE_DIR`,
Standard `/data/images`) gespeichert; die Oberfläche lädt sie dann nur noch von deinem Server (`/img/<Datei>`). Der Browser darf sie
lange zwischenspeichern, die URL enthält eine Versionskennung und ändert sich, wenn das Quellbild wechselt. Beim Download werden nur
`https`-Adressen der vier Open-*-Facts-Domains akzeptiert, Größe (2 MB) und Dateityp (JPEG/PNG/WebP, geprüft an den ersten Bytes)
begrenzt. Bereits vorhandene Produkte werden beim Start im Hintergrund nachgeladen. In den Einstellungen: Schalter, „Bilder jetzt lokal
speichern“, „Bilder-Cache leeren“ und die Größe des Caches. Schlägt ein Download fehl, bleibt die Original-Adresse als Rückfall.

## Datensicherung: Export und Import

Einstellungen → Wartung: **Export** lädt eine JSON-Datei (Produkte, Vorrat, Lagerorte, Läden, Einkaufsliste, Einstellungen).
**Wiederherstellen** liest sie wieder ein, mit Vorschau (Datei gegen aktuellen Stand) und zwei Modi:

* **Zusammenführen**: ergänzt fehlende Lagerorte und Läden (Abgleich über den Namen) und fehlende Produkte (Abgleich über den Barcode).
  Bestand, Einkaufsliste und Einstellungen bleiben unverändert; ein zweiter Durchlauf ändert nichts mehr.
* **Alles ersetzen**: ersetzt den gesamten Datenbestand durch die Datei (IDs bleiben erhalten), nur nach ausdrücklicher Bestätigung.

Schutz: Die Datei wird vor dem Schreiben geprüft und bereinigt (Typen, Längen, Verweise auf fehlende Lagerorte/Läden/Produkte werden
entfernt oder gemeldet). Vor jedem Import legt der Server automatisch eine Sicherung des aktuellen Stands an (`BACKUP_DIR`, Volume `backups`,
die letzten 5, in den Einstellungen herunterladbar). Das Schreiben läuft in einer Transaktion: bei einem Fehler bleibt alles unverändert.
Eine leere Sicherung ersetzt nie etwas. Bilder sind nicht Teil der Datei, sie werden nach dem Import neu geladen.

## Betrieb auf einem Server (eine Compose-Datei, eine .env)

Es genügen zwei Dateien auf dem Server: `docker-compose.yml` und `.env`. Der Server baut nichts, er lädt das fertige Image
`ghcr.io/teamoweekend/beepstock` (öffentlich, ohne Login), das GitHub Actions bei jedem Push auf `main` für amd64 und arm64 baut.
Der Server braucht nur Docker mit Compose v2 und die Ports 8080 und 8443.

1. **Ordner anlegen und Compose-Datei holen**:
   ```sh
   mkdir -p ~/beepstock && cd ~/beepstock
   curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/teamoWeekend/BeepStock/main/docker-compose.yml
   ```
2. **`.env` anlegen**:
   ```sh
   cat > .env <<EOF
   COMPOSE_PROJECT_NAME=beepstock
   POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/')
   TLS_HOSTS=server.example.lan,192.168.1.10
   API_TOKEN=
   EOF
   chmod 600 .env
   ```
   `TLS_HOSTS`: Name und IP des Servers (HTTPS-Zertifikat für die Handy-Kamera). `API_TOKEN` leer lassen oder ein langes Geheimnis setzen.
3. **Starten**: `docker compose up -d` (lädt beim ersten Mal die Images).
4. **Prüfen**: `docker compose ps` (beide Dienste „healthy“), `http://<server>:8080` und `https://<server>:8443` (Zertifikatswarnung einmal pro Gerät bestätigen).

### Daten von der alten Installation mitnehmen

Dump auf der **alten** Installation erzeugen (im Projektordner; unter Git Bash vorher `export MSYS_NO_PATHCONV=1`):

```sh
docker compose exec -T db sh -c "pg_dump -U pantry --clean --if-exists --no-owner pantry > /tmp/beepstock.sql"
docker compose cp db:/tmp/beepstock.sql ./beepstock.sql
docker compose exec -T db rm /tmp/beepstock.sql
```

Die Datei auf den Server kopieren und dort einspielen, **bevor die App zum ersten Mal startet** (also statt Schritt 3):

```sh
docker compose up -d db
docker compose cp beepstock.sql db:/tmp/restore.sql
docker compose exec -T db psql -U pantry -d pantry -v ON_ERROR_STOP=1 -q -f /tmp/restore.sql
docker compose exec -T db rm /tmp/restore.sql
docker compose up -d
```

Der Dump enthält alles inklusive Verlauf, Produktbilder und das HTTPS-Zertifikat werden neu erzeugt. Alternativ geht die JSON-Datensicherung unter
Einstellungen → Wartung (mit Vorschau, siehe oben), sie enthält keinen Verlauf. Danach die Geräte umstellen: ESP32-Bridge im Portal (BOOT 2 s halten
oder `http://<Geräte-IP>/`) auf `http://<server>:8080/api/scan` und „Verbindung testen“ (löst der Router den Namen nicht auf, die IP verwenden);
Handys und Tablets: neue Adresse, Kamera über `https://`; bei gesetztem `API_TOKEN` den Token im ESP32-Portal und einmalig im Browser eintragen.
Zum Schluss die alte Installation mit `docker compose down` stoppen (die Volumes bleiben, erst löschen, wenn alles läuft).

### Betrieb

* **Update**: `docker compose pull && docker compose up -d`. Das lädt das neueste Image von `main`, die Daten bleiben erhalten.
  Eine bestimmte Version legst du mit `BEEPSTOCK_IMAGE=ghcr.io/teamoweekend/beepstock:<tag>` in der `.env` fest
  (Tags: `latest`, `sha-<Commit kurz>`, bei Git-Tags wie `v1.2.3` die Version).
* **Logs**: `docker compose logs -f app` (Rotation auf 3 × 10 MB begrenzt). Nach einem Neustart des Servers starten die Container von selbst
  (`restart: unless-stopped`, der Docker-Dienst muss beim Boot laufen).
* **Backup** (auf dem Server, z. B. per Cron, hier jede Nacht um 03:30; die Dumps der letzten 14 Tage bleiben):
  ```sh
  30 3 * * *  cd /home/benutzer/beepstock && docker compose exec -T db pg_dump -U pantry --clean --if-exists --no-owner pantry | gzip > /home/benutzer/backups/beepstock-$(date +\%F).sql.gz && find /home/benutzer/backups -name 'beepstock-*.sql.gz' -mtime +14 -delete
  ```
  Wiederherstellen: `gunzip -c beepstock-<Datum>.sql.gz | docker compose exec -T db psql -U pantry -d pantry -v ON_ERROR_STOP=1 -q`.
* **Von deinem PC aus steuern** (optional): per SSH auf dem Server arbeiten (`ssh benutzer@server.example.lan`, dann die Befehle dort) oder mit einem
  Docker-Kontext: `docker context create myserver --docker "host=ssh://benutzer@server.example.lan"`, danach in einem Ordner mit
  `docker-compose.yml` und `.env`: `docker --context myserver compose pull` und `docker --context myserver compose up -d`.

## Konfiguration (Umgebungsvariablen)

`DATABASE_URL`, `PORT` (8080), `IMAGE_DIR` (Bilder-Cache), `BACKUP_DIR` (automatische Sicherungen vor Importen), `API_TOKEN` (leer = offen), `MODE_IDLE_MINUTES` + `DEFAULT_MODE` (nach Leerlauf zurück
in einen Standardmodus, z. B. `consume`), `PENDING_MINUTES` (10, danach verfällt ein gesetztes MHD), `OFF_BASE_URL`, `OFF_USER_AGENT`.

## Datenbank (Drizzle ORM)

Die Tabellen sind in [`src/schema.ts`](src/schema.ts) abgebildet, alle Abfragen laufen über [Drizzle ORM](https://orm.drizzle.team).
PostgreSQL-Funktionen ohne Drizzle-Gegenstück (z. B. `COALESCE`, `FILTER`, das Ablaufdatum einer Packung) stehen gesammelt in
[`src/expressions.ts`](src/expressions.ts).

Schema ändern: `src/schema.ts` anpassen, dann `npm run db:generate`. Das schreibt die passende Migration nach `drizzle/`, die beim
nächsten Start automatisch angewendet wird. Beide zusammen committen; die CI schlägt fehl, wenn eine Schemaänderung ohne Migration
kommt. Datenbanken aus der Zeit vor Drizzle (Tabelle `schema_version`) werden beim ersten Start ohne Änderung übernommen.

## Tests

`npm test` (Steuercodes, Datumslogik, Open-Food-Facts-Mapping), `npm run typecheck`.

## Lizenz

[MIT](LICENSE). Die Produktdaten stammen von den Open-*-Facts-Datenbanken (Open Database License); die Inhalte der Datenbanken haben eigene Lizenzen, siehe deren Webseiten.
