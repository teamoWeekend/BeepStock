// Beepstock web UI. Plain ES modules, no build step. All dynamic text goes through textContent (OFF data is untrusted).
import { initCamera } from '/camera.js';
import { renderInventory } from '/inventory.js';
import { renderSettings } from '/settings.js';
import { buildOverview, buildLabelSheets, DEFAULT_LABEL_CFG, MIN_MODULE_MM } from '/sheets.js';

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// replaceChildren() would render null/false as the text "null"; skip empty slots instead
function setKids(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

// ------------------------------------------------------------ api

let token = localStorage.getItem('pantry_token') || '';

async function api(path, opts = {}) {
  const headers = {};
  if (opts.body) headers['Content-Type'] = 'application/json'; // no JSON header without a body
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) {
    token = prompt('API-Token:') || '';
    localStorage.setItem('pantry_token', token);
    if (token) return api(path, opts);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error || `Fehler ${res.status}`, 'error');
    throw new Error(data.error || res.status);
  }
  return data;
}

// ------------------------------------------------------------ helpers

const MODE_LABEL = { add: 'Einlagern', consume: 'Verbrauchen', open: 'Anbrechen', waste: 'Wegwerfen', shop: 'Auf Einkaufsliste', info: 'Nur Info', count: 'Inventur' };
const SOURCE_NAME = { off: 'Open Food Facts', obf: 'Open Beauty Facts', opf: 'Open Products Facts', opff: 'Open Pet Food Facts' };
const MODE_SHORT = { shop: 'Einkaufsliste', info: 'Info' };
const MODE_HINT = { consume: 'aufgebraucht, leer entsorgt', waste: 'verdorben, nicht leer', add: 'ins Lager', open: 'Packung geöffnet', shop: 'nachkaufen', info: 'nur nachsehen', count: 'zählen, bucht nichts' };
let appSettings = { expiring_days: 3 }; // server-side settings (Einstellungen tab)
const loadSettings = () => api('/api/settings').then((r) => { appSettings = r.settings; }).catch(() => undefined);
const MODE_ORDER = ['consume', 'add', 'open', 'waste', 'shop', 'info', 'count'];

let toastTimer;
function toast(msg, level = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = level === 'ok' ? '' : level;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), level === 'ok' ? 2500 : 5000);
}

const dayDiff = (iso) => {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date();
  return Math.round((new Date(y, m - 1, d) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
};
const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('.') : 'kein MHD');
function expSpan(iso) {
  const d = dayDiff(iso);
  if (d == null) return h('span', { class: 'muted' }, 'kein MHD');
  const cls = d < 0 ? 'exp-bad' : d <= appSettings.expiring_days ? 'exp-warn' : '';
  const txt = d < 0 ? `seit ${-d} T. abgelaufen` : d === 0 ? 'heute' : d === 1 ? 'morgen' : `in ${d} T.`;
  return h('span', { class: cls }, `${fmtDate(iso)} (${txt})`);
}
const thumb = (url) => (url ? h('img', { class: 'thumb', src: url, loading: 'lazy', alt: '' }) : h('span', { class: 'thumb ph' }));
const nutriBadge = (g) => (g ? h('span', { class: `ns ns-${g}`, title: 'Nutri-Score' }, g) : null);

// ------------------------------------------------------------ tabs

const tabs = { scan: renderScan, stock: renderStock, inventory: () => renderInventory($('#tab-inventory'), invDeps), shopping: renderShopping, history: renderHistory, products: renderProducts, codes: renderCodes, settings: () => renderSettings($('#tab-settings'), setDeps) };
let currentTab = 'scan';

function showTab(name) {
  currentTab = name;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== `tab-${name}`;
  tabs[name]();
}
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]'); // the button now contains an icon and a label
  if (btn) showTab(btn.dataset.tab);
});

// ------------------------------------------------------------ scan tab

let state = null;
let locations = [];
const camera = initCamera({
  send: (code) => sendScan(code),
  getState: () => state,
  getLocations: () => locations,
  setMode: (mode) => api('/api/state/mode', { method: 'POST', body: { mode } }).then((r) => { state = r.state; drawState(); }),
  setLocation: (id) => api('/api/state/location', { method: 'POST', body: { location_id: id } }).then((r) => { state = r.state; drawState(); }),
  getInfo: () => api('/api/info'),
  modeLabels: MODE_LABEL,
  modeOrder: MODE_ORDER,
});
const scanLog = [];
const loadLocations = () => api('/api/locations').then((r) => { locations = r.locations; });

