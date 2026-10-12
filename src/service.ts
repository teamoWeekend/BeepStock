import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { MODES, type Mode, normalizeBarcode, parseControl, resolveDigits } from './control.js';
import { addDays, today } from './dates.js';
import { q, q1 } from './db.js';
import { countScan, undoCount } from './inventory.js';
import { fetchOff } from './off.js';
import { downloadImage, hasImageFile, localUrl } from './images.js';
import { getSettings } from './settings.js';
import { deriveStorage } from './storage.js';

export const bus = new EventEmitter();

export interface Product {
  barcode: string;
  name: string;
  brand: string | null;
  quantity_text: string | null;
  categories: string | null;
  image_url: string | null;
  nutriscore: string | null;
  nova_group: number | null;
  ecoscore: string | null;
  nutriments: Record<string, number | string>;
  ingredients: string | null;
  allergens: string | null;
  serving_size: string | null;
  off_found: boolean | null;
  off_fetched_at: string | null;
  shelf_life_days: number | null;
  days_after_opening: number | null;
  min_stock: number;
  store_id: number | null;
  source: string | null;
  image_source_url: string | null;
  image_file: string | null;
  categories_tags: string[] | null;
  conservation: string | null;
  location_id: number | null; // default storage location
  auto_defaults: boolean; // location_id / move_on_open were derived automatically (false = set by hand)
  move_on_open: boolean; // pantry -> fridge when opened
}

export interface AppState {
  mode: Mode;
  location_id: number | null;
  location_name: string | null;
  pending_qty: number | null;
  digits: string;
  updated_at: string;
}

export interface ScanResult {
  ok: boolean;
  level: 'ok' | 'warn' | 'error';
  kind: 'product' | 'control';
  message: string;
  code: string;
  mode: Mode;
  product?: Product;
  needs_name?: boolean;
  state: AppState;
}

// ---------------------------------------------------------------- state

export async function getState(): Promise<AppState> {
  let s = await selectState();
  const cfg = await getSettings();
  const ageMin = (Date.now() - new Date(s.updated_at).getTime()) / 60000;
  const patch: Partial<AppState> = {};
  if (cfg.mode_idle_minutes > 0 && ageMin > cfg.mode_idle_minutes) {
    if (s.mode !== cfg.default_mode) patch.mode = cfg.default_mode;
  }
  if (ageMin > cfg.pending_minutes && (s.pending_qty || s.digits)) {
    patch.pending_qty = null;
    patch.digits = '';
  }
  if (Object.keys(patch).length) s = await saveState(patch, false);
  return s;
}

async function selectState(): Promise<AppState> {
  return (await q1<AppState>(
    'SELECT a.mode, a.location_id, l.name AS location_name, a.pending_qty, a.digits, a.updated_at FROM app_state a LEFT JOIN locations l ON l.id = a.location_id WHERE a.id = 1',
  ))!;
}

type StatePatch = Partial<Pick<AppState, 'mode' | 'location_id' | 'pending_qty' | 'digits'>>;

export async function saveState(patch: StatePatch, touch = true): Promise<AppState> {
  const keys = Object.keys(patch) as (keyof StatePatch)[];
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  if (touch) sets.push('updated_at = now()');
  const values = keys.map((k) => patch[k]);
  await q(`UPDATE app_state SET ${sets.join(', ')} WHERE id = 1`, values);
  return selectState();
}

export async function setLocation(id: number | null): Promise<AppState> {
  const s = await saveState({ location_id: id });
  bus.emit('state', s);
  return s;
}

export const listLocations = () => q<{ id: number; name: string; kind: string }>('SELECT id, name, kind FROM locations ORDER BY id');

export async function setMode(mode: Mode): Promise<AppState> {
  const s = await saveState({ mode });
  bus.emit('state', s);
  return s;
}

// ---------------------------------------------------------------- products

