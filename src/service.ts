import { EventEmitter } from 'node:events';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, max, or } from 'drizzle-orm';
import { config } from './config.js';
import { MODES, type Mode, normalizeBarcode, parseControl, resolveDigits } from './control.js';
import { addDays, today } from './dates.js';
import { db, type Tx } from './db.js';
import { greatest, plus } from './expressions.js';
import { countScan, undoCount } from './inventory.js';
import { fetchOff } from './off.js';
import { downloadImage, hasImageFile, localUrl } from './images.js';
import { getSettings } from './settings.js';
import { appState, events, locations, type Product, products, shoppingItems, stockItems, stores } from './schema.js';
import { deriveStorage, type Kind } from './storage.js';

export const bus = new EventEmitter();

export interface AppState {
  mode: Mode;
  location_id: number | null;
  location_name: string | null;
  pending_qty: number | null;
  digits: string;
  updated_at: Date;
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
  const [s] = await db
    .select({
      mode: appState.mode,
      location_id: appState.location_id,
      location_name: locations.name,
      pending_qty: appState.pending_qty,
      digits: appState.digits,
      updated_at: appState.updated_at,
    })
    .from(appState)
    .leftJoin(locations, eq(locations.id, appState.location_id))
    .where(eq(appState.id, 1));
  return s!;
}

type StatePatch = Partial<Pick<AppState, 'mode' | 'location_id' | 'pending_qty' | 'digits'>>;

export async function saveState(patch: StatePatch, touch = true): Promise<AppState> {
  await db.update(appState).set(touch ? { ...patch, updated_at: new Date() } : patch).where(eq(appState.id, 1));
  return selectState();
}

export async function setLocation(id: number | null): Promise<AppState> {
  const s = await saveState({ location_id: id });
  bus.emit('state', s);
  return s;
}

export const listLocations = () => db.select({ id: locations.id, name: locations.name, kind: locations.kind }).from(locations).orderBy(locations.id);

export async function getLocation(id: number): Promise<{ id: number; name: string } | undefined> {
  const [l] = await db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.id, id));
  return l;
}

export async function setMode(mode: Mode): Promise<AppState> {
  const s = await saveState({ mode });
  bus.emit('state', s);
  return s;
}

// ---------------------------------------------------------------- products

export async function getProduct(barcode: string): Promise<Product | undefined> {
  const [p] = await db.select().from(products).where(eq(products.barcode, barcode));
  return p;
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
    const fromOff = {
      name: p.name, brand: p.brand, quantity_text: p.quantity_text, categories: p.categories, image_url: p.image_url,
      nutriscore: p.nutriscore, nova_group: p.nova_group, ecoscore: p.ecoscore, nutriments: p.nutriments, ingredients: p.ingredients,
      allergens: p.allergens, serving_size: p.serving_size, off_found: true, off_fetched_at: new Date(), source: p.source,
      categories_tags: p.categories_tags, conservation: p.conservation,
    };
    [product] = await db
      .insert(products)
      .values({ barcode, ...fromOff })
      // a name found online before is kept unless the refresh was asked for
      .onConflictDoUpdate({ target: products.barcode, set: { ...fromOff, name: product?.off_found === true && !force ? product.name : p.name } })
      .returning();
    product = await applyDerivedDefaults(product!); // default storage location + move-on-open, unless set by hand
    void localizeImage(product).catch(() => undefined); // keep a local copy; the scan itself does not wait for the download
    return { product };
  }

  const offError = off.status === 'error' ? off.error : undefined;
  const notFound = off.status === 'not_found';
  if (!product) {
    [product] = await db
      .insert(products)
      .values({ barcode, name: `Unbekannt ${barcode}`, off_found: notFound ? false : null, off_fetched_at: new Date() })
      .onConflictDoUpdate({ target: products.barcode, set: { off_fetched_at: new Date() } })
      .returning();
  } else {
    [product] = await db
      .update(products)
      .set({ off_fetched_at: new Date(), ...(notFound ? { off_found: false } : {}) })
      .where(eq(products.barcode, barcode))
      .returning();
  }
  return { product: product!, offError };
}