function renderScan() {
  const root = $('#tab-scan');
  setKids(root,
    h('div', { class: 'stats compact', id: 'stats' }),
    h('div', { class: 'card scan-card' },
      h('div', { class: 'modes', id: 'modes' }),
      h('div', { class: 'pending', id: 'pending' }),
      h('form', { class: 'row scan-form', id: 'scanForm' },
        h('input', { id: 'scanInput', class: 'grow', placeholder: 'Barcode oder Steuercode eingeben / scannen …', autocomplete: 'off', inputmode: 'text' }),
        h('button', { class: 'btn primary', type: 'submit' }, 'Senden'),
        h('button', { class: 'btn cam-open-btn', type: 'button', title: 'Mit der Kamera scannen', onclick: () => camera.open() }, '📷 Kamera'),
        h('button', { class: 'btn', type: 'button', onclick: () => api('/api/undo', { method: 'POST' }).then((r) => toast(r.message, r.ok ? 'ok' : 'warn')) }, 'Rückgängig'),
      ),
    ),
    h('div', { class: 'card log', id: 'log', hidden: true }),
  );
  $('#scanForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#scanInput');
    if (inp.value.trim()) sendScan(inp.value.trim());
    inp.value = '';
  });
  drawState();
  drawLog();
  Promise.all([api('/api/state'), loadLocations()]).then(([r]) => { state = r.state; drawState(); });
  api('/api/stats').then((s) => {
    $('#stats')?.replaceChildren(
      ...[['Im Vorrat', s.in_stock], ['Läuft bald ab', s.expiring_soon], ['Aufgebraucht (30 T.)', s.consumed_30d], ['Weggeworfen (30 T.)', s.wasted_30d]].map(
        ([l, v]) => h('div', { class: 'stat' }, h('b', {}, v), h('span', { class: 'muted' }, l)),
      ),
    );
  });
}

function drawState() {
  camera.refresh();
  if (!state || !$('#modes')) return;
  setKids($('#modes'), 
    ...MODE_ORDER.map((m) =>
      h('button', { class: state.mode === m ? 'active' : '', onclick: () => api('/api/state/mode', { method: 'POST', body: { mode: m } }).then((r) => { state = r.state; drawState(); }) }, MODE_SHORT[m] || MODE_LABEL[m]),
    ),
  );
  setKids($('#pending'), 
    h('span', { class: 'muted', title: 'Gilt für Produkte ohne eigenen Standard-Lagerort (der wird automatisch abgeleitet, siehe Produktdetails)' }, 'Lagerort:'),
    ...locations.map((l) => h('button', { class: 'chip' + (state.location_id === l.id ? ' on' : ''), style: 'cursor:pointer', onclick: () => api('/api/state/location', { method: 'POST', body: { location_id: l.id } }).then((r) => { state = r.state; drawState(); }) }, l.name)),
    h('span', { class: 'chip' + (state.pending_qty ? ' on' : '') }, `Menge: ${state.pending_qty ?? 1}`),
    state.digits ? h('span', { class: 'chip on' }, `Eingabe: ${state.digits}`) : null,
    h('span', { class: 'mode-hint muted' }, `${MODE_LABEL[state.mode]}: ${MODE_HINT[state.mode]}`),
  );
}

function drawLog() {
  const log = $('#log');
  if (!log) return;
  log.hidden = !scanLog.length; // no empty placeholder card
  if (!scanLog.length) return;
  setKids(log, 
    ...scanLog.map((r) =>
      h('div', { class: `entry ${r.level}` }, thumb(r.product?.image_url), h('div', { class: 'grow' }, h('div', {}, r.message), h('div', { class: 'muted' }, r.code)),
        r.needs_name ? h('button', { class: 'btn', onclick: () => openProduct(r.product.barcode) }, 'Benennen') : r.product ? h('button', { class: 'btn', onclick: () => openProduct(r.product.barcode) }, 'Details') : null,
      ),
    ),
  );
}

function onScanResult(r) {
  scanLog.unshift(r);
  scanLog.length = Math.min(scanLog.length, 30);
  state = r.state;
  camera.onResult(r);
  if (!camera.isOpen()) {
    toast(r.message, r.level);
    if (r.needs_name) openProduct(r.product.barcode);
  }
  if (currentTab === 'scan') { drawState(); drawLog(); }
  else if (['stock', 'shopping', 'inventory'].includes(currentTab)) tabs[currentTab]();
}

// Global scanner capture: HID scanners type fast and end with Enter. Ignore normal typing in fields.
let buf = '';
let lastKey = 0;
document.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const typing = el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && el.id !== 'scanInput';
  if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  const now = performance.now();
  if (now - lastKey > 120) buf = '';
  lastKey = now;
  if (e.key === 'Enter') {
    if (buf.length >= 2) {
      e.preventDefault();
      sendScan(buf);
      if (el?.id === 'scanInput') el.value = '';
    }
    buf = '';
  } else if (e.key.length === 1) {
    buf += e.key;
  }
}, true);

async function sendScan(code) {
  if (ws && ws.readyState === WebSocket.OPEN) return ws.send(code);
  try { onScanResult(await api('/api/scan', { method: 'POST', body: { code, source: 'web' } })); } catch { /* toast shown */ }
}

// ------------------------------------------------------------ websocket

let ws;
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  ws.onopen = () => { $('#conn').className = 'conn on'; };
  ws.onclose = () => { $('#conn').className = 'conn off'; setTimeout(connectWs, 2000); };
  ws.onmessage = (ev) => {
    const { type, data } = JSON.parse(ev.data);
    if (type === 'scan') onScanResult(data);
    else if (type === 'state') { state = data; drawState(); }
    else if (type === 'change' && ['stock', 'shopping', 'history', 'products', 'inventory'].includes(currentTab) && !document.querySelector('dialog[open]')) tabs[currentTab]();
    else if (type === 'error') toast(data.error, 'error');
  };
}