export async function getProduct(barcode: string): Promise<Product | undefined> {
  return q1<Product>('SELECT * FROM products WHERE barcode = $1', [barcode]);
}

/** Looks the product up locally; fetches from Open Food Facts when unknown or not yet resolved. */
export async function resolveProduct(barcode: string, force = false): Promise<{ product: Product; offError?: string }> {
  let product = await getProduct(barcode);
  const stale =
    !product ||
    force ||
    (product.off_found !== true && (!product.off_fetched_at || Date.now() - new Date(product.off_fetched_at).getTime() > 10 * 60000));
  if (!stale && product) return { product };

  const off = await fetchOff(barcode);
  if (off.status === 'found') {
    const p = off.product;
    product = (await q1<Product>(
      `INSERT INTO products (barcode, name, brand, quantity_text, categories, image_url, nutriscore, nova_group, ecoscore,
                             nutriments, ingredients, allergens, serving_size, off_found, off_fetched_at, source, categories_tags, conservation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,now(),$15,$16,$17)
       ON CONFLICT (barcode) DO UPDATE SET
         name = CASE WHEN products.off_found IS TRUE AND NOT $14 THEN products.name ELSE EXCLUDED.name END,
         brand = EXCLUDED.brand, quantity_text = EXCLUDED.quantity_text, categories = EXCLUDED.categories,
         image_url = EXCLUDED.image_url, nutriscore = EXCLUDED.nutriscore, nova_group = EXCLUDED.nova_group,
         ecoscore = EXCLUDED.ecoscore, nutriments = EXCLUDED.nutriments, ingredients = EXCLUDED.ingredients,
         allergens = EXCLUDED.allergens, serving_size = EXCLUDED.serving_size, off_found = true, off_fetched_at = now(), source = EXCLUDED.source,
         categories_tags = EXCLUDED.categories_tags, conservation = EXCLUDED.conservation
       RETURNING *`,
      [
        barcode, p.name, p.brand, p.quantity_text, p.categories, p.image_url, p.nutriscore, p.nova_group, p.ecoscore,
        JSON.stringify(p.nutriments), p.ingredients, p.allergens, p.serving_size, force, p.source, p.categories_tags, p.conservation,
      ],
    ))!;
    product = await applyDerivedDefaults(product); // default storage location + move-on-open, unless set by hand
    void localizeImage(product).catch(() => undefined); // keep a local copy; the scan itself does not wait for the download
    return { product };
  }

  const offError = off.status === 'error' ? off.error : undefined;
  if (!product) {
    product = (await q1<Product>(
      `INSERT INTO products (barcode, name, off_found, off_fetched_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (barcode) DO UPDATE SET off_fetched_at = now() RETURNING *`,
      [barcode, `Unbekannt ${barcode}`, off.status === 'not_found' ? false : null],
    ))!;
  } else {
    product = (await q1<Product>('UPDATE products SET off_fetched_at = now(), off_found = COALESCE($2, off_found) WHERE barcode = $1 RETURNING *', [
      barcode,
      off.status === 'not_found' ? false : null,
    ]))!;
  }
  return { product, offError };
}

const isPlaceholder = (p: Product) => p.off_found !== true && p.name === `Unbekannt ${p.barcode}`;

// ---------------------------------------------------------------- stock operations

const PICK_ORDER = `(opened_at IS NULL), COALESCE(best_before, 'infinity'::date), added_at`;

export async function logEvent(kind: string, barcode: string | null, itemIds: number[], detail: object = {}): Promise<void> {
  await q('INSERT INTO events (kind, barcode, item_ids, detail) VALUES ($1,$2,$3,$4)', [kind, barcode, itemIds, JSON.stringify(detail)]);
}

export async function stockCount(barcode: string): Promise<number> {
  const r = await q1<{ n: number }>(`SELECT count(*)::int AS n FROM stock_items WHERE barcode = $1 AND status = 'in_stock'`, [barcode]);
  return r?.n ?? 0;
}