const isPlaceholder = (p: Product) => p.off_found !== true && p.name === `Unbekannt ${p.barcode}`;

// ---------------------------------------------------------------- stock operations

/** Which packs go first: opened ones, then the earliest best-before date (none = last), then the oldest. */
const BY_BEST_BEFORE = [isNull(stockItems.best_before), asc(stockItems.best_before), asc(stockItems.added_at), asc(stockItems.id)];
export const PICK_ORDER = [isNull(stockItems.opened_at), ...BY_BEST_BEFORE];

const inStock = (barcode: string) => and(eq(stockItems.barcode, barcode), eq(stockItems.status, 'in_stock'));
const openShoppingEntry = (barcode: string) => and(eq(shoppingItems.barcode, barcode), eq(shoppingItems.done, false));

export async function logEvent(kind: string, barcode: string | null, itemIds: number[], detail: Record<string, unknown> = {}): Promise<void> {
  await db.insert(events).values({ kind, barcode, item_ids: itemIds, detail });
}

export async function stockCount(barcode: string): Promise<number> {
  return db.$count(stockItems, inStock(barcode));
}

/** Adds packs of a product; returns their ids. */
export async function addStock(barcode: string, qty: number, bestBefore: string | null, locationId: number | null): Promise<number[]> {
  const rows = await db
    .insert(stockItems)
    .values(Array.from({ length: qty }, () => ({ barcode, best_before: bestBefore, location_id: locationId })))
    .returning({ id: stockItems.id });
  return rows.map((r) => r.id);
}

async function finishStock(barcode: string, qty: number, status: 'consumed' | 'wasted', reason: string | null): Promise<number[]> {
  const pick = db.select({ id: stockItems.id }).from(stockItems).where(inStock(barcode)).orderBy(...PICK_ORDER).limit(qty);
  const rows = await db
    .update(stockItems)
    .set({ status, finished_at: new Date(), waste_reason: reason })
    .where(inArray(stockItems.id, pick))
    .returning({ id: stockItems.id });
  return rows.map((r) => r.id);
}

async function openStock(barcode: string, qty: number): Promise<number[]> {
  const pick = db
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(and(inStock(barcode), isNull(stockItems.opened_at)))
    .orderBy(...BY_BEST_BEFORE)
    .limit(qty);
  const rows = await db.update(stockItems).set({ opened_at: new Date() }).where(inArray(stockItems.id, pick)).returning({ id: stockItems.id });
  return rows.map((r) => r.id);
}

/** Puts a product on the shopping list (or raises the qty of an open entry). */
export async function addToShopping(p: Product | null, name: string, qty: number, source: string): Promise<{ id: number; created: boolean }> {
  if (p) {
    const [existing] = await db.select({ id: shoppingItems.id }).from(shoppingItems).where(openShoppingEntry(p.barcode));
    if (existing) {
      await db.update(shoppingItems).set({ qty: plus(shoppingItems.qty, qty) }).where(eq(shoppingItems.id, existing.id));
      return { id: existing.id, created: false };
    }
  }
  const [row] = await db.insert(shoppingItems).values({ barcode: p?.barcode ?? null, name, qty, source }).returning({ id: shoppingItems.id });
  return { id: row!.id, created: true };
}

/** Auto restock: below the configured minimum stock -> shopping list. */
export async function restockCheck(p: Product): Promise<string | null> {
  if (p.min_stock <= 0) return null;
  const have = await stockCount(p.barcode);
  if (have >= p.min_stock) return null;
  if (await db.$count(shoppingItems, openShoppingEntry(p.barcode))) return null;
  await addToShopping(p, productLabel(p), p.min_stock - have, 'auto');
  return 'Einkaufsliste ergänzt';
}