// ------------------------------------------------------------ stock tab

let stockFilter = 'all';
let locFilter = '';
const openGroups = new Set();

async function renderStock() {
  const root = $('#tab-stock');
  const [{ items: all }] = await Promise.all([api('/api/stock'), loadLocations()]);
  const items = locFilter ? all.filter((i) => String(i.location_id ?? 0) === locFilter) : all;
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.barcode)) groups.set(it.barcode, []);
    groups.get(it.barcode).push(it);
  }
  const keep = (list) => {
    if (stockFilter === 'opened') return list.some((i) => i.opened_at);
    if (stockFilter === 'soon') return list.some((i) => i.expires && dayDiff(i.expires) <= appSettings.expiring_days);
    if (stockFilter === 'expired') return list.some((i) => i.expires && dayDiff(i.expires) < 0);
    return true;
  };
  const filters = [['all', 'Alles'], ['opened', 'Im Anbruch'], ['soon', 'Läuft bald ab'], ['expired', 'Abgelaufen']];
  setKids(root, 
    h('div', { class: 'tabs2' }, ...filters.map(([k, l]) => h('button', { class: 'btn' + (stockFilter === k ? ' active' : ''), onclick: () => { stockFilter = k; renderStock(); } }, l)),
      h('span', { class: 'grow' }),
      h('select', { onchange: (e) => { locFilter = e.target.value; renderStock(); } },
        h('option', { value: '' }, 'Alle Lagerorte'),
        ...locations.map((l) => h('option', { value: String(l.id), selected: locFilter === String(l.id) }, l.name)),
        h('option', { value: '0', selected: locFilter === '0' }, 'Ohne Lagerort')),
      h('button', { class: 'btn', onclick: addManualStock }, '+ Manuell')),
    h('div', { class: 'card' },
      ...[...groups.entries()].filter(([, l]) => keep(l)).map(([barcode, list]) => {
        const first = list[0];
        const nearest = list.map((i) => i.expires).filter(Boolean).sort()[0] ?? null;
        const opened = list.filter((i) => i.opened_at).length;
        const open = openGroups.has(barcode);
        return h('div', { class: 'group' },
          h('div', { class: 'head', onclick: () => { open ? openGroups.delete(barcode) : openGroups.add(barcode); renderStock(); } },
            thumb(first.image_url),
            h('div', { class: 'grow' }, h('strong', {}, first.name), first.brand ? h('span', { class: 'muted' }, ` · ${first.brand}`) : null,
              h('div', { class: 'muted' }, 'nächstes MHD: ', expSpan(nearest))),
            ...[...new Set(list.map((i) => i.location_name).filter(Boolean))].map((n) => h('span', { class: 'badge' }, n)),
            opened ? h('span', { class: 'badge open' }, `${opened} angebrochen`) : null,
            h('span', { class: 'badge' }, `${list.length}×`),
            nutriBadge(first.nutriscore)),
          open ? h('div', { class: 'items' }, ...list.map(stockRow), h('div', {}, h('button', { class: 'btn', onclick: () => openProduct(barcode) }, 'Produktdetails'))) : null);
      }),
      !items.length ? h('div', { class: 'muted' }, 'Der Vorrat ist leer.') : null),
  );
}

function stockRow(it) {
  const act = (a, body) => api(`/api/stock/${it.id}/${a}`, { method: 'POST', body }).then((r) => { if (r.moved_to) toast(`Umgelagert nach ${r.moved_to}`, 'ok'); renderStock(); });
  return h('div', { class: 'it' },
    expSpan(it.expires),
    h('select', { title: 'Lagerort', onchange: (e) => api(`/api/stock/${it.id}`, { method: 'PATCH', body: { location_id: e.target.value ? Number(e.target.value) : null } }).then(renderStock) },
      h('option', { value: '' }, '– kein Lagerort –'),
      ...locations.map((l) => h('option', { value: String(l.id), selected: it.location_id === l.id }, l.name))),
    it.opened_at ? h('span', { class: 'badge open' }, `angebrochen ${new Date(it.opened_at).toLocaleDateString('de-DE')}`) : null,
    h('span', { class: 'grow' }),
    h('button', { class: 'btn', title: 'Leer, entnommen und entsorgt', onclick: () => act('consume') }, 'Aufgebraucht'),
    !it.opened_at ? h('button', { class: 'btn', onclick: () => act('open') }, 'Anbrechen') : null,
    h('button', { class: 'btn danger', title: 'Nicht aufgebraucht, verdorben und weggeworfen', onclick: () => act('waste') }, 'Weggeworfen'),
    h('button', { class: 'btn', onclick: () => editDate(it) }, 'MHD'),
    h('button', { class: 'btn danger', title: 'Eintrag löschen (ohne Verlauf)', onclick: () => confirm('Eintrag wirklich löschen?') && act('delete') }, '✕'));
}

