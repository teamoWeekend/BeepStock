import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { config } from './config.js';
import { db, syncIdSequence, type Tx } from './db.js';
import { appState, events, inventoryCounts, inventorySessions, locations, products, settings, shoppingItems, stockItems, stores } from './schema.js';
import { nextStoreSort } from './service.js';
import { invalidateSettingsCache, getSettings, sanitizeSettings } from './settings.js';
import type { Kind } from './storage.js';

/**
 * Data backup: export (JSON) and import.
 *  - replace: the current data is replaced by the file (everything in one transaction; an automatic backup of the
 *    current data is written first)
 *  - merge:   only master data (storage locations, stores, products) that is missing is added; stock is untouched
 * The file is validated and normalised before anything is written; a dry run reports what would happen.
 */

export const FORMAT = 1;
export class BackupError extends Error {}

// ---------------------------------------------------------------- export

export async function buildExport() {
  return {
    app: 'Beepstock',
    format: FORMAT,
    exported_at: new Date().toISOString(),
    settings: await getSettings(),
    locations: await db.select().from(locations).orderBy(locations.id),
    stores: await db.select().from(stores).orderBy(stores.id),
    products: await db.select().from(products).orderBy(products.barcode),
    stock_items: await db.select().from(stockItems).orderBy(stockItems.id),
    shopping_items: await db.select().from(shoppingItems).orderBy(shoppingItems.id),
  };
}

// ---------------------------------------------------------------- column specs and coercion

type T = 'text' | 'int' | 'bool' | 'ts' | 'date' | 'json' | 'tags';
interface Col {
  name: string;
  type: T;
  req?: boolean;
  max?: number; // text length / int max
  min?: number;
  oneOf?: string[];
  def?: unknown;
}

const LOCATION: Col[] = [
  { name: 'id', type: 'int', req: true, min: 1, max: 2147483647 },
  { name: 'name', type: 'text', req: true, max: 60 },
  { name: 'kind', type: 'text', oneOf: ['fridge', 'freezer', 'pantry', 'other'], def: 'other' },
];
const STORE: Col[] = [
  { name: 'id', type: 'int', req: true, min: 1, max: 2147483647 },
  { name: 'name', type: 'text', req: true, max: 60 },
  { name: 'sort', type: 'int', min: -1000000, max: 1000000, def: 0 },
];
const PRODUCT: Col[] = [
  { name: 'barcode', type: 'text', req: true, max: 40 },
  { name: 'name', type: 'text', req: true, max: 300 },
  { name: 'brand', type: 'text', max: 200 },
  { name: 'quantity_text', type: 'text', max: 100 },
  { name: 'categories', type: 'text', max: 2000 },
  { name: 'image_url', type: 'text', max: 600 },
  { name: 'nutriscore', type: 'text', max: 2 },
  { name: 'nova_group', type: 'int', min: 0, max: 10 },
  { name: 'ecoscore', type: 'text', max: 2 },
  { name: 'nutriments', type: 'json' },
  { name: 'ingredients', type: 'text', max: 5000 },
  { name: 'allergens', type: 'text', max: 500 },
  { name: 'serving_size', type: 'text', max: 100 },
  { name: 'off_found', type: 'bool' },
  { name: 'off_fetched_at', type: 'ts' },
  { name: 'shelf_life_days', type: 'int', min: 1, max: 36500 },
  { name: 'days_after_opening', type: 'int', min: 1, max: 3650 },
  { name: 'min_stock', type: 'int', min: 0, max: 99, def: 0 },
  { name: 'created_at', type: 'ts' },
  { name: 'store_id', type: 'int', min: 1, max: 2147483647 },
  { name: 'source', type: 'text', max: 10 },
  { name: 'image_source_url', type: 'text', max: 600 },
  { name: 'categories_tags', type: 'tags' },
  { name: 'conservation', type: 'text', max: 1000 },
  { name: 'location_id', type: 'int', min: 1, max: 2147483647 },
  { name: 'auto_defaults', type: 'bool', def: true },
  { name: 'move_on_open', type: 'bool', def: true },
];
const STOCK: Col[] = [
  { name: 'id', type: 'int', req: true, min: 1, max: Number.MAX_SAFE_INTEGER },
  { name: 'barcode', type: 'text', req: true, max: 40 },
  { name: 'best_before', type: 'date' },
  { name: 'opened_at', type: 'ts' },
  { name: 'added_at', type: 'ts' },
  { name: 'status', type: 'text', oneOf: ['in_stock', 'consumed', 'wasted', 'adjusted'], def: 'in_stock' },
  { name: 'finished_at', type: 'ts' },
  { name: 'waste_reason', type: 'text', max: 200 },
  { name: 'location_id', type: 'int', min: 1, max: 2147483647 },
];
const SHOPPING: Col[] = [
  { name: 'id', type: 'int', req: true, min: 1, max: Number.MAX_SAFE_INTEGER },
  { name: 'barcode', type: 'text', max: 40 },
  { name: 'name', type: 'text', req: true, max: 300 },
  { name: 'qty', type: 'int', min: 1, max: 99, def: 1 },
  { name: 'done', type: 'bool', def: false },
  { name: 'source', type: 'text', max: 20, def: 'manual' },
  { name: 'created_at', type: 'ts' },
  { name: 'done_at', type: 'ts' },
  { name: 'store_id', type: 'int', min: 1, max: 2147483647 },
];