async function addStock(p: Product, qty: number, bestBefore: string | null, locationId: number | null): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `INSERT INTO stock_items (barcode, best_before, location_id) SELECT $1, $2::date, $4 FROM generate_series(1, $3) RETURNING id`,
    [p.barcode, bestBefore, qty, locationId],
  );
  await q('UPDATE shopping_items SET done = true, done_at = now() WHERE barcode = $1 AND NOT done', [p.barcode]);
  return rows.map((r) => r.id);
}

async function finishStock(barcode: string, qty: number, status: 'consumed' | 'wasted', reason: string | null): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `UPDATE stock_items SET status = $2, finished_at = now(), waste_reason = $3
     WHERE id IN (SELECT id FROM stock_items WHERE barcode = $1 AND status = 'in_stock' ORDER BY ${PICK_ORDER} LIMIT $4)
     RETURNING id`,
    [barcode, status, reason, qty],
  );
  return rows.map((r) => r.id);
}

async function openStock(barcode: string, qty: number): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `UPDATE stock_items SET opened_at = now()
     WHERE id IN (SELECT id FROM stock_items WHERE barcode = $1 AND status = 'in_stock' AND opened_at IS NULL
                  ORDER BY COALESCE(best_before, 'infinity'::date), added_at LIMIT $2)
     RETURNING id`,
    [barcode, qty],
  );
  return rows.map((r) => r.id);
}

/** Puts a product on the shopping list (or raises the qty of an open entry). */
export async function addToShopping(p: Product | null, name: string, qty: number, source: string): Promise<{ id: number; created: boolean }> {
  if (p) {
    const existing = await q1<{ id: number }>('SELECT id FROM shopping_items WHERE barcode = $1 AND NOT done', [p.barcode]);
    if (existing) {
      await q('UPDATE shopping_items SET qty = qty + $2 WHERE id = $1', [existing.id, qty]);
      return { id: existing.id, created: false };
    }
  }
  const row = await q1<{ id: number }>(
    'INSERT INTO shopping_items (barcode, name, qty, source) VALUES ($1,$2,$3,$4) RETURNING id',
    [p?.barcode ?? null, name, qty, source],
  );
  return { id: row!.id, created: true };
}

/** Auto restock: below the configured minimum stock -> shopping list. */
export async function restockCheck(p: Product): Promise<string | null> {
  if (p.min_stock <= 0) return null;
  const have = await stockCount(p.barcode);
  if (have >= p.min_stock) return null;
  const open = await q1('SELECT id FROM shopping_items WHERE barcode = $1 AND NOT done', [p.barcode]);
  if (open) return null;
  await addToShopping(p, productLabel(p), p.min_stock - have, 'auto');
  return 'Einkaufsliste ergänzt';
}

export const productLabel = (p: Product) => (p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? `${p.name} (${p.brand})` : p.name);

// ---------------------------------------------------------------- scanning

function result(partial: Omit<ScanResult, 'state' | 'mode' | 'ok'> & { ok?: boolean }, state: AppState): ScanResult {
  return { ok: partial.level !== 'error', ...partial, mode: state.mode, state };
}