async function editDate(it) {
  const v = prompt('MHD (JJJJ-MM-TT), leer = kein MHD', it.best_before || '');
  if (v == null) return;
  await api(`/api/stock/${it.id}`, { method: 'PATCH', body: { best_before: v.trim() || null } });
  renderStock();
}

async function addManualStock() {
  const barcode = prompt('Barcode:');
  if (!barcode) return;
  const bb = prompt('MHD (JJJJ-MM-TT, optional):') || null;
  await api('/api/stock', { method: 'POST', body: { barcode: barcode.trim(), best_before: bb } });
  renderStock();
}

// ------------------------------------------------------------ shopping tab (grouped by store)

let stores = [];
const loadStores = () => api('/api/stores').then((r) => { stores = r.stores; });

function storeSelect(value, onchange, emptyLabel) {
  return h('select', { onchange: (e) => onchange(e.target.value ? Number(e.target.value) : null) },
    h('option', { value: '' }, emptyLabel),
    ...stores.map((s) => h('option', { value: String(s.id), selected: value === s.id }, s.name)));
}

async function renderShopping() {
  const root = $('#tab-shopping');
  const [{ items }] = await Promise.all([api('/api/shopping'), loadStores()]);
  const form = h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault();
    const name = $('#shopName').value.trim();
    if (!name) return;
    const store = $('#shopStore').value;
    await api('/api/shopping', { method: 'POST', body: { name, qty: Number($('#shopQty').value) || 1, ...(store ? { store_id: Number(store) } : {}) } });
    renderShopping();
  } },
    h('input', { id: 'shopName', class: 'grow', placeholder: 'Artikel hinzufügen …' }),
    h('input', { id: 'shopQty', type: 'number', min: 1, max: 99, value: 1, style: 'width:70px' }),
    h('select', { id: 'shopStore' }, h('option', { value: '' }, 'Laden: egal'), ...stores.map((s) => h('option', { value: String(s.id) }, s.name))),
    h('button', { class: 'btn primary', type: 'submit' }, 'Hinzufügen'));

  const row = (it) => h('div', { class: 'group row' },
    h('input', { type: 'checkbox', checked: it.done, onchange: (e) => api(`/api/shopping/${it.id}`, { method: 'PATCH', body: { done: e.target.checked } }).then(renderShopping) }),
    thumb(it.image_url),
    h('span', { class: 'grow', style: it.done ? 'text-decoration:line-through;opacity:.6' : '' }, it.name, h('span', { class: 'muted' }, it.source === 'auto' ? '  · automatisch (Mindestbestand)' : '')),
    h('span', { class: 'badge' }, `${it.qty}×`),
    storeSelect(it.eff_store_id, (id) => api(`/api/shopping/${it.id}`, { method: 'PATCH', body: { store_id: id } }).then(renderShopping), '– Laden –'),
    h('button', { class: 'btn danger', onclick: () => api(`/api/shopping/${it.id}`, { method: 'DELETE' }).then(renderShopping) }, '✕'));

  // open items grouped by store (server already sorts by store order, "no store" last); done items at the end
  const open = items.filter((i) => !i.done), done = items.filter((i) => i.done);
  const groups = [];
  for (const it of open) {
    const key = it.store_name || '';
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, items: [] }; groups.push(g); }
    g.items.push(it);
  }
  const storeMgr = h('div', { class: 'card row' }, h('span', { class: 'muted grow' }, 'Läden anlegen, sortieren und löschen: in den Einstellungen.'), h('button', { class: 'btn', onclick: () => showTab('settings') }, 'Zu den Einstellungen'));

  setKids(root, 
    h('div', { class: 'card' }, form),
    ...(groups.length ? groups.map((g) => h('div', { class: 'card' },
      h('h3', { style: 'margin:0 0 6px' }, g.key || 'Ohne Laden', h('span', { class: 'badge' }, `${g.items.length}`)),
      ...g.items.map(row))) : [h('div', { class: 'card muted' }, 'Die Einkaufsliste ist leer.')]),
    done.length ? h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 6px' }, 'Erledigt'), ...done.map(row),
      h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn', onclick: () => api('/api/shopping/clear-done', { method: 'POST' }).then(renderShopping) }, 'Erledigte entfernen'))) : null,
    storeMgr,
  );
}

// ------------------------------------------------------------ history tab

// consumed = used up (empty, thrown away); wasted = not used up, spoiled and thrown away
let histFilter = 'wasted';
let wasteDays = 90;
async function renderHistory() {
  const root = $('#tab-history');
  const tabsRow = h('div', { class: 'tabs2' }, ...[['wasted', 'Weggeworfen (verdorben)'], ['consumed', 'Aufgebraucht'], ['stats', 'Auswertung']].map(([k, l]) =>
    h('button', { class: 'btn' + (histFilter === k ? ' active' : ''), onclick: () => { histFilter = k; renderHistory(); } }, l)));
  if (histFilter === 'stats') return renderWaste(root, tabsRow);
  const { items } = await api(`/api/history?status=${histFilter}`);
  setKids(root, 
    tabsRow,
    h('div', { class: 'card' },
      h('table', {}, h('thead', {}, h('tr', {}, ...['Produkt', 'MHD', 'Eingelagert', 'Beendet'].map((c) => h('th', {}, c)))),
        h('tbody', {}, ...items.map((i) => h('tr', {}, h('td', {}, i.name, i.brand ? ` (${i.brand})` : ''), h('td', {}, fmtDate(i.best_before)), h('td', {}, new Date(i.added_at).toLocaleDateString('de-DE')), h('td', {}, new Date(i.finished_at).toLocaleString('de-DE')))))),
      !items.length ? h('div', { class: 'muted' }, 'Keine Einträge.') : null),
  );
}

