// Printable sheets for the control codes:
//  - buildOverview(): one fancy A4 page with every control code
//  - buildLabelSheets(): the same codes on label paper (grid of labels, e.g. 4 x 16 labels of 48.5 x 16.9 mm)
// Both are plain DOM; printing is done by the browser (print.css sets @page A4, margin 0). Print at 100 %.

const SVGNS = 'http://www.w3.org/2000/svg';
export const MIN_MODULE_MM = 0.19; // narrowest bar for reliable scanning at 300-600 dpi (same limit as etiketten.py)

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Code-128 as vector SVG without size attributes; `data-modules` holds the width in bar modules. */
export function barcodeSvg(code) {
  const svg = document.createElementNS(SVGNS, 'svg');
  window.JsBarcode(svg, code, { format: 'CODE128', width: 1, height: 40, displayValue: false, margin: 0 });
  const w = parseFloat(svg.getAttribute('width')) || 100;
  const hh = parseFloat(svg.getAttribute('height')) || 40;
  svg.setAttribute('viewBox', `0 0 ${w} ${hh}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.removeAttribute('style');
  svg.dataset.modules = String(w);
  return svg;
}

// ------------------------------------------------------------------ overview (A4, fancy)

const GROUPS = {
  location: { title: 'Lagerort', hint: 'gilt für alle folgenden Produkte, bis ein anderer gescannt wird', c: '#0f766e', t: '#e6f6f4', cols: 4, bh: 9 },
  mode: { title: 'Modus', hint: 'bleibt aktiv, bis ein anderer Modus gescannt wird', c: '#2563eb', t: '#e8f0fe', cols: 4, bh: 10 },
  date: { title: 'Haltbarkeit (MHD)', hint: 'optional, direkt NACH dem Produkt scannen', c: '#ea580c', t: '#fff0e6', cols: 5, bh: 8 },
  digits: { title: 'MHD eintippen', hint: 'Ziffern scannen (Tage, TTMM, TTMMJJ), dann OK', c: '#7c3aed', t: '#f1eafe', cols: 6, bh: 7 },
  misc: { title: 'Sonstiges', hint: '', c: '#db2777', t: '#fde8f1', cols: 6, bh: 8 },
};
const GROUP_ORDER = ['mode', 'location', 'date', 'digits', 'misc'];

const CODE_ICON = {
  PCADD: '➕', PCCONSUME: '🍽️', PCOPEN: '📂', PCWASTE: '🗑️', PCSHOP: '🛒', PCINFO: 'ℹ️', PCINV: '📋',
  PCNOK: '✔️', PCNCLR: '⌫', PCUNDO: '↩️', PCCLEAR: '🧹',
};
function iconFor(group, item) {
  if (CODE_ICON[item.code]) return CODE_ICON[item.code];
  if (group === 'location') {
    const n = item.label.toLowerCase();
    if (/tief|gefrier|froster/.test(n)) return '❄️';
    if (/kühl|kuehl/.test(n)) return '🧊';
    if (/keller/.test(n)) return '🏚️';
    if (/schrank|vorrat|kammer/.test(n)) return '🗄️';
    return '📍';
  }
  if (group === 'date') return '⏳';
  if (item.code.startsWith('PCQ')) return '✖️';
  return '';
}

function logo() {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  const bars = [[5, 2], [9, 1], [12, 3], [17, 1], [20, 2], [24, 1], [27, 1]];
  svg.innerHTML = bars.map(([x, w]) => `<rect x="${x}" y="6" width="${w}" height="20" fill="#2f7dff"/>`).join('') +
    '<rect x="3" y="15" width="26" height="2.4" rx="1.2" fill="#ff5d7a"/>';
  return svg;
}

export function buildOverview(groups) {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const sheet = h('div', { class: 'sheet overview' });
  sheet.append(
    h('div', { class: 'ov-head' },
      h('div', { class: 'ov-logo' }, logo()),
      h('div', { class: 'ov-title' }, h('h1', {}, 'Beepstock'), h('div', {}, 'Steuercodes für den Barcode-Scanner')),
      h('ol', { class: 'ov-steps' },
        h('li', {}, 'Modus wählen'), h('li', {}, 'Lagerort wählen'), h('li', {}, 'Produkte scannen'), h('li', {}, 'MHD direkt danach (optional)'))),
  );
  for (const key of GROUP_ORDER) {
    const g = byKey.get(key);
    const meta = GROUPS[key];
    if (!g || !g.items.length) continue;
    const cols = Math.min(meta.cols, g.items.length);
    sheet.append(
      h('section', { class: 'ov-group', style: `--c:${meta.c};--t:${meta.t};--cols:${meta.cols};--bh:${meta.bh}mm` },
        h('div', { class: 'ov-gh' }, meta.title, meta.hint ? h('span', { class: 'hint' }, meta.hint) : null),
        h('div', { class: 'ov-grid', style: cols < meta.cols ? `--cols:${Math.max(cols, 3)}` : '' },
          ...g.items.map((it) => {
            const svg = barcodeSvg(it.code);
            svg.style.width = `min(100%, ${(parseFloat(svg.dataset.modules) * 0.5).toFixed(1)}mm)`;
            const icon = iconFor(key, it);
            return h('div', { class: 'ov-card' },
              h('div', { class: 'lbl' }, icon ? h('span', { class: 'ic' }, icon) : null, h('span', { class: 'tx' }, it.label)),
              svg,
              h('div', { class: 'cd' }, it.code));
          }))),
    );
  }
  sheet.append(h('div', { class: 'ov-foot' },
    h('span', {}, 'Beispiel: Einlagern → Kühlschrank → Joghurt scannen → +3 Tage → Milch scannen → …'),
    h('span', {}, 'Code 128 · Drucken in 100 %')));
  return sheet;
}

// ------------------------------------------------------------------ label paper

export const DEFAULT_LABEL_CFG = {
  cols: 4, rows: 16, w: 48.5, h: 16.9, gapX: 0, gapY: 0,
  marginLeft: '', marginTop: '', // '' = grid centred on the page (like etiketten.py)
  offX: 0, offY: 0, pad: 2, skip: 0, raster: false, textLine: true, style: 'fancy',
};

const A4_W = 210, A4_H = 297;
const TEXT_H = 2.6; // mm reserved for the human-readable line, as in etiketten.py
const MAX_MODULE_MM = 0.45;

/** items: [{code,label}] in print order (copies already expanded). Returns {sheets, warnings, perPage}. */
export function buildLabelSheets(items, cfgIn) {
  const c = { ...DEFAULT_LABEL_CFG, ...cfgIn };
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d);
  const cols = Math.max(1, Math.floor(num(c.cols, 4))), rows = Math.max(1, Math.floor(num(c.rows, 16)));
  const lw = num(c.w, 48.5), lh = num(c.h, 16.9), gx = num(c.gapX, 0), gy = num(c.gapY, 0), pad = num(c.pad, 2);
  const gridW = cols * lw + (cols - 1) * gx, gridH = rows * lh + (rows - 1) * gy;
  const left = (c.marginLeft === '' ? (A4_W - gridW) / 2 : num(c.marginLeft, 0)) + num(c.offX, 0);
  const top = (c.marginTop === '' ? (A4_H - gridH) / 2 : num(c.marginTop, 0)) - num(c.offY, 0); // + = move up
  const perPage = cols * rows;
  const skip = Math.min(Math.max(0, Math.floor(num(c.skip, 0))), perPage - 1);
  const textH = c.textLine ? TEXT_H : 0;
  const warnings = [];

  const slots = [...Array(skip).fill(null), ...items];
  const sheets = [];
  for (let start = 0; start < Math.max(slots.length, 1); start += perPage) {
    const sheet = h('div', { class: 'sheet labels' });
    slots.slice(start, start + perPage).forEach((it, idx) => {
      const col = idx % cols, row = Math.floor(idx / cols);
      const x = left + col * (lw + gx), y = top + row * (lh + gy);
      const cell = h('div', { class: 'lab' + (c.raster ? ' raster' : ''), style: `left:${x.toFixed(2)}mm;top:${y.toFixed(2)}mm;width:${lw}mm;height:${lh}mm;padding:${pad}mm` });
      if (it && c.style === 'plain') {
        // plain: barcode + one text line, same geometry as etiketten.py
        const svg = barcodeSvg(it.code);
        const modules = parseFloat(svg.dataset.modules);
        const moduleMm = Math.min((lw - 2 * pad) / modules, MAX_MODULE_MM);
        if (moduleMm < MIN_MODULE_MM && !warnings.some((w) => w.code === it.code)) warnings.push({ code: it.code, moduleMm });
        svg.style.width = `${(modules * moduleMm).toFixed(2)}mm`;
        svg.style.height = `${Math.max(lh - 2 * pad - textH, 1).toFixed(2)}mm`;
        cell.append(svg);
        if (c.textLine) cell.append(h('div', { class: 'ltx', style: `height:${TEXT_H}mm` }, `${it.label} · ${it.code}`));
      } else if (it) {
        // fancy: coloured stripe, icon + name + code on top, wide barcode below
        const meta = GROUPS[it.group] || { c: '#333' };
        const rowH = 4.4, gap = 0.5, stripe = 1.3, quiet = 2; // quiet = extra white space left/right of the bars (mm)
        const svg = barcodeSvg(it.code);
        const modules = parseFloat(svg.dataset.modules);
        const availW = lw - 2 * pad;
        const moduleMm = Math.min((availW - 2 * quiet) / modules, MAX_MODULE_MM);
        if (moduleMm < MIN_MODULE_MM && !warnings.some((w) => w.code === it.code)) warnings.push({ code: it.code, moduleMm });
        svg.style.width = `${(modules * moduleMm).toFixed(2)}mm`;
        svg.style.height = `${Math.max(lh - 2 * pad - rowH - gap, 1).toFixed(2)}mm`;
        const icon = iconFor(it.group, it);
        cell.classList.add('fancy');
        cell.append(
          h('div', { class: 'stripe', style: `width:${stripe}mm;background:${meta.c}` }),
          h('div', { class: 'lt', style: `height:${rowH}mm;margin-bottom:${gap}mm` },
            icon ? h('span', { class: 'ic' }, icon) : null,
            h('span', { class: 'n' }, it.label),
            h('span', { class: 'c' }, it.code)),
          svg);
      }
      sheet.append(cell);
    });
    sheets.push(sheet);
  }
  return { sheets, warnings, perPage };
}