export async function handleScan(rawInput: string, source = 'api'): Promise<ScanResult> {
  const raw = rawInput.trim();
  let state = await getState();
  const base = { code: raw, kind: 'control' as const };

  if (!raw) return result({ ...base, level: 'error', message: 'Leerer Code' }, state);

  const ctl = parseControl(raw);
  if (ctl) {
    let message = '';
    let level: 'ok' | 'warn' | 'error' = 'ok';
    switch (ctl.type) {
      case 'mode':
        state = await saveState({ mode: ctl.mode });
        message = `Modus: ${MODE_LABEL[ctl.mode]}`;
        break;
      case 'location': {
        const loc = await q1<{ id: number; name: string }>('SELECT id, name FROM locations WHERE id = $1', [ctl.id]);
        if (!loc) {
          level = 'error';
          message = `Unbekannter Lagerort (Code PCLOC${ctl.id})`;
        } else {
          state = await saveState({ location_id: loc.id });
          message = `Lagerort: ${loc.name}`;
        }
        break;
      }
      case 'date': {
        state = await saveState({ digits: '' });
        const r = await applyDateToLastAdd(ctl.date, state.mode);
        message = r.message;
        level = r.ok ? 'ok' : 'warn';
        break;
      }
      case 'digit':
        state = await saveState({ digits: (state.digits + ctl.digit).slice(0, 8) });
        message = `Eingabe: ${state.digits}`;
        break;
      case 'digits-clear':
        state = await saveState({ digits: '' });
        message = 'Eingabe gelöscht';
        break;
      case 'digits-ok': {
        const date = resolveDigits(state.digits);
        if (!date) {
          level = 'error';
          message = `Ungültiges Datum: ${state.digits || '(leer)'}`;
          state = await saveState({ digits: '' });
        } else {
          state = await saveState({ digits: '' });
          const r = await applyDateToLastAdd(date, state.mode);
          message = r.message;
          level = r.ok ? 'ok' : 'warn';
        }
        break;
      }
      case 'qty':
        state = await saveState({ pending_qty: ctl.qty });
        message = `Menge für nächsten Scan: ${ctl.qty}`;
        break;
      case 'clear':
        state = await saveState({ pending_qty: null, digits: '' });
        message = 'Menge und Eingabe zurückgesetzt';
        break;
      case 'undo': {
        const r = await undoLast();
        message = r.message;
        level = r.ok ? 'ok' : 'warn';
        state = await getState();
        break;
      }
    }
    const res = result({ ...base, level, message }, state);
    bus.emit('scan', res);
    bus.emit('state', state);
    return res;
  }

  const barcode = normalizeBarcode(raw);
  if (!barcode) {
    const res = result({ ...base, level: 'error', message: `Kein gültiger Barcode: ${raw}` }, state);
    bus.emit('scan', res);
    return res;
  }

  const { product, offError } = await resolveProduct(barcode);
  const qty = state.pending_qty ?? 1;
  const label = productLabel(product);
  const needsName = isPlaceholder(product);
  let level: 'ok' | 'warn' | 'error' = 'ok';
  let message = '';

  switch (state.mode) {
    case 'add': {
      // The MHD is optional and scanned AFTER the product; a product's default shelf life is applied right away.
      const bb = product.shelf_life_days ? today(addDays(new Date(), product.shelf_life_days)) : null;
      // the product's own default location wins; the scanned (sticky) location is the fallback
      const useLoc = product.location_id ?? state.location_id;
      const locName = useLoc ? (await q1<{ name: string }>('SELECT name FROM locations WHERE id = $1', [useLoc]))?.name : null;
      const ids = await addStock(product, qty, bb, useLoc);
      await logEvent('add', barcode, ids, { best_before: bb, source, location_id: useLoc });
      const where = locName ? ` → ${locName}${product.location_id ? (product.auto_defaults ? ' (automatisch)' : '') : ''}` : '';
      message = `+${qty} ${label}${where}${bb ? ` · MHD ${bb} (Standard)` : ' · MHD optional: jetzt scannen'}`;
      state = await saveState({ pending_qty: null, digits: '' });
      break;
    }
    case 'consume': {
      const ids = await finishStock(barcode, qty, 'consumed', null);
      if (ids.length) {
        await logEvent('consume', barcode, ids);
        const left = await stockCount(barcode);
        const extra = await restockCheck(product);
        message = `−${ids.length} ${label} verbraucht · noch ${left}${extra ? ' · ' + extra : ''}`;
        if (ids.length < qty) level = 'warn';
      } else {
        level = 'warn';
        message = `${label}: nicht im Vorrat`;
        const extra = await restockCheck(product);
        if (extra) message += ` · ${extra}`;
      }
      state = await saveState({ pending_qty: null });
      break;
    }
    case 'open': {
      const ids = await openStock(barcode, qty);
      if (ids.length) {
        const moved = await relocateOnOpen(ids);
        await logEvent('open', barcode, ids, { moved: moved.moved });
        message = `${label} angebrochen${moved.to ? ` · umgelagert nach ${moved.to}` : ''}${product.days_after_opening ? ` · ${product.days_after_opening} Tage haltbar` : ''}`;
      } else {
        level = 'warn';
        message = `${label}: keine ungeöffnete Packung im Vorrat`;
      }
      state = await saveState({ pending_qty: null });
      break;
    }
    case 'waste': {
      const ids = await finishStock(barcode, qty, 'wasted', null);
      if (ids.length) {
        await logEvent('waste', barcode, ids);
        const extra = (await getSettings()).restock_on_waste ? await restockCheck(product) : null;
        message = `${label} weggeworfen${extra ? ' · ' + extra : ''}`;
      } else {
        level = 'warn';
        message = `${label}: nicht im Vorrat`;
      }
      state = await saveState({ pending_qty: null });
      break;
    }
    case 'shop': {
      const r = await addToShopping(product, label, qty, 'scan');
      await logEvent('shop', barcode, [], { shopping_id: r.id, created: r.created, qty });
      message = `${label} auf die Einkaufsliste (${qty}×)`;
      state = await saveState({ pending_qty: null });
      break;
    }
    case 'count': {
      const loc = state.location_id ?? 0;
      const r = await countScan(barcode, loc, qty);
      message = `Inventur ${label}: gezählt ${r.counted} · Bestand ${r.stock}${state.location_name ? ` (${state.location_name})` : ''}${r.autoStarted ? ' · Inventur gestartet' : ''}`;
      state = await saveState({ pending_qty: null });
      break;
    }
    case 'info': {
      const left = await stockCount(barcode);
      message = `${label}: ${left} im Vorrat`;
      break;
    }
  }

  if (needsName) {
    level = 'warn';
    message += offError ? ' · Open Food Facts nicht erreichbar, bitte später benennen' : ' · Produkt unbekannt, bitte benennen';
  } else if (offError) {
    message += ' · (OFF-Fehler)';
  }

  const res = result({ code: raw, kind: 'product', level, message, product, needs_name: needsName }, state);
  bus.emit('scan', res);
  bus.emit('state', state);
  bus.emit('change', { what: 'stock' });
  return res;
}