const pct = (x) => `${Math.round(x * 100)} %`;

async function renderWaste(root, tabsRow) {
  const d = await api(`/api/stats/waste?days=${wasteDays}`);
  const maxMonth = Math.max(1, ...d.months.map((m) => m.consumed + m.wasted));
  const bar = (c, w, max) => h('div', { class: 'bar', title: `${c} aufgebraucht, ${w} weggeworfen` },
    h('i', { class: 'b-ok', style: `width:${(c / max) * 100}%` }), h('i', { class: 'b-bad', style: `width:${(w / max) * 100}%` }));
  setKids(root, 
    tabsRow,
    h('div', { class: 'row', style: 'margin-bottom:10px' }, h('span', { class: 'muted' }, 'Zeitraum:'),
      ...[[30, '30 Tage'], [90, '90 Tage'], [365, '1 Jahr'], [3650, 'Alles']].map(([n, l]) =>
        h('button', { class: 'btn' + (wasteDays === n ? ' active' : ''), onclick: () => { wasteDays = n; renderHistory(); } }, l))),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, d.consumed), h('span', { class: 'muted' }, 'Aufgebraucht (leer entsorgt)')),
      h('div', { class: 'stat' }, h('b', {}, d.wasted), h('span', { class: 'muted' }, 'Weggeworfen (verdorben, nicht leer)')),
      h('div', { class: 'stat' }, h('b', { class: d.waste_rate > 0.2 ? 'exp-bad' : '' }, pct(d.waste_rate)), h('span', { class: 'muted' }, 'Anteil weggeworfen'))),
    d.months.length ? h('div', { class: 'card' }, h('strong', {}, 'Pro Monat'), h('div', { class: 'muted' }, 'grün = aufgebraucht, rot = weggeworfen'),
      ...d.months.map((m) => h('div', { class: 'row', style: 'margin-top:6px' }, h('span', { style: 'width:70px' }, m.month), h('div', { class: 'grow' }, bar(m.consumed, m.wasted, maxMonth)), h('span', { class: 'muted', style: 'width:90px;text-align:right' }, `${m.consumed} / ${m.wasted}`)))) : null,
    h('div', { class: 'card' }, h('strong', {}, 'Pro Produkt'), h('div', { class: 'muted' }, 'Sortiert nach den meisten weggeworfenen Packungen.'),
      h('table', {}, h('thead', {}, h('tr', {}, ...['Produkt', 'Aufgebr.', 'Weggew.', 'Quote', 'davon abgelaufen', 'davon angebrochen'].map((c) => h('th', {}, c)))),
        h('tbody', {}, ...d.products.map((p) => h('tr', {},
          h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openProduct(p.barcode); } }, p.name), p.brand ? ` (${p.brand})` : ''),
          h('td', {}, p.consumed), h('td', { class: p.wasted ? 'exp-bad' : '' }, p.wasted),
          h('td', {}, pct(p.wasted / Math.max(1, p.consumed + p.wasted))), h('td', {}, p.wasted_expired), h('td', {}, p.wasted_opened))))),
      !d.products.length ? h('div', { class: 'muted' }, 'Noch keine Daten im Zeitraum.') : null),
    d.locations.length ? h('div', { class: 'card' }, h('strong', {}, 'Pro Lagerort'),
      h('table', {}, h('thead', {}, h('tr', {}, ...['Lagerort', 'Aufgebr.', 'Weggew.', 'Quote'].map((c) => h('th', {}, c)))),
        h('tbody', {}, ...d.locations.map((l) => h('tr', {}, h('td', {}, l.name), h('td', {}, l.consumed), h('td', {}, l.wasted), h('td', {}, pct(l.wasted / Math.max(1, l.consumed + l.wasted)))))))) : null,
  );
}

// ------------------------------------------------------------ products tab + detail

async function renderProducts() {
  const root = $('#tab-products');
  const search = h('input', { class: 'grow', placeholder: 'Suchen (Name, Marke, Barcode) …', value: root.dataset.q || '' });
  const list = h('div', { class: 'card' });
  const load = async () => {
    root.dataset.q = search.value;
    const { products } = await api(`/api/products?q=${encodeURIComponent(search.value)}`);
    setKids(list, ...products.map((p) => h('div', { class: 'group head', onclick: () => openProduct(p.barcode) }, thumb(p.image_url),
      h('div', { class: 'grow' }, h('strong', {}, p.name), p.brand ? h('span', { class: 'muted' }, ` · ${p.brand}`) : null, h('div', { class: 'muted' }, p.barcode)),
      p.in_stock ? h('span', { class: 'badge' }, `${p.in_stock}× im Vorrat`) : null, nutriBadge(p.nutriscore))),
      !products.length ? h('div', { class: 'muted' }, 'Keine Produkte.') : null);
  };
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  setKids(root, h('div', { class: 'card row' }, search), list);
  load();
}