/** Sort position for a new store: after the last one. */
export async function nextStoreSort(tx: Tx = db): Promise<number> {
  const [r] = await tx.select({ last: max(stores.sort) }).from(stores);
  return r?.last == null ? 1 : r.last + 1;
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
        const loc = await getLocation(ctl.id);
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
      const locName = useLoc ? (await getLocation(useLoc))?.name : null;
      const ids = await addStock(barcode, qty, bb, useLoc);
      await db.update(shoppingItems).set({ done: true, done_at: new Date() }).where(openShoppingEntry(barcode)); // bought
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

/** The most recent action that was not undone yet. */
async function lastEvent() {
  const [ev] = await db.select().from(events).where(eq(events.undone, false)).orderBy(desc(events.id)).limit(1);
  return ev;
}

export async function undoLast(): Promise<{ ok: boolean; message: string }> {
  const ev = await lastEvent();
  if (!ev) return { ok: false, message: 'Nichts zum Rückgängigmachen' };
  const packs = inArray(stockItems.id, ev.item_ids);
  switch (ev.kind) {
    case 'add':
      await db.delete(stockItems).where(packs);
      break;
    case 'consume':
    case 'waste':
    case 'adjust':
      await db.update(stockItems).set({ status: 'in_stock', finished_at: null, waste_reason: null }).where(packs);
      break;
    case 'count':
      await undoCount(ev.detail as { session: number; location: number; qty: number }, ev.barcode!);
      break;
    case 'open':
      await db.update(stockItems).set({ opened_at: null }).where(packs);
      for (const m of (ev.detail.moved ?? []) as { id: number; from: number }[]) {
        await db.update(stockItems).set({ location_id: m.from }).where(eq(stockItems.id, m.id));
      }
      break;
    case 'shop': {
      const d = ev.detail;
      if (d.created) await db.delete(shoppingItems).where(eq(shoppingItems.id, d.shopping_id));
      else await db.update(shoppingItems).set({ qty: greatest(1, plus(shoppingItems.qty, -(d.qty ?? 1))) }).where(eq(shoppingItems.id, d.shopping_id));
      break;
    }
  }
  await db.update(events).set({ undone: true }).where(eq(events.id, ev.id));
  bus.emit('change', { what: 'stock' });
  return { ok: true, message: `Rückgängig: ${ev.kind}` };
}

/** Applies a best-before date to the item(s) of the most recent add, if that was the last action. */
async function applyDateToLastAdd(date: string, mode: Mode): Promise<{ ok: boolean; message: string }> {
  if (mode !== 'add') return { ok: false, message: `MHD ${date} verworfen: nur im Modus Einlagern möglich` };
  const ev = await lastEvent();
  const fresh = ev && Date.now() - ev.ts.getTime() < (await getSettings()).pending_minutes * 60000;
  if (!ev || ev.kind !== 'add' || !fresh) {
    return { ok: false, message: `MHD ${date} verworfen: erst ein Produkt einlagern, dann das MHD scannen` };
  }
  await db.update(stockItems).set({ best_before: date }).where(and(inArray(stockItems.id, ev.item_ids), eq(stockItems.status, 'in_stock')));
  await db.update(events).set({ detail: { ...ev.detail, best_before: date } }).where(eq(events.id, ev.id));
  const p = ev.barcode ? await getProduct(ev.barcode) : undefined;
  bus.emit('change', { what: 'stock' });
  const n = ev.item_ids.length > 1 ? ` (${ev.item_ids.length}×)` : '';
  return { ok: true, message: `MHD ${date} für ${p ? productLabel(p) : ev.barcode}${n}` };
}

// ---------------------------------------------------------------- default storage location

/** The first storage location of a kind (fridge, freezer, pantry, other). */
export async function locationOfKind(kind: Kind): Promise<{ id: number; name: string } | undefined> {
  const [l] = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(eq(locations.kind, kind))
    .orderBy(locations.id)
    .limit(1);
  return l;
}

/** Sets the default location and move-on-open flag from the product's category/storage data (only while not set by hand). */
export async function applyDerivedDefaults(p: Product): Promise<Product> {
  if (!p.auto_defaults) return p;
  const d = deriveStorage({ tags: p.categories_tags, conservation: p.conservation, source: p.source });
  const loc = d.kind ? ((await locationOfKind(d.kind))?.id ?? null) : null;
  const [row] = await db.update(products).set({ location_id: loc, move_on_open: d.moveOnOpen }).where(eq(products.barcode, p.barcode)).returning();
  return row ?? p;
}

/**
 * Packs that were in a pantry-type location are moved to the fridge when they are opened
 * (unless the product opted out). Returns what moved so it can be undone.
 */
export async function relocateOnOpen(ids: number[]): Promise<{ moved: { id: number; from: number }[]; to: string | null }> {
  if (!ids.length) return { moved: [], to: null };
  const fridge = await locationOfKind('fridge');
  if (!fridge) return { moved: [], to: null };
  const moved = await db.transaction(async (tx) => {
    const packs = await tx
      .select({ id: stockItems.id, from: locations.id })
      .from(stockItems)
      .innerJoin(locations, eq(locations.id, stockItems.location_id))
      .innerJoin(products, eq(products.barcode, stockItems.barcode))
      .where(and(inArray(stockItems.id, ids), eq(locations.kind, 'pantry'), eq(products.move_on_open, true)));
    if (packs.length) await tx.update(stockItems).set({ location_id: fridge.id }).where(inArray(stockItems.id, packs.map((m) => m.id)));
    return packs;
  });
  if (moved.length) bus.emit('change', { what: 'stock' });
  return { moved, to: moved.length ? fridge.name : null };
}

/** One-off for products stored before categories were kept: fetch them again and derive the defaults (no stock is moved). */
export async function backfillClassification(log: (m: string) => void): Promise<void> {
  const todo = await db
    .select({ barcode: products.barcode })
    .from(products)
    .where(and(eq(products.off_found, true), isNull(products.categories_tags)))
    .orderBy(products.barcode);
  if (!todo.length) return;
  log(`classifying ${todo.length} products (storage location) ...`);
  for (const { barcode } of todo) {
    const off = await fetchOff(barcode);
    if (off.status === 'found') {
      const [row] = await db
        .update(products)
        .set({ categories_tags: off.product.categories_tags, conservation: off.product.conservation })
        .where(eq(products.barcode, barcode))
        .returning();
      if (row) await applyDerivedDefaults(row);
    } else if (off.status === 'not_found') {
      await db.update(products).set({ categories_tags: [] }).where(eq(products.barcode, barcode)); // do not ask again
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
    const [row] = await db.update(products).set({ image_url: localUrl(p.image_file!, url) }).where(eq(products.barcode, p.barcode)).returning();
    return row ?? p;
  }
  const file = await downloadImage(p.barcode, url);
  if (!file) return p; // keep the remote URL; tried again on the next lookup / maintenance run
  const [row] = await db
    .update(products)
    .set({ image_source_url: url, image_file: file, image_url: localUrl(file, url) })
    .where(eq(products.barcode, p.barcode))
    .returning();
  bus.emit('change', { what: 'products' });
  return row ?? p;
}

/**
 * Caches all images that still point to a remote server, and repairs products whose local file is missing
 * (e.g. after the database was restored on a new server without the images volume).
 */
export async function backfillImages(log: (m: string) => void = () => undefined): Promise<{ tried: number; cached: number }> {
  const rows = await db
    .select()
    .from(products)
    .where(or(ilike(products.image_url, 'http://%'), ilike(products.image_url, 'https://%'), isNotNull(products.image_file)))
    .orderBy(products.barcode);
  const todo: Product[] = [];
  for (const p of rows) {
    if (p.image_file && !hasImageFile(p.image_file)) {
      if (!p.image_source_url) continue; // nothing to fetch it from
      const [fixed] = await db.update(products).set({ image_url: p.image_source_url, image_file: null }).where(eq(products.barcode, p.barcode)).returning();
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