type Row = Record<string, unknown>;
const MAX_ROWS = 200_000;

function coerce(v: unknown, c: Col, where: string): unknown {
  if (v === undefined || v === null || v === '') {
    if (c.req) throw new BackupError(`${where}: Feld „${c.name}“ fehlt`);
    return c.def ?? null;
  }
  switch (c.type) {
    case 'text': {
      if (typeof v !== 'string' && typeof v !== 'number') throw new BackupError(`${where}: „${c.name}“ muss Text sein`);
      let s = String(v);
      if (c.max && s.length > c.max) s = s.slice(0, c.max);
      if (c.oneOf && !c.oneOf.includes(s)) {
        if (c.req) throw new BackupError(`${where}: „${c.name}“ hat den unbekannten Wert „${s}“`);
        return c.def ?? null;
      }
      return s;
    }
    case 'int': {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n) || (c.min !== undefined && n < c.min) || (c.max !== undefined && n > c.max)) {
        if (c.req) throw new BackupError(`${where}: „${c.name}“ ist keine gültige Zahl`);
        return c.def ?? null;
      }
      return n;
    }
    case 'bool': return typeof v === 'boolean' ? v : v === 'true' || v === 1;
    case 'ts': {
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? c.def ?? null : d.toISOString();
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
      if (!m) return null;
      const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
      return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]! ? `${m[1]}-${m[2]}-${m[3]}` : null;
    }
    case 'json': {
      if (typeof v !== 'object' || Array.isArray(v)) return {};
      return JSON.stringify(v).length > 20000 ? {} : v;
    }
    case 'tags': {
      if (!Array.isArray(v)) return null;
      return v.filter((t) => typeof t === 'string').slice(0, 80).map((t) => (t as string).slice(0, 100));
    }
  }
}

function table(raw: unknown, name: string, cols: Col[], warnings: string[]): Row[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BackupError(`„${name}“ muss eine Liste sein`);
  if (raw.length > MAX_ROWS) throw new BackupError(`„${name}“ hat zu viele Einträge (${raw.length})`);
  const out: Row[] = [];
  raw.forEach((r, i) => {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new BackupError(`${name}[${i}]: Objekt erwartet`);
    const row: Row = {};
    for (const c of cols) row[c.name] = coerce((r as Row)[c.name], c, `${name}[${i}]`);
    out.push(row);
  });
  if (raw.length !== out.length) warnings.push(`${name}: ${raw.length - out.length} Einträge übersprungen`);
  return out;
}

export interface Normalized {
  locations: Row[];
  stores: Row[];
  products: Row[];
  stock_items: Row[];
  shopping_items: Row[];
  settings: Record<string, unknown>;
  warnings: string[];
}