const NUTRI_LABELS = [['energy-kcal', 'Energie', 'kcal'], ['fat', 'Fett', 'g'], ['saturated-fat', 'davon gesättigte Fettsäuren', 'g'], ['carbohydrates', 'Kohlenhydrate', 'g'], ['sugars', 'davon Zucker', 'g'], ['fiber', 'Ballaststoffe', 'g'], ['proteins', 'Eiweiß', 'g'], ['salt', 'Salz', 'g']];

// only values the user actually changed are sent: setting them by hand turns the automatic derivation off for this product
function changedDefaults(p) {
  const out = {};
  const loc = $('#f_loc').value ? Number($('#f_loc').value) : null;
  if (loc !== (p.location_id ?? null)) out.location_id = loc;
  if ($('#f_move').checked !== !!p.move_on_open) out.move_on_open = $('#f_move').checked;
  return out;
}

async function openProduct(barcode) {
  const dlg = $('#dlg');
  const p = await api(`/api/products/${encodeURIComponent(barcode)}`);
  await Promise.all([loadStores(), loadLocations()]);
  const field = (id, label, val, type = 'text') => h('label', { class: 'row' }, h('span', { style: 'min-width:190px' }, label), h('input', { id, type, class: 'grow', value: val ?? '' }));
  const n = p.nutriments || {};
  setKids(dlg, 
    h('div', { class: 'row' }, thumb(p.image_url), h('div', { class: 'grow' }, h('h2', { style: 'margin:0' }, p.name), h('div', { class: 'muted' }, `${p.barcode}${p.quantity_text ? ' · ' + p.quantity_text : ''}${p.off_found ? (p.source ? ' · Quelle: ' + (SOURCE_NAME[p.source] || p.source) : '') : ' · in keiner Produktdatenbank gefunden'}`)), nutriBadge(p.nutriscore)),
    h('div', { style: 'margin:12px 0;display:grid;gap:8px' },
      field('f_name', 'Name', p.name), field('f_brand', 'Marke', p.brand),
      field('f_shelf', 'Standard-Haltbarkeit (Tage)', p.shelf_life_days, 'number'),
      field('f_open', 'Haltbar nach Anbruch (Tage)', p.days_after_opening, 'number'),
      field('f_min', 'Mindestbestand (0 = aus)', p.min_stock, 'number'),
      h('label', { class: 'row' }, h('span', { style: 'min-width:190px' }, 'Standard-Lagerort'),
        h('select', { id: 'f_loc', class: 'grow' }, h('option', { value: '' }, '– keiner (gescannter Ort gilt) –'),
          ...locations.map((l) => h('option', { value: String(l.id), selected: p.location_id === l.id }, l.name))),
        h('span', { class: 'muted' }, p.location_id ? (p.auto_defaults ? 'automatisch abgeleitet' : 'von dir festgelegt') : 'nicht ableitbar')),
      h('label', { class: 'chk' }, h('input', { id: 'f_move', type: 'checkbox', checked: p.move_on_open }),
        ' Nach dem Anbrechen aus dem Vorrat in den Kühlschrank umlagern'),
      p.auto_defaults === false ? h('div', {}, h('button', { class: 'btn', type: 'button', onclick: async () => {
        await api(`/api/products/${encodeURIComponent(barcode)}`, { method: 'PATCH', body: { reset_auto: true } });
        toast('Standard-Lagerort wieder automatisch', 'ok');
        openProduct(barcode);
      } }, 'Zurück auf automatisch')) : null,
      h('label', { class: 'row' }, h('span', { style: 'min-width:190px' }, 'Standard-Laden'),
        h('select', { id: 'f_store', class: 'grow' }, h('option', { value: '' }, '– keiner –'),
          ...stores.map((st) => h('option', { value: String(st.id), selected: p.store_id === st.id }, st.name))))),
    Object.keys(n).length ? h('div', {}, h('strong', {}, 'Nährwerte je 100 g/ml'), h('div', { class: 'nutri' }, ...NUTRI_LABELS.filter(([k]) => n[k] != null).flatMap(([k, l, u]) => [h('span', {}, l), h('span', {}, `${Math.round(n[k] * 10) / 10} ${u}`)]))) : null,
    p.allergens ? h('p', { class: 'muted' }, `Allergene: ${p.allergens}`) : null,
    p.ingredients ? h('details', {}, h('summary', {}, 'Zutaten'), h('p', {}, p.ingredients)) : null,
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'btn primary', onclick: async () => {
        const num = (id) => ($(id).value === '' ? null : Number($(id).value));
        try {
          await api(`/api/products/${encodeURIComponent(barcode)}`, { method: 'PATCH', body: { name: $('#f_name').value, brand: $('#f_brand').value || null, shelf_life_days: num('#f_shelf'), days_after_opening: num('#f_open'), min_stock: Number($('#f_min').value || 0), store_id: $('#f_store').value ? Number($('#f_store').value) : null, ...changedDefaults(p) } });
          dlg.close();
          tabs[currentTab]();
        } catch { /* toast shown */ }
      } }, 'Speichern'),
      h('button', { class: 'btn', onclick: async () => { const r = await api(`/api/products/${encodeURIComponent(barcode)}/refresh`, { method: 'POST' }); toast(r.offError || (r.product.off_found ? 'Aktualisiert (' + (SOURCE_NAME[r.product.source] || 'Datenbank') + ')' : 'In keiner Produktdatenbank gefunden'), r.offError || !r.product.off_found ? 'warn' : 'ok'); openProduct(barcode); } }, 'Online-Datenbanken abfragen'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: () => dlg.close() }, 'Schließen')));
  dlg.showModal();
}

