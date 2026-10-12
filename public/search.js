// Quick search: a dialog reachable from every tab (header button or the "/" key). Type a few letters of the name, the brand
// or the barcode; arrow keys move, Enter opens the product. Results show what is in stock, where, and the nearest best-before date.

export function initQuickSearch({ h, api, setKids, thumb, nutriBadge, expSpan, openProduct }) {
  const dlg = h('dialog', { class: 'qs' });
  const input = h('input', { type: 'search', class: 'grow', placeholder: 'Artikel suchen (Name, Marke, Barcode) …', autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Artikel suchen' });
  const list = h('div', { class: 'qs-list', role: 'listbox' });
  dlg.append(h('div', { class: 'row' }, input, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Schließen')), list);
  document.body.append(dlg);

  let results = [];
  let sel = 0;
  let seq = 0;
  let timer;

  const pick = (p) => { dlg.close(); openProduct(p.barcode); };

  function setSel(i) {
    sel = i;
    list.querySelectorAll('.qs-hit').forEach((el, j) => el.classList.toggle('sel', j === i));
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  function draw() {
    const q = input.value.trim();
    setKids(list, ...results.map((p, i) => h('div', { class: 'qs-hit', role: 'option', onclick: () => pick(p), onmouseenter: () => setSel(i) },
      thumb(p.image_url),
      h('div', { class: 'grow' },
        h('strong', {}, p.name), p.brand ? h('span', { class: 'muted' }, ` · ${p.brand}`) : null,
        h('div', { class: 'muted' }, p.in_stock ? ['nächstes MHD: ', expSpan(p.next_expiry)] : 'nicht im Vorrat', ` · ${p.barcode}`)),
      ...(p.location_names || []).map((n) => h('span', { class: 'badge' }, n)),
      p.opened ? h('span', { class: 'badge open' }, `${p.opened} angebrochen`) : null,
      p.in_stock ? h('span', { class: 'badge' }, `${p.in_stock}×`) : null,
      nutriBadge(p.nutriscore))),
    !results.length ? h('div', { class: 'muted qs-empty' }, q ? 'Nichts gefunden.' : 'Tippe Name, Marke oder Barcode.') : null);
    setSel(sel);
  }

  async function load() {
    const q = input.value.trim();
    const mine = ++seq;
    if (!q) { results = []; sel = 0; return draw(); }
    try {
      const { products } = await api(`/api/products?limit=30&stock_first=1&q=${encodeURIComponent(q)}`);
      if (mine !== seq) return; // an older request answered after a newer one
      results = products;
      sel = 0;
      draw();
    } catch { /* toast shown */ }
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 150); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) setSel((sel + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      if (results[sel]) pick(results[sel]);
      else load();
    }
  });

  function open() {
    if (dlg.open) return input.focus();
    document.querySelector('dialog[open]')?.close();
    dlg.showModal();
    input.select();
    draw();
  }

  // "/" opens the search like on many websites. Not while typing in a field, inside a dialog, or in the middle of a scanner burst.
  let lastKey = 0;
  document.addEventListener('keydown', (e) => {
    const now = performance.now();
    const burst = now - lastKey < 120;
    lastKey = now;
    if (e.key !== '/' || burst || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement;
    if ((el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    open();
  });

  return { open };
}
