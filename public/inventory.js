// Inventory count tab: start a count, compare "stock before" with "inventory scan" per product and location,
// and take either value with one click. Helpers (h, api, ...) are injected by app.js.

let onlyDiffs = true;

export async function renderInventory(root, d) {
  const { h, api, setKids, thumb, toast } = d;
  const reload = () => renderInventory(root, d);
  const data = await api('/api/inventory');
  const state = d.getState() || {};
  const locName = (id) => (id === 0 ? 'Ohne Lagerort' : (data.locations.find((l) => l.id === id)?.name ?? `Ort ${id}`));

  // ---------------------------------------------------------------- no count running: start screen
  if (!data.session) {
    const picked = new Set(state.location_id ? [state.location_id] : []);
    const boxes = [...data.locations, { id: 0, name: 'Ohne Lagerort' }].map((l) =>
      h('label', { class: 'chk inv-pick' }, h('input', { type: 'checkbox', checked: picked.has(l.id), onchange: (e) => (e.target.checked ? picked.add(l.id) : picked.delete(l.id)) }), ` ${l.name}`));
    setKids(root,
      h('div', { class: 'card' },
        h('h3', { style: 'margin:0 0 6px' }, 'Inventur'),
        h('div', { class: 'muted' }, 'Zähle, was wirklich da ist, und vergleiche es mit dem Bestand in der App. Beim Zählen wird nichts gebucht.'),
        h('ol', { class: 'inv-steps' },
          h('li', {}, 'Lagerorte wählen, die du zählst, und die Inventur starten.'),
          h('li', {}, 'Lagerort-Code scannen, dann alle Produkte dieses Ortes scannen (jede Packung einzeln).'),
          h('li', {}, 'Hier vergleichen: pro Produkt den alten Bestand behalten oder den gezählten Wert übernehmen.')),
        h('div', { class: 'row', style: 'margin:10px 0' }, h('span', { class: 'muted' }, 'Zu zählen:'), ...boxes),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: async () => {
            await api('/api/inventory/start', { method: 'POST', body: { location_ids: [...picked] } });
            await d.setMode('count');
            toast('Inventur gestartet. Jetzt scannen.', 'ok');
            reload();
          } }, 'Inventur starten'),
          h('span', { class: 'muted' }, 'Ohne Auswahl wird der Ort automatisch beim ersten Scan aufgenommen. Per Scanner: Code „Inventur“ (PCINV).'))));
    return;
  }

  // ---------------------------------------------------------------- count running: compare
  const s = data.session;
  const rows = data.rows;
  const act = (row, action) => api('/api/inventory/row', { method: 'POST', body: { barcode: row.barcode, location_id: row.location_id, action } }).then(reload);
  const step = (row, delta) => api('/api/inventory/row', { method: 'PATCH', body: { barcode: row.barcode, location_id: row.location_id, counted: Math.max(0, row.counted + delta) } }).then(reload);

  const scopeAll = [...data.locations, { id: 0, name: 'Ohne Lagerort' }];
  const header = h('div', { class: 'card' },
    h('div', { class: 'row inv-head' },
      h('div', { class: 'grow' }, h('h3', { style: 'margin:0' }, 'Inventur läuft'),
        h('div', { class: 'muted' }, `seit ${new Date(s.started_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`)),
      state.mode === 'count'
        ? h('span', { class: 'badge open' }, 'Inventur-Modus aktiv')
        : h('button', { class: 'btn primary', onclick: () => d.setMode('count').then(reload) }, 'Inventur-Modus aktivieren'),
      h('button', { class: 'btn', onclick: () => d.openCamera() }, '📷 Kamera')),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'muted' }, 'Gezählte Orte:'),
      ...scopeAll.map((l) => h('label', { class: 'chk inv-pick' },
        h('input', { type: 'checkbox', checked: s.scope.includes(l.id), onchange: (e) => api('/api/inventory/scope', { method: 'POST', body: { location_id: l.id, include: e.target.checked } }).then(reload) }), ` ${l.name}`))),
    h('div', { class: 'muted', style: 'margin-top:4px' }, 'Ein Ort gilt als gezählt, sobald darin gescannt wurde. Ohne Scan fehlende Produkte erscheinen mit Inventurwert 0.'));

  const diffRows = rows.filter((r) => r.before !== r.counted);
  const openRows = diffRows.filter((r) => r.resolved == null);
  const bulk = h('div', { class: 'card' },
    h('div', { class: 'row inv-head' },
      h('div', { class: 'grow' }, h('strong', {}, `${openRows.length} offene Abweichung${openRows.length === 1 ? '' : 'en'}`),
        h('span', { class: 'muted' }, `  · ${rows.length} Positionen, ${diffRows.length} mit Unterschied`)),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: onlyDiffs, onchange: (e) => { onlyDiffs = e.target.checked; reload(); } }), ' nur Abweichungen'),
      openRows.length ? h('button', { class: 'btn', onclick: async () => { if (confirm(`Bei allen ${openRows.length} offenen Abweichungen den alten Bestand behalten?`)) { await api('/api/inventory/resolve-all', { method: 'POST', body: { action: 'keep' } }); reload(); } } }, 'Alle: Vorher behalten') : null,
      openRows.length ? h('button', { class: 'btn primary', onclick: async () => { if (confirm(`Bei allen ${openRows.length} offenen Abweichungen den Inventurwert übernehmen? Der Bestand wird entsprechend geändert.`)) { await api('/api/inventory/resolve-all', { method: 'POST', body: { action: 'apply' } }); reload(); } } }, 'Alle: Inventur übernehmen') : null));

  const rowEl = (r) => {
    const diff = r.counted - r.before;
    const same = diff === 0;
    return h('div', { class: 'inv-row' + (same ? ' same' : '') },
      thumb(r.image_url),
      h('div', { class: 'grow inv-name' }, h('strong', {}, r.name), r.brand ? h('span', { class: 'muted' }, ` · ${r.brand}`) : null),
      h('div', { class: 'inv-num' }, h('small', {}, 'Vorher'), h('b', {}, r.before)),
      h('div', { class: 'inv-num' }, h('small', {}, 'Inventur'),
        h('div', { class: 'inv-step' },
          h('button', { class: 'btn', type: 'button', 'aria-label': 'Minus', onclick: () => step(r, -1) }, '−'),
          h('b', {}, r.counted),
          h('button', { class: 'btn', type: 'button', 'aria-label': 'Plus', onclick: () => step(r, 1) }, '+'))),
      same
        ? h('div', { class: 'inv-act' }, h('span', { class: 'badge' }, '✓ stimmt'))
        : h('div', { class: 'inv-act' },
          h('span', { class: 'badge ' + (diff < 0 ? 'bad' : 'open') }, `${diff > 0 ? '+' : ''}${diff}`),
          h('button', { class: 'btn' + (r.resolved === 'keep' ? ' on' : ''), title: `Bestand bleibt bei ${r.before}`, onclick: () => act(r, 'keep') }, `Vorher (${r.before}) ${r.resolved === 'keep' ? '✓' : 'behalten'}`),
          h('button', { class: 'btn primary', title: `Bestand wird auf ${r.counted} gesetzt`, onclick: () => act(r, 'apply') }, `Inventur (${r.counted}) übernehmen`)));
  };

  const groups = new Map();
  for (const r of rows) {
    if (onlyDiffs && r.before === r.counted) continue;
    if (!groups.has(r.location_id)) groups.set(r.location_id, []);
    groups.get(r.location_id).push(r);
  }
  const groupCards = [...groups.entries()].map(([id, list]) => {
    list.sort((a, b) => (a.before === a.counted) - (b.before === b.counted) || a.name.localeCompare(b.name, 'de'));
    return h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 6px' }, locName(id), h('span', { class: 'badge' }, `${list.length}`)), ...list.map(rowEl));
  });

  setKids(root, header, bulk,
    ...(groupCards.length ? groupCards : [h('div', { class: 'card muted' }, rows.length ? 'Keine Abweichungen – Bestand und Inventur stimmen überein.' : 'Noch nichts gezählt. Lagerort-Code scannen und die Produkte dieses Ortes scannen.')]),
    h('div', { class: 'row', style: 'margin:4px 0 16px' },
      h('button', { class: 'btn primary', onclick: async () => {
        if (openRows.length && !confirm(`Es gibt noch ${openRows.length} offene Abweichung(en), die unverändert bleiben. Inventur trotzdem abschließen?`)) return;
        await api('/api/inventory/finish', { method: 'POST', body: {} });
        if (state.mode === 'count') await d.setMode('consume');
        toast('Inventur abgeschlossen.', 'ok');
        reload();
      } }, 'Inventur abschließen'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Inventur verwerfen? Die gezählten Werte gehen verloren, bereits übernommene Änderungen am Bestand bleiben.')) return;
        await api('/api/inventory/finish', { method: 'POST', body: { cancel: true } });
        if (state.mode === 'count') await d.setMode('consume');
        reload();
      } }, 'Verwerfen')));
}
