import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { config } from './config.js';
import { q, withTx } from './db.js';
import { invalidateSettingsCache, getSettings, sanitizeSettings } from './settings.js';

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
    locations: await q('SELECT * FROM locations ORDER BY id'),
    stores: await q('SELECT * FROM stores ORDER BY id'),
    products: await q('SELECT * FROM products ORDER BY barcode'),
    stock_items: await q('SELECT * FROM stock_items ORDER BY id'),
    shopping_items: await q('SELECT * FROM shopping_items ORDER BY id'),
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
      if (typeof v !== 'object' || Array.isArray(v)) return '{}';
      const s = JSON.stringify(v);
      return s.length > 20000 ? '{}' : s;
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

const PG_CAST: Record<T, string> = { text: '', int: '', bool: '', ts: '::timestamptz', date: '::date', json: '::jsonb', tags: '::text[]' };

async function insertRows(c: pg.PoolClient, tableName: string, cols: Col[], rows: Row[], skip: string[] = []): Promise<void> {
  const use = cols.filter((x) => !skip.includes(x.name));
  const sql = `INSERT INTO ${tableName} (${use.map((x) => x.name).join(', ')}) VALUES (${use.map((x, i) => `$${i + 1}${PG_CAST[x.type]}`).join(', ')})`;
  for (const r of rows) await c.query(sql, use.map((x) => r[x.name]));
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ['locations', 'stores', 'products', 'stock_items', 'shopping_items']) {
    out[t] = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${t}`))[0]?.n ?? 0);
  }
  return out;
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
    await withTx(async (c) => {
      for (const t of ['inventory_counts', 'inventory_sessions', 'events', 'shopping_items', 'stock_items', 'products', 'stores', 'locations', 'settings']) await c.query(`DELETE FROM ${t}`);
      await insertRows(c, 'locations', LOCATION, n.locations);
      await insertRows(c, 'stores', STORE, n.stores);
      await insertRows(c, 'products', PRODUCT, n.products);
      await insertRows(c, 'stock_items', STOCK, n.stock_items);
      await insertRows(c, 'shopping_items', SHOPPING, n.shopping_items);
      for (const t of ['locations', 'stores', 'stock_items', 'shopping_items']) {
        await c.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM ${t}), 1), (SELECT count(*) > 0 FROM ${t}))`);
      }
      for (const [k, v] of Object.entries(n.settings)) await c.query(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)`, [k, JSON.stringify(v)]);
      await c.query(`UPDATE app_state SET location_id = (SELECT id FROM locations WHERE kind = 'fridge' ORDER BY id LIMIT 1), pending_qty = NULL, digits = ''`);
    });
    invalidateSettingsCache();
    return out;
  }

  // merge: add only what is missing, match locations and stores by name
  const stats = { locations_added: 0, stores_added: 0, products_added: 0, products_skipped: 0 };
  out.result = stats;
  if (dryRun) {
    const names = async (t: string) => new Set((await q<{ name: string }>(`SELECT lower(name) AS name FROM ${t}`)).map((r) => r.name));
    const [ln, sn] = [await names('locations'), await names('stores')];
    const have = new Set((await q<{ barcode: string }>('SELECT barcode FROM products')).map((r) => r.barcode));
    stats.locations_added = n.locations.filter((l) => !ln.has(String(l.name).toLowerCase())).length;
    stats.stores_added = n.stores.filter((s) => !sn.has(String(s.name).toLowerCase())).length;
    stats.products_added = n.products.filter((p) => !have.has(p.barcode as string)).length;
    stats.products_skipped = n.products.length - stats.products_added;
    return out;
  }
  out.backup_file = await writeSafetyBackup();
  await withTx(async (c) => {
    const mapIds = async (tbl: 'locations' | 'stores', rows: Row[], extra: (r: Row) => unknown[], insertSql: string, counter: 'locations_added' | 'stores_added') => {
      const map = new Map<unknown, number>();
      for (const r of rows) {
        const found = await c.query(`SELECT id FROM ${tbl} WHERE lower(name) = lower($1) LIMIT 1`, [r.name]);
        if (found.rows[0]) { map.set(r.id, found.rows[0].id); continue; }
        const ins = await c.query(insertSql, [r.name, ...extra(r)]);
        map.set(r.id, ins.rows[0].id);
        stats[counter]++;
      }
      return map;
    };
    const locMap = await mapIds('locations', n.locations, (r) => [r.kind], 'INSERT INTO locations (name, kind) VALUES ($1, $2) RETURNING id', 'locations_added');
    const storeMap = await mapIds('stores', n.stores, () => [], `INSERT INTO stores (name, sort) VALUES ($1, COALESCE((SELECT max(sort) + 1 FROM stores), 1)) RETURNING id`, 'stores_added');
    for (const p of n.products) {
      const exists = await c.query('SELECT 1 FROM products WHERE barcode = $1', [p.barcode]);
      if (exists.rows[0]) { stats.products_skipped++; continue; }
      const row = { ...p, location_id: p.location_id === null ? null : locMap.get(p.location_id) ?? null, store_id: p.store_id === null ? null : storeMap.get(p.store_id) ?? null };
      await insertRows(c, 'products', PRODUCT, [row]);
      stats.products_added++;
    }
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
