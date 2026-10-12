// Settings tab: master data (storage locations, stores), behaviour, product databases, display, maintenance, system.
// Helpers (h, api, ...) are injected by app.js.

const KINDS = [['fridge', 'Kühlschrank'], ['freezer', 'Tiefkühler'], ['pantry', 'Vorrat'], ['other', 'Sonstiges']];
const kindGuess = (n) => {
  n = n.toLowerCase();
  if (/tief|gefrier|froster|freezer/.test(n)) return 'freezer';
  if (/k(ü|ue|u)hl/.test(n)) return 'fridge';
  if (/vorrat|speisekammer|schrank|regal|pantry/.test(n)) return 'pantry';
  return 'other';
};

export async function renderSettings(root, d) {
  const { h, api, setKids, toast } = d;
  const reload = () => renderSettings(root, d);
  const [cfg, loc, sto, sys, bak] = await Promise.all([api('/api/settings'), api('/api/locations'), api('/api/stores'), api('/api/system'), api('/api/backups').catch(() => ({ files: [] }))]);
  const S = cfg.settings;
  const locations = loc.locations, stores = sto.stores;

  const save = async (patch) => {
    try {
      await api('/api/settings', { method: 'PATCH', body: patch });
      toast('Gespeichert', 'ok');
      d.onSettings?.();
    } catch { /* error toast already shown */ }
    reload();
  };
  const field = (label, control, hint) => h('label', { class: 'set-row' }, h('span', { class: 'set-lbl' }, label), control, hint ? h('span', { class: 'muted set-hint' }, hint) : null);
  const num = (key, min, max) => h('input', { type: 'number', min, max, value: S[key], onchange: (e) => save({ [key]: Number(e.target.value) }) });
  const section = (title, hint, ...kids) => h('div', { class: 'card' }, h('h3', { style: 'margin:0' }, title), hint ? h('div', { class: 'muted', style: 'margin:2px 0 10px' }, hint) : null, ...kids);

  // ---------------------------------------------------------------- storage locations
  const newLoc = { name: '', kind: 'other' };
  const kindSelect = (value, onchange) => h('select', { onchange: (e) => onchange(e.target.value) }, ...KINDS.map(([k, t]) => h('option', { value: k, selected: value === k }, t)));
  const locCard = section('Lagerorte', 'Der Typ steuert die automatische Zuordnung der Produkte (Kühlschrank / Tiefkühler / Vorrat) und das Umlagern beim Anbrechen (Vorrat → Kühlschrank).',
    ...locations.map((l) => h('div', { class: 'set-line' },
      h('input', { class: 'grow', value: l.name, 'aria-label': 'Name', onchange: (e) => api(`/api/locations/${l.id}`, { method: 'PATCH', body: { name: e.target.value } }).then(reload, reload) }),
      kindSelect(l.kind, (k) => api(`/api/locations/${l.id}`, { method: 'PATCH', body: { kind: k } }).then(() => { toast('Typ geändert. Unter „Wartung“ die Standard-Lagerorte neu berechnen.', 'ok'); reload(); })),
      h('code', { class: 'muted', title: 'Barcode zum Umschalten (Steuercodes drucken)' }, `PCLOC${l.id}`),
      h('button', { class: 'btn danger', title: 'Lagerort löschen', onclick: async () => {
        if (confirm(`Lagerort „${l.name}“ löschen? Packungen und Produkte behalten ihren Eintrag ohne Lagerort.`)) { await api(`/api/locations/${l.id}`, { method: 'DELETE' }); reload(); }
      } }, '✕'))),
    h('form', { class: 'set-line', onsubmit: async (e) => {
      e.preventDefault();
      if (!newLoc.name.trim()) return;
      await api('/api/locations', { method: 'POST', body: { name: newLoc.name.trim(), kind: newLoc.kind } }).catch(() => undefined);
      reload();
    } },
      h('input', { class: 'grow', placeholder: 'Neuer Lagerort …', oninput: (e) => { newLoc.name = e.target.value; newLoc.kind = kindGuess(e.target.value); } }),
      h('button', { class: 'btn primary', type: 'submit' }, '+ Lagerort')));

  // ---------------------------------------------------------------- stores
  const newStore = { name: '' };
  const storeCard = section('Läden', 'Die Reihenfolge bestimmt die Sortierung der Einkaufsliste (z. B. nach Laufweg). Den Standard-Laden eines Produkts legst du in den Produktdetails fest.',
    ...stores.map((s, i) => h('div', { class: 'set-line' },
      h('input', { class: 'grow', value: s.name, 'aria-label': 'Name', onchange: (e) => api(`/api/stores/${s.id}`, { method: 'PATCH', body: { name: e.target.value } }).then(reload, reload) }),
      h('button', { class: 'btn', title: 'nach oben', disabled: i === 0, onclick: () => api(`/api/stores/${s.id}`, { method: 'PATCH', body: { move: 'up' } }).then(reload) }, '↑'),
      h('button', { class: 'btn', title: 'nach unten', disabled: i === stores.length - 1, onclick: () => api(`/api/stores/${s.id}`, { method: 'PATCH', body: { move: 'down' } }).then(reload) }, '↓'),
      h('button', { class: 'btn danger', title: 'Laden löschen', onclick: async () => {
        if (confirm(`Laden „${s.name}“ löschen? Produkte behalten ihren Eintrag ohne Laden.`)) { await api(`/api/stores/${s.id}`, { method: 'DELETE' }); reload(); }
      } }, '✕'))),
    !stores.length ? h('div', { class: 'muted' }, 'Noch kein Laden angelegt.') : null,
    h('form', { class: 'set-line', onsubmit: async (e) => { e.preventDefault(); if (newStore.name.trim()) { await api('/api/stores', { method: 'POST', body: { name: newStore.name.trim() } }).catch(() => undefined); reload(); } } },
      h('input', { class: 'grow', placeholder: 'Neuer Laden …', oninput: (e) => { newStore.name = e.target.value; } }),
      h('button', { class: 'btn primary', type: 'submit' }, '+ Laden')));

  // ---------------------------------------------------------------- behaviour
  const behaviour = section('Scannen und Verhalten', 'Gilt für alle Geräte (Scanner, Browser, Kamera).',
    field('Nach Leerlauf zurück zu',
      h('select', { onchange: (e) => save({ default_mode: e.target.value }) }, ...d.modeOrder.map((m) => h('option', { value: m, selected: S.default_mode === m }, d.modeLabels[m]))),
      'Modus, in den die App nach einer Pause zurückfällt.'),
    field('Leerlauf (Minuten)', num('mode_idle_minutes', 0, 1440), '0 = nie zurückfallen.'),
    field('MHD / Menge verfallen nach (Minuten)', num('pending_minutes', 1, 240), 'Gewählte Menge oder eingetippte Ziffern ohne Scan.'),
    field('„Läuft bald ab“ ab (Tage)', num('expiring_days', 0, 60), 'Schwelle für Übersicht, Filter und Farben im Vorrat.'),
    h('label', { class: 'chk set-chk' }, h('input', { type: 'checkbox', checked: S.restock_on_waste, onchange: (e) => save({ restock_on_waste: e.target.checked }) }),
      ' Weggeworfenes auch auf die Einkaufsliste setzen, wenn der Mindestbestand unterschritten wird'));

  // ---------------------------------------------------------------- product databases (order + on/off)
  const order = [...S.lookup_sources, ...cfg.sources.map((x) => x.id).filter((id) => !S.lookup_sources.includes(id))];
  const titleOf = (id) => cfg.sources.find((x) => x.id === id)?.title ?? id;
  const dbs = section('Produktdatenbanken', 'Beim Scannen wird der Reihe nach gefragt, bis eine Datenbank das Produkt kennt.',
    ...order.map((id) => {
      const on = S.lookup_sources.includes(id);
      const idx = S.lookup_sources.indexOf(id);
      const move = (delta) => { const a = [...S.lookup_sources]; [a[idx], a[idx + delta]] = [a[idx + delta], a[idx]]; save({ lookup_sources: a }); };
      return h('div', { class: 'set-line' },
        h('label', { class: 'chk grow' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => save({ lookup_sources: e.target.checked ? [...S.lookup_sources, id] : S.lookup_sources.filter((x) => x !== id) }) }), ` ${titleOf(id)}`),
        on ? h('button', { class: 'btn', title: 'früher fragen', disabled: idx === 0, onclick: () => move(-1) }, '↑') : null,
        on ? h('button', { class: 'btn', title: 'später fragen', disabled: idx === S.lookup_sources.length - 1, onclick: () => move(1) }, '↓') : null);
    }),
    h('label', { class: 'chk set-chk' }, h('input', { type: 'checkbox', checked: S.cache_images, onchange: (e) => save({ cache_images: e.target.checked }) }),
      ` Produktbilder lokal speichern (${sys.images.count} Bilder, ${(sys.images.bytes / 1048576).toFixed(1)} MB), statt sie jedes Mal von den Datenbank-Servern zu laden`));

  // ---------------------------------------------------------------- display + camera (per device)
  const pref = (key) => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } };
  const setPref = (key, v) => { try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* private mode */ } };
  const display = section('Darstellung und Kamera', 'Gilt nur für dieses Gerät.',
    field('Design', h('select', { onchange: (e) => d.setTheme(e.target.value) },
      ...[['navy', 'Navy'], ['space', 'Space'], ['matrix', 'Matrix'], ['classic', 'Klassisch']].map(([k, t]) => h('option', { value: k, selected: d.getTheme() === k }, t)))),
    h('label', { class: 'chk set-chk' }, h('input', { type: 'checkbox', checked: pref('pantry_cam_sound'), onchange: (e) => setPref('pantry_cam_sound', e.target.checked) }), ' Kamera: Signalton nach jedem Scan'),
    h('label', { class: 'chk set-chk' }, h('input', { type: 'checkbox', checked: pref('pantry_cam_vibrate'), onchange: (e) => setPref('pantry_cam_vibrate', e.target.checked) }), ' Kamera: Vibration nach jedem Scan'));

  // ---------------------------------------------------------------- maintenance + backup
  const run = (label, path, fmt) => h('button', { class: 'btn', onclick: async (e) => {
    e.target.disabled = true;
    try { toast(fmt(await api(path, { method: 'POST' })), 'ok'); } catch { /* toast shown */ }
    e.target.disabled = false;
  } }, label);
  const importInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
    const f = importInput.files?.[0];
    importInput.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { return toast('Die Datei ist kein gültiges JSON.', 'error'); }
    try {
      const [rep, mer] = await Promise.all([
        api('/api/import?mode=replace&dry=1', { method: 'POST', body: data }),
        api('/api/import?mode=merge&dry=1', { method: 'POST', body: data }),
      ]);
      openImportDialog(f.name, data, rep, mer);
    } catch { /* the server message was shown as a toast */ }
  } });

  function openImportDialog(fileName, data, rep, mer) {
    const dlg = document.getElementById('dlg');
    let mode = 'merge', sure = false;
    const NAMES = [['locations', 'Lagerorte'], ['stores', 'Läden'], ['products', 'Produkte'], ['stock_items', 'Packungen'], ['shopping_items', 'Einkaufsliste']];
    const go = h('button', { class: 'btn primary', disabled: false, onclick: async () => {
      go.disabled = true;
      try {
        const r = await api(`/api/import?mode=${mode}`, { method: 'POST', body: data });
        dlg.close();
        toast(mode === 'replace' ? `Wiederhergestellt: ${r.result.products} Produkte, ${r.result.stock_items} Packungen` : `Ergänzt: ${r.result.locations_added} Lagerorte, ${r.result.stores_added} Läden, ${r.result.products_added} Produkte`, 'ok');
        setTimeout(() => location.reload(), 1200); // every cache (locations, stores, settings) is reloaded
      } catch { go.disabled = false; }
    } }, 'Importieren');
    const update = () => { go.disabled = mode === 'replace' && !sure; };
    const radio = (value, title, text) => h('label', { class: 'imp-opt' }, h('input', { type: 'radio', name: 'impmode', checked: mode === value, onchange: () => { mode = value; update(); render(); } }),
      h('span', {}, h('strong', {}, title), h('br'), h('span', { class: 'muted' }, text)));
    function render() {
      const warn = rep.warnings;
      d.setKids(dlg,
        h('h3', { style: 'margin:0 0 4px' }, 'Datensicherung importieren'),
        h('div', { class: 'muted' }, `${fileName}${data.exported_at ? ' · erstellt ' + new Date(data.exported_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : ''}`),
        h('table', { class: 'set-table', style: 'margin:10px 0' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'In der Datei'), h('th', {}, 'Aktuell'))),
          h('tbody', {}, ...NAMES.map(([k, l]) => h('tr', {}, h('td', {}, l), h('td', {}, rep.file[k]), h('td', {}, rep.current[k]))))),
        radio('merge', 'Zusammenführen', `Ergänzt fehlende Lagerorte (${mer.result.locations_added}), Läden (${mer.result.stores_added}) und Produkte (${mer.result.products_added}) aus der Datei. Bestand, Einkaufsliste und Einstellungen bleiben unverändert.`),
        radio('replace', 'Alles ersetzen', 'Bestand, Produkte, Lagerorte, Läden, Einkaufsliste und Einstellungen werden durch die Datei ersetzt. Vorher wird automatisch eine Sicherung des aktuellen Stands angelegt.'),
        mode === 'replace' ? h('label', { class: 'chk', style: 'margin:6px 0 0 24px; color:var(--bad)' }, h('input', { type: 'checkbox', checked: sure, onchange: (e) => { sure = e.target.checked; update(); } }), ' Ich weiß, dass der aktuelle Bestand ersetzt wird') : null,
        warn.length ? h('details', { style: 'margin-top:10px' }, h('summary', { class: 'muted' }, `${warn.length} Hinweis${warn.length === 1 ? '' : 'e'} zur Datei`), ...warn.map((w) => h('div', { class: 'muted' }, `• ${w}`))) : null,
        h('div', { class: 'row', style: 'margin-top:14px' }, go, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Abbrechen')));
      update();
    }
    render();
    dlg.showModal();
  }

  const maintenance = section('Wartung und Datensicherung', null,
    h('div', { class: 'set-line' }, run('Standard-Lagerorte neu berechnen', '/api/maintenance/reclassify', (r) => `${r.checked} Produkte geprüft, ${r.changed} geändert`),
      h('span', { class: 'muted set-hint' }, 'Nach Änderung der Lagerort-Typen. Von dir festgelegte Orte bleiben unberührt, Bestand wird nicht verschoben.')),
    h('div', { class: 'set-line' }, run('Unbekannte Produkte erneut abfragen', '/api/maintenance/retry-unknown', (r) => `${r.tried} abgefragt, ${r.found} gefunden`),
      h('span', { class: 'muted set-hint' }, 'Sinnvoll, nachdem eine weitere Produktdatenbank aktiviert wurde.')),
    h('div', { class: 'set-line' }, run('Bilder jetzt lokal speichern', '/api/maintenance/cache-images', (r) => r.tried ? `${r.cached} von ${r.tried} Bildern gespeichert` : 'Alle Bilder sind schon lokal'),
      h('span', { class: 'muted set-hint' }, 'Neue Produkte werden automatisch beim ersten Scan gespeichert.')),
    h('div', { class: 'set-line' }, h('button', { class: 'btn', onclick: async (e) => {
      if (!confirm('Alle lokal gespeicherten Produktbilder löschen? Die Seite lädt sie dann wieder von den Datenbank-Servern.')) return;
      e.target.disabled = true;
      try { const r = await api('/api/maintenance/clear-image-cache', { method: 'POST' }); toast(`${r.removed} Bilder gelöscht`, 'ok'); reload(); } catch { e.target.disabled = false; }
    } }, 'Bilder-Cache leeren')),
    h('div', { class: 'set-line' }, h('button', { class: 'btn primary', onclick: () => d.download('/api/export') }, 'Datensicherung herunterladen (JSON)'),
      h('span', { class: 'muted set-hint' }, 'Produkte, Vorrat, Lagerorte, Läden, Einkaufsliste und Einstellungen.')),
    h('div', { class: 'set-line' },
      importInput,
      h('button', { class: 'btn', onclick: () => importInput.click() }, 'Datensicherung wiederherstellen …'),
      h('span', { class: 'muted set-hint' }, 'Zeigt zuerst eine Vorschau. Es ändert sich nichts, bevor du bestätigst.')),
    bak.files.length ? h('div', { class: 'muted', style: 'margin-top:8px' }, 'Automatische Sicherungen vor Importen (die letzten 5):',
      ...bak.files.map((f) => h('div', { class: 'set-line', style: 'margin:2px 0' },
        h('span', {}, `${new Date(f.modified).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · ${(f.size / 1024).toFixed(0)} KB`),
        h('button', { class: 'btn', onclick: () => d.download(`/api/backups/${f.name}`) }, 'Herunterladen')))) : null);

  // ---------------------------------------------------------------- system info
  const row = (k, v) => h('tr', {}, h('td', { class: 'muted' }, k), h('td', {}, v));
  const httpsUrl = sys.https_port ? `https://${location.hostname}:${sys.https_port}/` : null;
  const system = section('System', null, h('table', { class: 'set-table' }, h('tbody', {},
    row('Version', `Beepstock ${sys.version} · Node ${sys.node}`),
    row('Läuft seit', `${Math.floor(sys.uptime_s / 3600)} h ${Math.floor((sys.uptime_s % 3600) / 60)} min`),
    row('Daten', `${sys.counts.products} Produkte · ${sys.counts.stock_in} Packungen im Vorrat (${sys.counts.stock_total} gesamt) · ${sys.counts.shopping_open} auf der Einkaufsliste`),
    row('Bilder-Cache', `${sys.images.count} Dateien, ${(sys.images.bytes / 1048576).toFixed(1)} MB`),
    row('Adresse', location.origin),
    row('HTTPS (Kamera)', httpsUrl ? h('a', { href: httpsUrl }, httpsUrl) : 'aus (HTTPS_PORT in der docker-compose.yml setzen)'),
    sys.tls_hosts.length ? row('Zertifikat gilt für', sys.tls_hosts.join(', ')) : null,
    row('API-Token', sys.token_set ? 'gesetzt (Umgebungsvariable API_TOKEN)' : 'nicht gesetzt: im Heimnetz ohne Anmeldung nutzbar'))),
    h('div', { class: 'muted', style: 'margin-top:8px' }, 'Port, Datenbank, Token und HTTPS werden beim Start über Umgebungsvariablen (docker-compose.yml / .env) gesetzt.'));

  setKids(root,
    h('div', { class: 'set-grid' }, h('div', {}, locCard, storeCard), h('div', {}, behaviour, dbs, display)),
    maintenance, system);
}