// ------------------------------------------------------------ control codes tab

let codesView = new URLSearchParams(location.search).get('view') === 'labels' ? 'labels' : 'overview';
const LABEL_KEY = 'pantry_label_cfg';
const LABEL_DEFAULTS = { ...DEFAULT_LABEL_CFG, groups: ['mode', 'location', 'date', 'digits', 'misc'], copies: 1, counts: {} };

function loadLabelCfg() {
  try { return { ...LABEL_DEFAULTS, ...JSON.parse(localStorage.getItem(LABEL_KEY) || '{}') }; } catch { return { ...LABEL_DEFAULTS }; }
}
function saveLabelCfg(c) {
  try { localStorage.setItem(LABEL_KEY, JSON.stringify(c)); } catch { /* private mode etc. */ }
}

async function renderCodes() {
  const root = $('#tab-codes');
  await loadLocations();
  const groups = await api('/api/control-codes');
  let cfg = loadLabelCfg();
  const preview = h('div', { class: 'preview' });
  const info = h('div', { class: 'muted', style: 'margin:6px 0' });

  // how many labels of a code: explicit per-code count, else the group copies when the group is ticked
  const countFor = (g, it) => {
    const own = cfg.counts && cfg.counts[it.code];
    if (own != null) return Math.max(0, Math.floor(Number(own) || 0));
    return cfg.groups.includes(g.key) ? Math.max(1, Math.floor(Number(cfg.copies) || 1)) : 0;
  };
  const preset = (groupsOn, counts) => { cfg.groups = groupsOn; cfg.counts = counts; saveLabelCfg(cfg); renderCodes(); };

  const draw = () => {
    if (codesView === 'overview') {
      preview.replaceChildren(buildOverview(groups));
      info.textContent = '1 Seite DIN A4, in 100 % („Tatsächliche Größe“) drucken, Ränder: keine.';
      return;
    }
    const items = [];
    for (const g of groups) {
      for (const it of g.items) {
        for (let i = 0; i < countFor(g, it); i++) items.push({ ...it, group: g.key });
      }
    }
    const r = buildLabelSheets(items, cfg);
    preview.replaceChildren(...r.sheets);
    info.textContent = `${items.length} Etiketten auf ${r.sheets.length} Bogen (${r.perPage} pro Bogen). In 100 % drucken, Ränder: keine.` +
      (r.warnings.length ? ` Warnung: Balken bei ${r.warnings.map((w) => w.code).join(', ')} unter ${MIN_MODULE_MM} mm, evtl. schwer lesbar.` : '');
  };

  const numField = (key, label, placeholder = '') =>
    h('label', { class: 'fld' }, h('span', {}, label),
      h('input', { type: 'number', step: 'any', value: cfg[key] ?? '', placeholder, onchange: (e) => { cfg[key] = e.target.value; saveLabelCfg(cfg); draw(); } }));

  const labelSettings = () => h('div', { class: 'card noprint' },
    h('strong', {}, 'Etikettenpapier'),
    h('div', { class: 'muted' }, 'Voreingestellt: A4-Bogen mit 4 × 16 Etiketten à 48,5 × 16,9 mm (64 pro Bogen). Maße in mm.'),
    h('div', { class: 'fields' },
      numField('cols', 'Spalten'), numField('rows', 'Zeilen'), numField('w', 'Breite'), numField('h', 'Höhe'),
      numField('gapX', 'Abstand X'), numField('gapY', 'Abstand Y'),
      numField('marginLeft', 'Rand links', 'mittig'), numField('marginTop', 'Rand oben', 'mittig'),
      numField('offX', 'Versatz X (+ rechts)'), numField('offY', 'Versatz Y (+ oben)'),
      numField('pad', 'Innenrand'), numField('skip', 'Schon benutzte Etiketten'), numField('copies', 'Kopien pro Code')),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'muted' }, 'Enthaltene Codes:'),
      ...groups.map((g) => h('label', { class: 'chk' },
        h('input', { type: 'checkbox', checked: cfg.groups.includes(g.key), onchange: (e) => {
          cfg.groups = e.target.checked ? [...new Set([...cfg.groups, g.key])] : cfg.groups.filter((k) => k !== g.key);
          for (const it of g.items) delete cfg.counts[it.code];
          saveLabelCfg(cfg); renderCodes();
        } }), ` ${g.group.split(' (')[0]}`))),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'muted' }, 'Vorlagen:'),
      h('button', { class: 'btn', onclick: () => preset(['mode', 'location', 'date', 'digits', 'misc'], {}) }, 'Alles'),
      h('button', { class: 'btn', title: 'Alles außer „Wegwerfen“', onclick: () => preset(['mode', 'location', 'date', 'digits', 'misc'], { PCWASTE: 0 }) }, 'Kühlschrank'),
      h('button', { class: 'btn', title: 'Wegwerfen ×2, Verbrauchen, Rückgängig', onclick: () => preset([], { PCWASTE: 2, PCCONSUME: 1, PCUNDO: 1 }) }, 'Mülleimer'),
      h('label', { class: 'chk', style: 'margin-left:auto' }, 'Gestaltung ',
        h('select', { onchange: (e) => { cfg.style = e.target.value; saveLabelCfg(cfg); draw(); } },
          h('option', { value: 'fancy', selected: cfg.style !== 'plain' }, 'Gestaltet'),
          h('option', { value: 'plain', selected: cfg.style === 'plain' }, 'Schlicht (wie etiketten.py)')))),
    h('details', { style: 'margin-top:8px' }, h('summary', { class: 'muted', style: 'cursor:pointer' }, 'Anzahl je Code anpassen'),
      h('div', { class: 'fields' }, ...groups.flatMap((g) => g.items.map((it) =>
        h('label', { class: 'fld' }, h('span', {}, `${it.label} (${it.code})`),
          h('input', { type: 'number', min: 0, max: 99, value: countFor(g, it), onchange: (e) => { cfg.counts[it.code] = Math.max(0, Math.floor(Number(e.target.value) || 0)); saveLabelCfg(cfg); draw(); } })))))),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!cfg.raster, onchange: (e) => { cfg.raster = e.target.checked; saveLabelCfg(cfg); draw(); } }), ' Rahmen mitdrucken (Testdruck auf normalem Papier)'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: cfg.textLine !== false, onchange: (e) => { cfg.textLine = e.target.checked; saveLabelCfg(cfg); draw(); } }), ' Klartext unter dem Barcode'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: () => { cfg = { ...LABEL_DEFAULTS }; saveLabelCfg(cfg); renderCodes(); } }, 'Zurücksetzen')));

  const seg = (key, label) => h('button', { class: 'btn' + (codesView === key ? ' active' : ''), onclick: () => { codesView = key; renderCodes(); } }, label);

  setKids(root, 
    h('div', { class: 'card noprint' }, h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('strong', {}, 'Steuercodes zum Ausdrucken'),
        h('div', { class: 'muted' }, 'Code-128-Barcodes. Modus und Lagerort bleiben aktiv, bis ein anderer Code gescannt wird. MHD-Codes scannst du direkt NACH dem Produkt (optional).')),
      h('div', { class: 'tabs2', style: 'margin:0' }, seg('overview', 'Übersicht A4'), seg('labels', 'Etiketten')),
      h('button', { class: 'btn primary', onclick: () => print() }, 'Drucken'))),
    ...(codesView === 'labels' ? [labelSettings()] : []),
    h('div', { class: 'card noprint row' }, h('span', { class: 'muted grow' }, 'Lagerorte (Namen, Typen, Anlegen, Löschen) verwaltest du in den Einstellungen. Neue Lagerorte erscheinen hier als eigene Steuercodes.'), h('button', { class: 'btn', onclick: () => showTab('settings') }, 'Zu den Einstellungen')),
    h('div', { class: 'noprint' }, info),
    preview,
  );
  draw();
}