/** Validates and cleans a backup file. Throws BackupError for files that must not be imported at all. */
export function normalizeBackup(raw: unknown): Normalized {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BackupError('Das ist keine Beepstock-Datensicherung (JSON-Objekt erwartet)');
  const f = raw as Row;
  if (f.app !== 'Beepstock' && f.app !== 'PantryScan') throw new BackupError('Das ist keine Beepstock-Datensicherung (Feld „app“ fehlt)');
  if (f.format !== undefined && f.format !== FORMAT) throw new BackupError(`Unbekanntes Sicherungsformat ${String(f.format)}`);
  const warnings: string[] = [];

  const locations = table(f.locations, 'locations', LOCATION, warnings);
  const stores = table(f.stores, 'stores', STORE, warnings);
  const products = table(f.products, 'products', PRODUCT, warnings);
  const stock = table(f.stock_items, 'stock_items', STOCK, warnings);
  const shopping = table(f.shopping_items, 'shopping_items', SHOPPING, warnings);

  const dedupe = (rows: Row[], key: string, label: string) => {
    const seen = new Set<unknown>();
    const out = rows.filter((r) => (seen.has(r[key]) ? false : (seen.add(r[key]), true)));
    if (out.length !== rows.length) warnings.push(`${label}: ${rows.length - out.length} doppelte Einträge ignoriert`);
    return out;
  };
  const locs = dedupe(locations, 'id', 'Lagerorte');
  const sts = dedupe(stores, 'id', 'Läden');
  const prods = dedupe(products, 'barcode', 'Produkte');
  const locIds = new Set(locs.map((l) => l.id));
  const storeIds = new Set(sts.map((s) => s.id));
  const barcodes = new Set(prods.map((p) => p.barcode));

  let fixed = 0;
  for (const p of prods) {
    if (p.location_id !== null && !locIds.has(p.location_id)) { p.location_id = null; fixed++; }
    if (p.store_id !== null && !storeIds.has(p.store_id)) { p.store_id = null; fixed++; }
    // locally cached images are not part of the file: fall back to the original address, the cache job fetches it again
    const url = typeof p.image_url === 'string' ? p.image_url : null;
    if (url && url.startsWith('/img/')) p.image_url = typeof p.image_source_url === 'string' && /^https?:/.test(p.image_source_url) ? p.image_source_url : null;
    p.image_source_url = null;
  }
  if (fixed) warnings.push(`${fixed} Verweise auf nicht vorhandene Lagerorte/Läden entfernt`);

  const stockRows = dedupe(stock, 'id', 'Packungen').filter((s) => barcodes.has(s.barcode));
  if (stockRows.length !== dedupe(stock, 'id', 'Packungen').length) warnings.push('Packungen ohne zugehöriges Produkt übersprungen');
  for (const s of stockRows) if (s.location_id !== null && !locIds.has(s.location_id)) s.location_id = null;

  const shopRows = dedupe(shopping, 'id', 'Einkaufsliste');
  for (const s of shopRows) {
    if (s.barcode !== null && !barcodes.has(s.barcode)) s.barcode = null;
    if (s.store_id !== null && !storeIds.has(s.store_id)) s.store_id = null;
  }

  const st = sanitizeSettings(f.settings);
  warnings.push(...st.warnings);
  return { locations: locs, stores: sts, products: prods, stock_items: stockRows, shopping_items: shopRows, settings: st.values, warnings };
}

// ---------------------------------------------------------------- database

/**
 * Writes validated rows (keys = column names); timestamps arrive as ISO text. In chunks, as PostgreSQL takes at most
 * 65535 values per statement.
 */
async function insertRows<TTable extends PgTable>(tx: Tx, table: TTable, cols: Col[], rows: Row[]): Promise<void> {
  const values = rows.map((r) => {
    const v: Row = {};
    for (const c of cols) v[c.name] = c.type === 'ts' && r[c.name] != null ? new Date(r[c.name] as string) : r[c.name];
    return v as TTable['$inferInsert'];
  });
  for (let i = 0; i < values.length; i += 500) await tx.insert(table).values(values.slice(i, i + 500));
}

async function counts(): Promise<Record<string, number>> {
  return {
    locations: await db.$count(locations),
    stores: await db.$count(stores),
    products: await db.$count(products),
    stock_items: await db.$count(stockItems),
    shopping_items: await db.$count(shoppingItems),
  };
}

/** Maps the file's ids to an existing row of the same name (any case) or to a newly inserted one. */
async function mapByName(
  existing: { id: number; name: string }[],
  rows: Row[],
  insert: (r: Row) => Promise<number>,
): Promise<{ ids: Map<unknown, number>; added: number }> {
  const byName = new Map<string, number>();
  for (const e of existing) if (!byName.has(e.name.toLowerCase())) byName.set(e.name.toLowerCase(), e.id);
  const ids = new Map<unknown, number>();
  let added = 0;
  for (const r of rows) {
    const key = String(r.name).toLowerCase();
    let id = byName.get(key);
    if (id === undefined) {
      id = await insert(r);
      byName.set(key, id);
      added++;
    }
    ids.set(r.id, id);
  }
  return { ids, added };
}

export interface ImportResult {
  mode: 'replace' | 'merge';
  dry_run: boolean;
  file: Record<string, number>;
  current: Record<string, number>;
  result: Record<string, number>;
  warnings: string[];
  backup_file: string | null;
}