const MODE_LABEL: Record<Mode, string> = {
  add: 'Einlagern',
  consume: 'Verbrauchen',
  open: 'Anbrechen',
  waste: 'Wegwerfen',
  shop: 'Auf Einkaufsliste',
  info: 'Nur Info',
  count: 'Inventur',
};

// ---------------------------------------------------------------- undo

export async function undoLast(): Promise<{ ok: boolean; message: string }> {
  const ev = await q1<{ id: number; kind: string; barcode: string; item_ids: number[]; detail: any }>(
    'SELECT * FROM events WHERE NOT undone ORDER BY id DESC LIMIT 1',
  );
  if (!ev) return { ok: false, message: 'Nichts zum Rückgängigmachen' };
  switch (ev.kind) {
    case 'add':
      await q(`DELETE FROM stock_items WHERE id = ANY($1::bigint[])`, [ev.item_ids]);
      break;
    case 'consume':
    case 'waste':
    case 'adjust':
      await q(`UPDATE stock_items SET status='in_stock', finished_at=NULL, waste_reason=NULL WHERE id = ANY($1::bigint[])`, [ev.item_ids]);
      break;
    case 'count':
      await undoCount(ev.detail, ev.barcode);
      break;
    case 'open':
      await q(`UPDATE stock_items SET opened_at = NULL WHERE id = ANY($1::bigint[])`, [ev.item_ids]);
      for (const m of (ev.detail?.moved ?? []) as { id: number; from: number }[]) await q('UPDATE stock_items SET location_id = $2 WHERE id = $1', [m.id, m.from]);
      break;
    case 'shop': {
      const d = ev.detail ?? {};
      if (d.created) await q('DELETE FROM shopping_items WHERE id = $1', [d.shopping_id]);
      else await q('UPDATE shopping_items SET qty = GREATEST(1, qty - $2) WHERE id = $1', [d.shopping_id, d.qty ?? 1]);
      break;
    }
  }
  await q('UPDATE events SET undone = true WHERE id = $1', [ev.id]);
  bus.emit('change', { what: 'stock' });
  return { ok: true, message: `Rückgängig: ${ev.kind}` };
}