// ------------------------------------------------------------ boot

// helpers handed to the inventory tab (it lives in its own module)
const invDeps = {
  h, api, setKids, thumb, toast,
  getState: () => state,
  setMode: (mode) => api('/api/state/mode', { method: 'POST', body: { mode } }).then((r) => { state = r.state; drawState(); }),
  openCamera: () => camera.open(),
};

$('#camHdr')?.addEventListener('click', () => camera.open());
$('#camFab')?.addEventListener('click', () => camera.open());

// design switcher (themes.css); the saved choice is applied before first paint by index.html
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('pantry_theme', t); } catch { /* private mode */ }
  const sel = $('#themeSel');
  if (sel) sel.value = t;
}
$('#themeSel')?.addEventListener('change', (e) => applyTheme(e.target.value));
if ($('#themeSel')) $('#themeSel').value = document.documentElement.dataset.theme || 'navy';

// authenticated file download (the token is sent as a header, not in the URL)
async function download(path) {
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) return toast('Download fehlgeschlagen', 'error');
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'beepstock.json';
  const url = URL.createObjectURL(await res.blob());
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const setDeps = {
  h, api, setKids, toast, download,
  modeLabels: MODE_LABEL, modeOrder: MODE_ORDER,
  getTheme: () => document.documentElement.dataset.theme || 'navy',
  setTheme: applyTheme,
  onSettings: loadSettings,
};

loadSettings();
showTab(tabs[location.hash.slice(1)] ? location.hash.slice(1) : 'scan');
connectWs();