export async function importBackup(raw: unknown, mode: 'replace' | 'merge', dryRun: boolean): Promise<ImportResult> {
  const n = normalizeBackup(raw);
  const file = { locations: n.locations.length, stores: n.stores.length, products: n.products.length, stock_items: n.stock_items.length, shopping_items: n.shopping_items.length };
  const current = await counts();
  const out: ImportResult = { mode, dry_run: dryRun, file, current, result: {}, warnings: n.warnings, backup_file: null };

  if (mode === 'replace') {
    if (!n.products.length && !n.locations.length && !n.stock_items.length) throw new BackupError('Die Sicherung enthält keine Daten. Zum Schutz wird nichts ersetzt.');
    out.result = { ...file };
    if (dryRun) return out;
    out.backup_file = await writeSafetyBackup();
    await db.transaction(async (tx) => {
      for (const t of [inventoryCounts, inventorySessions, events, shoppingItems, stockItems, products, stores, locations, settings]) await tx.delete(t);
      await insertRows(tx, locations, LOCATION, n.locations);
      await insertRows(tx, stores, STORE, n.stores);
      await insertRows(tx, products, PRODUCT, n.products);
      await insertRows(tx, stockItems, STOCK, n.stock_items);
      await insertRows(tx, shoppingItems, SHOPPING, n.shopping_items);
      for (const t of [locations, stores, stockItems, shoppingItems]) await syncIdSequence(tx, t);
      for (const [key, value] of Object.entries(n.settings)) await tx.insert(settings).values({ key, value });
      const [fridge] = await tx.select({ id: locations.id }).from(locations).where(eq(locations.kind, 'fridge')).orderBy(locations.id).limit(1);
      await tx.update(appState).set({ location_id: fridge?.id ?? null, pending_qty: null, digits: '' });
    });
    invalidateSettingsCache();
    return out;
  }

  // merge: add only what is missing, match locations and stores by name
  const stats = { locations_added: 0, stores_added: 0, products_added: 0, products_skipped: 0 };
  out.result = stats;
  if (dryRun) {
    const lower = (rows: { name: string }[]) => new Set(rows.map((r) => r.name.toLowerCase()));
    const ln = lower(await db.select({ name: locations.name }).from(locations));
    const sn = lower(await db.select({ name: stores.name }).from(stores));
    const have = new Set((await db.select({ barcode: products.barcode }).from(products)).map((r) => r.barcode));
    stats.locations_added = n.locations.filter((l) => !ln.has(String(l.name).toLowerCase())).length;
    stats.stores_added = n.stores.filter((s) => !sn.has(String(s.name).toLowerCase())).length;
    stats.products_added = n.products.filter((p) => !have.has(p.barcode as string)).length;
    stats.products_skipped = n.products.length - stats.products_added;
    return out;
  }
  out.backup_file = await writeSafetyBackup();
  await db.transaction(async (tx) => {
    const locs = await mapByName(await tx.select({ id: locations.id, name: locations.name }).from(locations), n.locations, async (r) => {
      const [row] = await tx.insert(locations).values({ name: r.name as string, kind: r.kind as Kind }).returning({ id: locations.id });
      return row!.id;
    });
    const sts = await mapByName(await tx.select({ id: stores.id, name: stores.name }).from(stores), n.stores, async (r) => {
      const [row] = await tx.insert(stores).values({ name: r.name as string, sort: await nextStoreSort(tx) }).returning({ id: stores.id });
      return row!.id;
    });
    stats.locations_added = locs.added;
    stats.stores_added = sts.added;
    const have = new Set((await tx.select({ barcode: products.barcode }).from(products)).map((r) => r.barcode));
    const add: Row[] = [];
    for (const p of n.products) {
      if (have.has(p.barcode as string)) { stats.products_skipped++; continue; }
      add.push({ ...p, location_id: p.location_id === null ? null : locs.ids.get(p.location_id) ?? null, store_id: p.store_id === null ? null : sts.ids.get(p.store_id) ?? null });
    }
    await insertRows(tx, products, PRODUCT, add);
    stats.products_added = add.length;
  });
  return out;
}

// ---------------------------------------------------------------- automatic safety backups

const SAFETY_RE = /^(beepstock|pantryscan)-before-import-\d{8}T\d{6}Z\.json$/;
const KEEP = 5;

export async function writeSafetyBackup(): Promise<string> {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const name = `beepstock-before-import-${stamp}.json`;
  fs.writeFileSync(path.join(config.backupDir, name), JSON.stringify(await buildExport()));
  const all = fs.readdirSync(config.backupDir).filter((f) => SAFETY_RE.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(config.backupDir, old), { force: true });
  return name;
}

export function listSafetyBackups(): { name: string; size: number; modified: string }[] {
  try {
    return fs.readdirSync(config.backupDir).filter((f) => SAFETY_RE.test(f)).sort().reverse().map((name) => {
      const st = fs.statSync(path.join(config.backupDir, name));
      return { name, size: st.size, modified: st.mtime.toISOString() };
    });
  } catch {
    return [];
  }
}

export const safetyBackupPath = (name: string): string | null => (SAFETY_RE.test(name) && fs.existsSync(path.join(config.backupDir, name)) ? path.join(config.backupDir, name) : null);