/** Applies a best-before date to the item(s) of the most recent add, if that was the last action. */
async function applyDateToLastAdd(date: string, mode: Mode): Promise<{ ok: boolean; message: string }> {
  if (mode !== 'add') return { ok: false, message: `MHD ${date} verworfen: nur im Modus Einlagern möglich` };
  const ev = await q1<{ id: number; barcode: string; item_ids: number[]; ts: string; kind: string }>(
    'SELECT * FROM events WHERE NOT undone ORDER BY id DESC LIMIT 1',
  );
  const fresh = ev && Date.now() - new Date(ev.ts).getTime() < (await getSettings()).pending_minutes * 60000;
  if (!ev || ev.kind !== 'add' || !fresh) {
    return { ok: false, message: `MHD ${date} verworfen: erst ein Produkt einlagern, dann das MHD scannen` };
  }
  await q(`UPDATE stock_items SET best_before = $2::date WHERE id = ANY($1::bigint[]) AND status = 'in_stock'`, [ev.item_ids, date]);
  await q(`UPDATE events SET detail = detail || $2::jsonb WHERE id = $1`, [ev.id, JSON.stringify({ best_before: date })]);
  const p = await getProduct(ev.barcode);
  bus.emit('change', { what: 'stock' });
  const n = ev.item_ids.length > 1 ? ` (${ev.item_ids.length}×)` : '';
  return { ok: true, message: `MHD ${date} für ${p ? productLabel(p) : ev.barcode}${n}` };
}

// ---------------------------------------------------------------- default storage location

export async function locationForKind(kind: string): Promise<number | null> {
  return (await q1<{ id: number }>('SELECT id FROM locations WHERE kind = $1 ORDER BY id LIMIT 1', [kind]))?.id ?? null;
}

/** Sets the default location and move-on-open flag from the product's category/storage data (only while not set by hand). */
export async function applyDerivedDefaults(p: Product): Promise<Product> {
  if (!p.auto_defaults) return p;
  const d = deriveStorage({ tags: p.categories_tags, conservation: p.conservation, source: p.source });
  const loc = d.kind ? await locationForKind(d.kind) : null;
  return (await q1<Product>('UPDATE products SET location_id = $2, move_on_open = $3 WHERE barcode = $1 RETURNING *', [p.barcode, loc, d.moveOnOpen])) ?? p;
}

/**
 * Packs that were in a pantry-type location are moved to the fridge when they are opened
 * (unless the product opted out). Returns what moved so it can be undone.
 */
export async function relocateOnOpen(ids: number[]): Promise<{ moved: { id: number; from: number }[]; to: string | null }> {
  if (!ids.length) return { moved: [], to: null };
  const fridge = await q1<{ id: number; name: string }>(`SELECT id, name FROM locations WHERE kind = 'fridge' ORDER BY id LIMIT 1`);
  if (!fridge) return { moved: [], to: null };
  const rows = await q<{ id: number; from_loc: number }>(
    `WITH cand AS (
       SELECT s.id, s.location_id AS from_loc FROM stock_items s
       JOIN locations l ON l.id = s.location_id JOIN products p ON p.barcode = s.barcode
       WHERE s.id = ANY($1::bigint[]) AND l.kind = 'pantry' AND p.move_on_open)
     UPDATE stock_items s SET location_id = $2 FROM cand WHERE s.id = cand.id RETURNING s.id, cand.from_loc`,
    [ids, fridge.id],
  );
  if (rows.length) bus.emit('change', { what: 'stock' });
  return { moved: rows.map((r) => ({ id: r.id, from: r.from_loc })), to: rows.length ? fridge.name : null };
}

/** One-off for products stored before categories were kept: fetch them again and derive the defaults (no stock is moved). */
export async function backfillClassification(log: (m: string) => void): Promise<void> {
  const todo = await q<{ barcode: string }>(`SELECT barcode FROM products WHERE off_found IS TRUE AND categories_tags IS NULL ORDER BY barcode`);
  if (!todo.length) return;
  log(`classifying ${todo.length} products (storage location) ...`);
  for (const { barcode } of todo) {
    const off = await fetchOff(barcode);
    if (off.status === 'found') {
      const row = await q1<Product>('UPDATE products SET categories_tags = $2, conservation = $3 WHERE barcode = $1 RETURNING *', [barcode, off.product.categories_tags, off.product.conservation]);
      if (row) await applyDerivedDefaults(row);
    } else if (off.status === 'not_found') {
      await q('UPDATE products SET categories_tags = $2 WHERE barcode = $1', [barcode, []]); // do not ask again
    }
    await new Promise((r) => setTimeout(r, 500)); // be polite to the free API
  }
  log('classification done');
}

// ---------------------------------------------------------------- local image cache

/**
 * Makes products.image_url point to the locally cached copy (/img/<file>). The remote URL is kept in
 * image_source_url so a changed image is noticed and a cleared cache can be undone.
 */
export async function localizeImage(p: Product): Promise<Product> {
  if (!(await getSettings()).cache_images) return p;
  const url = p.image_url;
  if (!url || !/^https?:\/\//i.test(url)) return p; // none, or already local
  if (p.image_source_url === url && hasImageFile(p.image_file)) {
    return (await q1<Product>('UPDATE products SET image_url = $2 WHERE barcode = $1 RETURNING *', [p.barcode, localUrl(p.image_file!, url)])) ?? p;
  }
  const file = await downloadImage(p.barcode, url);
  if (!file) return p; // keep the remote URL; tried again on the next lookup / maintenance run
  const row = await q1<Product>(
    'UPDATE products SET image_source_url = $2, image_file = $3, image_url = $4 WHERE barcode = $1 RETURNING *',
    [p.barcode, url, file, localUrl(file, url)],
  );
  bus.emit('change', { what: 'products' });
  return row ?? p;
}

/**
 * Caches all images that still point to a remote server, and repairs products whose local file is missing
 * (e.g. after the database was restored on a new server without the images volume).
 */
export async function backfillImages(log: (m: string) => void = () => undefined): Promise<{ tried: number; cached: number }> {
  const rows = await q<Product>(`SELECT * FROM products WHERE image_url ~* '^https?://' OR image_file IS NOT NULL ORDER BY barcode`);
  const todo: Product[] = [];
  for (const p of rows) {
    if (p.image_file && !hasImageFile(p.image_file)) {
      if (!p.image_source_url) continue; // nothing to fetch it from
      const fixed = await q1<Product>('UPDATE products SET image_url = image_source_url, image_file = NULL WHERE barcode = $1 RETURNING *', [p.barcode]);
      if (fixed) todo.push(fixed);
    } else if (p.image_url && /^https?:\/\//i.test(p.image_url)) {
      todo.push(p);
    }
  }
  let cached = 0;
  if (todo.length) log(`caching ${todo.length} product images locally ...`);
  for (const p of todo) {
    const after = await localizeImage(p);
    if (after.image_url?.startsWith('/img/')) cached++;
    await new Promise((r) => setTimeout(r, 250)); // be polite to the free servers
  }
  if (todo.length) log(`images cached: ${cached}/${todo.length}`);
  return { tried: todo.length, cached };
}
