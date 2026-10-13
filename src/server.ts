import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import fastifyWebsocket from '@fastify/websocket';
import { and, asc, count, desc, eq, getTableColumns, gt, ilike, inArray, isNotNull, isNull, lt, lte, min, ne, or } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { config } from './config.js';
import { controlSheet, MODES, type Mode } from './control.js';
import { addDays, today } from './dates.js';
import { db, migrate, ping, pool, SchemaError } from './db.js';
import { always, coalesce, countWhere, dateOf, distinctValues, expiresAt, joinedText, monthOf } from './expressions.js';
import { addScope, finishSession, openSession, removeScope, resolveAll, resolveRow, rows as inventoryRows, setCounted, startSession } from './inventory.js';
import { BackupError, buildExport, importBackup, listSafetyBackups, safetyBackupPath } from './backup.js';
import { clearImageFiles, contentTypeOf, FILE_RE, hasImageFile, imageFilePath, imageStats } from './images.js';
import { locations, products, shoppingItems, stockItems, stores } from './schema.js';
import { defaultSettings, getSettings, SOURCE_IDS, SOURCE_TITLES, updateSettings } from './settings.js';
import { guessKindFromName, KINDS, type Kind } from './storage.js';
import { loadOrCreateTls } from './tls.js';
import {
  addStock,
  addToShopping,
  applyDerivedDefaults,
  backfillClassification,
  backfillImages,
  bus,
  getLocation,
  getProduct,
  getState,
  handleScan,
  listLocations,
  logEvent,
  nextStoreSort,
  productLabel,
  relocateOnOpen,
  resolveProduct,
  restockCheck,
  setLocation,
  setMode,
  undoLast,
} from './service.js';

const root = path.resolve(import.meta.dirname, '..');
// The request handler is captured so the same app can also be served over HTTPS (see the end of this file).
let requestHandler: http.RequestListener | undefined;
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  serverFactory: (handler) => {
    requestHandler = handler;
    return http.createServer(handler);
  },
});

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Accept an empty body with content-type JSON (browsers/clients that always send the header, e.g. for undo or delete)
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, raw, done) => {
  const text = typeof raw === 'string' ? raw : raw.toString();
  if (!text.trim()) return done(null, {});
  try {
    done(null, JSON.parse(text));
  } catch {
    const err = new Error('Ungültiges JSON') as Error & { statusCode: number };
    err.statusCode = 400;
    done(err, undefined);
  }
});

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  const status = err instanceof HttpError ? err.status : (err.statusCode ?? 500);
  if (status >= 500) app.log.error(err);
  // our own HttpErrors carry a message meant for the user; unexpected errors are not leaked
  reply.status(status).send({ error: err instanceof HttpError || status < 500 ? err.message : 'Interner Fehler' });
});

// ---------------------------------------------------------------- auth (optional token)

function authorized(req: FastifyRequest): boolean {
  if (!config.apiToken) return true;
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const qt = (req.query as Record<string, string> | undefined)?.token;
  return bearer === config.apiToken || qt === config.apiToken;
}

app.addHook('onRequest', async (req, reply) => {
  const url = req.url;
  if ((url.startsWith('/api/') || url.startsWith('/ws')) && !authorized(req)) {
    return reply.status(401).send({ error: 'Token erforderlich' });
  }
});

await app.register(fastifyWebsocket);
await app.register(fastifyStatic, { root: path.join(root, 'public') });
await app.register(fastifyStatic, {
  root: path.join(root, 'node_modules', '@zxing', 'library', 'umd'),
  prefix: '/vendor/zxing/',
  decorateReply: false,
});
await app.register(fastifyStatic, {
  root: path.join(root, 'node_modules', 'jsbarcode', 'dist'),
  prefix: '/vendor/',
  decorateReply: false,
});

// ---------------------------------------------------------------- helpers

const int = (v: unknown, min: number, max: number, field: string): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} muss eine ganze Zahl zwischen ${min} und ${max} sein`);
  return n;
};
const nullableInt = (v: unknown, min: number, max: number, field: string): number | null =>
  v === null || v === '' ? null : int(v, min, max, field);
const str = (v: unknown, field: string, max = 200): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpError(400, `${field} fehlt oder ist zu lang`);
  return v.trim();
};
const dateStr = (v: unknown, field: string): string | null => {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `${field}: Format YYYY-MM-DD`);
  return v;
};
const body = (req: FastifyRequest): Record<string, any> => (req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {});
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000);

/** Packs with their product and storage location, as the stock list and the history show them. */
const selectStock = () =>
  db
    .select({
      id: stockItems.id,
      barcode: stockItems.barcode,
      best_before: stockItems.best_before,
      opened_at: stockItems.opened_at,
      added_at: stockItems.added_at,
      status: stockItems.status,
      finished_at: stockItems.finished_at,
      waste_reason: stockItems.waste_reason,
      expires: expiresAt(),
      location_id: stockItems.location_id,
      location_name: locations.name,
      name: products.name,
      brand: products.brand,
      quantity_text: products.quantity_text,
      image_url: products.image_url,
      nutriscore: products.nutriscore,
      min_stock: products.min_stock,
      days_after_opening: products.days_after_opening,
    })
    .from(stockItems)
    .innerJoin(products, eq(products.barcode, stockItems.barcode))
    .leftJoin(locations, eq(locations.id, stockItems.location_id));

// ---------------------------------------------------------------- scanning

app.post('/api/scan', async (req) => {
  const b = req.body;
  const code = typeof b === 'string' ? b : typeof (b as any)?.code === 'string' ? (b as any).code : '';
  return handleScan(code, (b as any)?.source ?? 'rest');
});

// GET variant for scanners/apps that can only fire a URL (e.g. /api/scan?code=...&token=...)
app.get('/api/scan', async (req) => handleScan(String((req.query as any)?.code ?? ''), 'rest-get'));

app.get('/api/state', async () => ({ state: await getState(), modes: MODES }));

app.post('/api/state/mode', async (req) => {
  const mode = body(req).mode as Mode;
  if (!MODES.includes(mode)) throw new HttpError(400, 'Unbekannter Modus');
  return { state: await setMode(mode) };
});

app.post('/api/undo', async () => undoLast());

app.get('/api/control-codes', async () => controlSheet(await listLocations()));

// ---------------------------------------------------------------- locations

app.get('/api/locations', async () => ({ locations: await listLocations() }));

app.post('/api/state/location', async (req) => {
  const id = body(req).location_id;
  if (id !== null && !(await getLocation(int(id, 1, 2147483647, 'location_id')))) throw new HttpError(404, 'Lagerort unbekannt');
  return { state: await setLocation(id) };
});

const locationFields = { id: locations.id, name: locations.name, kind: locations.kind };

app.post('/api/locations', async (req) => {
  const name = str(body(req).name, 'name', 60);
  const kind: Kind = KINDS.includes(body(req).kind) ? body(req).kind : guessKindFromName(name);
  try {
    const [row] = await db.insert(locations).values({ name, kind }).returning(locationFields);
    return row;
  } catch {
    throw new HttpError(409, 'Lagerort existiert bereits');
  }
});

app.patch('/api/locations/:id', async (req) => {
  const id = int((req.params as any).id, 1, 2147483647, 'id');
  try {
    const b = body(req);
    if (b.kind !== undefined && !KINDS.includes(b.kind)) throw new HttpError(400, 'kind: fridge, freezer, pantry oder other');
    const set: PgUpdateSetSource<typeof locations> = {};
    if (b.name !== undefined) set.name = str(b.name, 'name', 60);
    if (b.kind !== undefined) set.kind = b.kind;
    const [row] = Object.keys(set).length
      ? await db.update(locations).set(set).where(eq(locations.id, id)).returning(locationFields)
      : await db.select(locationFields).from(locations).where(eq(locations.id, id));
    if (!row) throw new HttpError(404, 'Nicht gefunden');
    bus.emit('state', await getState());
    return row;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(409, 'Lagerort existiert bereits');
  }
});

app.delete('/api/locations/:id', async (req) => {
  await db.delete(locations).where(eq(locations.id, int((req.params as any).id, 1, 2147483647, 'id')));
  bus.emit('state', await getState());
  bus.emit('change', { what: 'stock' });
  return { ok: true };
});

// ---------------------------------------------------------------- stock

app.get('/api/stock', async () => {
  const items = await selectStock()
    .where(eq(stockItems.status, 'in_stock'))
    .orderBy(asc(products.name), isNull(expiresAt()), asc(expiresAt()), asc(stockItems.id));
  return { items };
});

app.post('/api/stock', async (req) => {
  const b = body(req);
  const barcode = str(b.barcode, 'barcode', 32);
  const qty = int(b.qty ?? 1, 1, 99, 'qty');
  const bb = dateStr(b.best_before ?? null, 'best_before');
  const { product } = await resolveProduct(barcode);
  const loc = b.location_id == null ? (await getState()).location_id : int(b.location_id, 1, 2147483647, 'location_id');
  const ids = await addStock(product.barcode, qty, bb, loc);
  bus.emit('change', { what: 'stock' });
  return { added: ids.length };
});

app.patch('/api/stock/:id', async (req) => {
  const id = int((req.params as any).id, 1, Number.MAX_SAFE_INTEGER, 'id');
  const b = body(req);
  const set: PgUpdateSetSource<typeof stockItems> = {};
  if ('best_before' in b) set.best_before = dateStr(b.best_before, 'best_before');
  if ('location_id' in b) set.location_id = b.location_id === null ? null : int(b.location_id, 1, 2147483647, 'location_id');
  if ('opened' in b) set.opened_at = b.opened ? coalesce<Date>(stockItems.opened_at, new Date()) : null; // keeps an earlier opening date
  if (!Object.keys(set).length) throw new HttpError(400, 'Nichts zu ändern');
  const [row] = await db.update(stockItems).set(set).where(eq(stockItems.id, id)).returning({ id: stockItems.id });
  if (!row) throw new HttpError(404, 'Nicht gefunden');
  bus.emit('change', { what: 'stock' });
  return { ok: true };
});

app.post('/api/stock/:id/:action', async (req) => {
  const { id: rawId, action } = req.params as { id: string; action: string };
  const id = int(rawId, 1, Number.MAX_SAFE_INTEGER, 'id');
  if (action === 'consume' || action === 'waste') {
    const reason = typeof body(req).reason === 'string' ? body(req).reason.slice(0, 200) : null;
    const [row] = await db
      .update(stockItems)
      .set({ status: action === 'consume' ? 'consumed' : 'wasted', finished_at: new Date(), waste_reason: reason })
      .where(and(eq(stockItems.id, id), eq(stockItems.status, 'in_stock')))
      .returning({ barcode: stockItems.barcode });
    if (!row) throw new HttpError(404, 'Nicht im Vorrat');
    await logEvent(action, row.barcode, [id]);
    if (action === 'consume' || (await getSettings()).restock_on_waste) await restock(row.barcode);
  } else if (action === 'open') {
    const [row] = await db
      .update(stockItems)
      .set({ opened_at: new Date() })
      .where(and(eq(stockItems.id, id), eq(stockItems.status, 'in_stock')))
      .returning({ barcode: stockItems.barcode });
    if (!row) throw new HttpError(404, 'Nicht im Vorrat');
    const moved = await relocateOnOpen([id]); // pantry -> fridge
    await logEvent('open', row.barcode, [id], { moved: moved.moved });
    bus.emit('change', { what: 'stock' });
    return { ok: true, moved_to: moved.to };
  } else if (action === 'delete') {
    await db.delete(stockItems).where(eq(stockItems.id, id));
  } else {
    throw new HttpError(404, 'Unbekannte Aktion');
  }
  bus.emit('change', { what: 'stock' });
  return { ok: true };
});

async function restock(barcode: string): Promise<void> {
  const p = await getProduct(barcode);
  if (p) await restockCheck(p);
}

app.get('/api/history', async (req) => {
  const { status, limit } = req.query as Record<string, string>;
  const st = status === 'consumed' || status === 'wasted' ? status : null;
  const lim = Math.min(Math.max(parseInt(limit ?? '200', 10) || 200, 1), 1000);
  const items = await selectStock()
    .where(st ? eq(stockItems.status, st) : inArray(stockItems.status, ['consumed', 'wasted']))
    .orderBy(desc(stockItems.finished_at), desc(stockItems.id))
    .limit(lim);
  return { items };
});

app.get('/api/stats', async () => {
  const rows = await db
    .select({ status: stockItems.status, n: count() })
    .from(stockItems)
    .where(and(gt(stockItems.finished_at, daysAgo(30)), ne(stockItems.status, 'in_stock')))
    .groupBy(stockItems.status);
  const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const inStock = await db.$count(stockItems, eq(stockItems.status, 'in_stock'));
  const lastDay = today(addDays(new Date(), (await getSettings()).expiring_days));
  const [expiring] = await db
    .select({ n: count() })
    .from(stockItems)
    .innerJoin(products, eq(products.barcode, stockItems.barcode))
    .where(and(eq(stockItems.status, 'in_stock'), lte(expiresAt(), lastDay)));
  return { in_stock: inStock, expiring_soon: expiring?.n ?? 0, consumed_30d: get('consumed'), wasted_30d: get('wasted') };
});

// ---------------------------------------------------------------- products

// Search: every word must appear in name, brand or barcode (any order, case-insensitive), e.g. "milch weide" or "4006".
// Exact barcodes and names starting with the first word come first; stock_first=1 puts products in stock before the rest.
app.get('/api/products', async (req) => {
  const query = req.query as any;
  const words = String(query?.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const limit = Math.min(500, Math.max(1, parseInt(String(query?.limit ?? '500'), 10) || 500));
  const stockFirst = query?.stock_first === '1'; // quick search: what is in the pantry before the rest
  const escape = (w: string) => w.replace(/[\\%_]/g, '\\$&'); // LIKE wildcards are searched as text
  // the product's packs in stock (lateral: evaluated per product)
  const stock = db
    .select({
      in_stock: count().as('in_stock'),
      opened: count(stockItems.opened_at).as('opened'),
      next_expiry: min(expiresAt()).as('next_expiry'),
      location_names: distinctValues<string>(locations.name).as('location_names'),
    })
    .from(stockItems)
    .leftJoin(locations, eq(locations.id, stockItems.location_id))
    .where(and(eq(stockItems.barcode, products.barcode), eq(stockItems.status, 'in_stock')))
    .as('s');
  const rows = await db
    .select({
      ...getTableColumns(products),
      store_name: stores.name,
      in_stock: stock.in_stock,
      opened: stock.opened,
      next_expiry: stock.next_expiry,
      location_names: stock.location_names,
    })
    .from(products)
    .leftJoin(stores, eq(stores.id, products.store_id))
    .leftJoinLateral(stock, always)
    .where(and(...words.map((w) => ilike(joinedText(products.name, products.brand, products.barcode), `%${escape(w)}%`))))
    .orderBy(
      desc(eq(products.barcode, words.join(' '))),
      ...(stockFirst ? [desc(gt(stock.in_stock, 0))] : []),
      desc(ilike(products.name, words[0] ? `${escape(words[0])}%` : '')),
      asc(products.name),
      asc(products.barcode),
    )
    .limit(limit);
  return { products: rows };
});

app.get('/api/products/:barcode', async (req) => {
  const p = await getProduct((req.params as any).barcode);
  if (!p) throw new HttpError(404, 'Produkt unbekannt');
  return p;
});

app.patch('/api/products/:barcode', async (req) => {
  const barcode = (req.params as any).barcode as string;
  const b = body(req);
  const set: PgUpdateSetSource<typeof products> = {};
  if ('name' in b) set.name = str(b.name, 'name');
  if ('brand' in b) set.brand = b.brand ? str(b.brand, 'brand') : null;
  if ('shelf_life_days' in b) set.shelf_life_days = nullableInt(b.shelf_life_days, 1, 36500, 'shelf_life_days');
  if ('days_after_opening' in b) set.days_after_opening = nullableInt(b.days_after_opening, 1, 3650, 'days_after_opening');
  if ('min_stock' in b) set.min_stock = int(b.min_stock, 0, 99, 'min_stock');
  if ('store_id' in b) set.store_id = await storeIdOrNull(b.store_id);
  // a hand-set default location / move-on-open switches the automatic derivation off for this product
  if ('location_id' in b) {
    const lid = b.location_id === null || b.location_id === '' ? null : int(b.location_id, 1, 2147483647, 'location_id');
    if (lid !== null && !(await getLocation(lid))) throw new HttpError(404, 'Lagerort unbekannt');
    set.location_id = lid;
    set.auto_defaults = false;
  }
  if ('move_on_open' in b) {
    set.move_on_open = !!b.move_on_open;
    set.auto_defaults = false;
  }
  if (b.reset_auto === true) set.auto_defaults = true;
  if (!Object.keys(set).length) throw new HttpError(400, 'Nichts zu ändern');
  let [row] = await db.update(products).set(set).where(eq(products.barcode, barcode)).returning();
  if (!row) throw new HttpError(404, 'Produkt unbekannt');
  if (b.reset_auto === true) row = await applyDerivedDefaults(row); // back to the automatic suggestion
  bus.emit('change', { what: 'products' });
  return row;
});

app.post('/api/products/:barcode/refresh', async (req) => {
  const { product, offError } = await resolveProduct((req.params as any).barcode, true);
  bus.emit('change', { what: 'products' });
  return { product, offError };
});

// ---------------------------------------------------------------- stores (where a product is usually bought)

async function storeIdOrNull(v: unknown): Promise<number | null> {
  if (v === null || v === '' || v === undefined) return null;
  const id = int(v, 1, 2147483647, 'store_id');
  if (!(await db.$count(stores, eq(stores.id, id)))) throw new HttpError(404, 'Laden unbekannt');
  return id;
}

const storeFields = { id: stores.id, name: stores.name, sort: stores.sort };

app.get('/api/stores', async () => ({ stores: await db.select(storeFields).from(stores).orderBy(stores.sort, stores.name) }));

app.post('/api/stores', async (req) => {
  const name = str(body(req).name, 'name', 60);
  try {
    const [row] = await db.insert(stores).values({ name, sort: await nextStoreSort() }).returning(storeFields);
    bus.emit('change', { what: 'shopping' });
    return row;
  } catch {
    throw new HttpError(409, 'Laden existiert bereits');
  }
});

app.patch('/api/stores/:id', async (req) => {
  const id = int((req.params as any).id, 1, 2147483647, 'id');
  const b = body(req);
  if (b.move === 'up' || b.move === 'down') {
    const list = await db.select({ id: stores.id }).from(stores).orderBy(stores.sort, stores.name);
    const i = list.findIndex((r) => r.id === id);
    const j = b.move === 'up' ? i - 1 : i + 1;
    if (i < 0) throw new HttpError(404, 'Nicht gefunden');
    if (j >= 0 && j < list.length) {
      const order = list.map((r) => r.id);
      [order[i], order[j]] = [order[j]!, order[i]!];
      await db.transaction(async (tx) => {
        for (const [i, storeId] of order.entries()) await tx.update(stores).set({ sort: i + 1 }).where(eq(stores.id, storeId));
      });
    }
  } else {
    try {
      const [row] = await db.update(stores).set({ name: str(b.name, 'name', 60) }).where(eq(stores.id, id)).returning({ id: stores.id });
      if (!row) throw new HttpError(404, 'Nicht gefunden');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(409, 'Laden existiert bereits');
    }
  }
  bus.emit('change', { what: 'shopping' });
  return { ok: true };
});

app.delete('/api/stores/:id', async (req) => {
  await db.delete(stores).where(eq(stores.id, int((req.params as any).id, 1, 2147483647, 'id')));
  bus.emit('change', { what: 'shopping' });
  return { ok: true };
});

// ---------------------------------------------------------------- waste analysis
// consumed = used up (empty, thrown away); wasted = not used up, spoiled and thrown away.

app.get('/api/stats/waste', async (req) => {
  const days = Math.min(Math.max(parseInt(String((req.query as any)?.days ?? '90'), 10) || 90, 1), 3650);
  const finished = and(inArray(stockItems.status, ['consumed', 'wasted']), gt(stockItems.finished_at, daysAgo(days)));
  const isWasted = eq(stockItems.status, 'wasted');
  const consumedN = countWhere(eq(stockItems.status, 'consumed'));
  const wastedN = countWhere(isWasted);
  const totalsRows = await db.select({ status: stockItems.status, n: count() }).from(stockItems).where(finished).groupBy(stockItems.status);
  const consumed = totalsRows.find((r) => r.status === 'consumed')?.n ?? 0;
  const wasted = totalsRows.find((r) => r.status === 'wasted')?.n ?? 0;
  const byProduct = await db
    .select({
      barcode: products.barcode,
      name: products.name,
      brand: products.brand,
      image_url: products.image_url,
      consumed: consumedN,
      wasted: wastedN,
      wasted_expired: countWhere(and(isWasted, lt(stockItems.best_before, dateOf(stockItems.finished_at)))),
      wasted_opened: countWhere(and(isWasted, isNotNull(stockItems.opened_at))),
    })
    .from(stockItems)
    .innerJoin(products, eq(products.barcode, stockItems.barcode))
    .where(finished)
    .groupBy(products.barcode)
    .orderBy(desc(wastedN), desc(consumedN), asc(products.name), asc(products.barcode))
    .limit(200);
  const month = monthOf(stockItems.finished_at);
  const byMonth = await db.select({ month, consumed: consumedN, wasted: wastedN }).from(stockItems).where(finished).groupBy(month).orderBy(month);
  const locationName = coalesce<string>(locations.name, 'Ohne Lagerort');
  const byLocation = await db
    .select({ name: locationName, consumed: consumedN, wasted: wastedN })
    .from(stockItems)
    .leftJoin(locations, eq(locations.id, stockItems.location_id))
    .where(finished)
    .groupBy(locations.name)
    .orderBy(desc(wastedN), asc(locationName));
  const total = consumed + wasted;
  return { days, consumed, wasted, waste_rate: total ? wasted / total : 0, products: byProduct, months: byMonth, locations: byLocation };
});

// ---------------------------------------------------------------- shopping list

// open entries and what was ticked off in the last two days, grouped by store (the entry's own, else the product's)
app.get('/api/shopping', async () => {
  const effStore = coalesce<number | null>(shoppingItems.store_id, products.store_id);
  const items = await db
    .select({ ...getTableColumns(shoppingItems), image_url: products.image_url, eff_store_id: effStore, store_name: stores.name })
    .from(shoppingItems)
    .leftJoin(products, eq(products.barcode, shoppingItems.barcode))
    .leftJoin(stores, eq(stores.id, effStore))
    .where(or(eq(shoppingItems.done, false), gt(shoppingItems.done_at, daysAgo(2))))
    .orderBy(asc(shoppingItems.done), isNull(stores.id), asc(stores.sort), asc(stores.name), asc(shoppingItems.name), asc(shoppingItems.id));
  return { items };
});

app.post('/api/shopping', async (req) => {
  const b = body(req);
  const qty = int(b.qty ?? 1, 1, 99, 'qty');
  let product = null;
  if (b.barcode) product = (await resolveProduct(str(b.barcode, 'barcode', 32))).product;
  const name = b.name ? str(b.name, 'name') : product ? productLabel(product) : str(b.name, 'name');
  const r = await addToShopping(product, name, qty, 'manual');
  if ('store_id' in b) await db.update(shoppingItems).set({ store_id: await storeIdOrNull(b.store_id) }).where(eq(shoppingItems.id, r.id));
  bus.emit('change', { what: 'shopping' });
  return r;
});

app.patch('/api/shopping/:id', async (req) => {
  const id = int((req.params as any).id, 1, Number.MAX_SAFE_INTEGER, 'id');
  const b = body(req);
  const set: PgUpdateSetSource<typeof shoppingItems> = {};
  if ('done' in b) Object.assign(set, b.done ? { done: true, done_at: new Date() } : { done: false, done_at: null });
  if ('qty' in b) set.qty = int(b.qty, 1, 99, 'qty');
  if ('name' in b) set.name = str(b.name, 'name');
  if ('store_id' in b) set.store_id = await storeIdOrNull(b.store_id);
  if (!Object.keys(set).length) throw new HttpError(400, 'Nichts zu ändern');
  const [row] = await db.update(shoppingItems).set(set).where(eq(shoppingItems.id, id)).returning({ id: shoppingItems.id });
  if (!row) throw new HttpError(404, 'Nicht gefunden');
  bus.emit('change', { what: 'shopping' });
  return { ok: true };
});

app.delete('/api/shopping/:id', async (req) => {
  await db.delete(shoppingItems).where(eq(shoppingItems.id, int((req.params as any).id, 1, Number.MAX_SAFE_INTEGER, 'id')));
  bus.emit('change', { what: 'shopping' });
  return { ok: true };
});

app.post('/api/shopping/clear-done', async () => {
  await db.delete(shoppingItems).where(eq(shoppingItems.done, true));
  bus.emit('change', { what: 'shopping' });
  return { ok: true };
});

// ---------------------------------------------------------------- cached product images
// Public (an <img> tag cannot send the API token). The URL carries a version (?v=), so the browser may keep it for a long time.

app.get('/img/:file', async (req, reply) => {
  const file = String((req.params as any).file);
  if (!FILE_RE.test(file) || !hasImageFile(file)) return reply.status(404).send({ error: 'Bild nicht vorhanden' });
  return reply
    .header('Content-Type', contentTypeOf(file))
    .header('Cache-Control', 'public, max-age=31536000, immutable')
    .header('X-Content-Type-Options', 'nosniff')
    .send(fs.createReadStream(imageFilePath(file)));
});

// ---------------------------------------------------------------- settings, system, maintenance, backup

const pkgVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  } catch {
    return 'unbekannt';
  }
})();

app.get('/api/settings', async () => ({
  settings: await getSettings(),
  defaults: defaultSettings(),
  modes: MODES,
  sources: SOURCE_IDS.map((id) => ({ id, title: SOURCE_TITLES[id] })),
}));

app.patch('/api/settings', async (req) => {
  try {
    return { settings: await updateSettings(body(req)) };
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : 'Ungültige Einstellung');
  }
});

app.get('/api/system', async () => {
  return {
    version: pkgVersion,
    node: process.version,
    uptime_s: Math.round(process.uptime()),
    https_port: httpsActive ? config.httpsPort : 0,
    tls_hosts: tlsHostList,
    token_set: !!config.apiToken,
    images: imageStats(),
    counts: {
      products: await db.$count(products),
      stock_in: await db.$count(stockItems, eq(stockItems.status, 'in_stock')),
      stock_total: await db.$count(stockItems),
      locations: await db.$count(locations),
      stores: await db.$count(stores),
      shopping_open: await db.$count(shoppingItems, eq(shoppingItems.done, false)),
    },
  };
});

// recompute the automatic default storage location after location types changed (hand-set products are left alone)
app.post('/api/maintenance/reclassify', async () => {
  const list = await db.select().from(products).where(eq(products.auto_defaults, true));
  let changed = 0;
  for (const p of list) {
    const after = await applyDerivedDefaults(p);
    if (after.location_id !== p.location_id || after.move_on_open !== p.move_on_open) changed++;
  }
  bus.emit('change', { what: 'products' });
  return { checked: list.length, changed };
});

// ask the online databases again for products that were not found before (e.g. after enabling another database)
app.post('/api/maintenance/retry-unknown', async () => {
  const list = await db
    .select({ barcode: products.barcode })
    .from(products)
    .where(or(isNull(products.off_found), eq(products.off_found, false)))
    .orderBy(isNotNull(products.off_fetched_at), asc(products.off_fetched_at)) // never asked first
    .limit(40);
  let found = 0;
  for (const { barcode } of list) {
    const r = await resolveProduct(barcode, true);
    if (r.product.off_found) found++;
    await new Promise((res) => setTimeout(res, 300));
  }
  bus.emit('change', { what: 'products' });
  return { tried: list.length, found };
});

app.post('/api/maintenance/cache-images', async () => backfillImages());

// forget the local copies; products fall back to the remote image URL
app.post('/api/maintenance/clear-image-cache', async () => {
  const removed = clearImageFiles();
  await db
    .update(products)
    .set({ image_url: products.image_source_url, image_file: null })
    .where(and(isNotNull(products.image_file), isNotNull(products.image_source_url)));
  await db.update(products).set({ image_file: null }).where(isNotNull(products.image_file));
  bus.emit('change', { what: 'products' });
  return { removed };
});

// full data backup as JSON (download)
app.get('/api/export', async (_req, reply) => {
  const dump = { ...(await buildExport()), version: pkgVersion };
  reply.header('Content-Disposition', `attachment; filename="beepstock-${new Date().toISOString().slice(0, 10)}.json"`);
  return dump;
});

// restore a backup. ?mode=replace|merge (required), ?dry=1 only reports what would happen
app.post('/api/import', { bodyLimit: 64 * 1024 * 1024 }, async (req) => {
  const { mode, dry } = req.query as Record<string, string>;
  if (mode !== 'replace' && mode !== 'merge') throw new HttpError(400, 'mode: replace oder merge');
  try {
    const r = await importBackup(req.body, mode, dry === '1' || dry === 'true');
    if (!r.dry_run) {
      bus.emit('change', { what: 'stock' });
      bus.emit('change', { what: 'products' });
      bus.emit('change', { what: 'shopping' });
      bus.emit('state', await getState());
      if (mode === 'replace') backfillImages((m) => app.log.info(m)).catch(() => undefined); // re-fetch the image copies
    }
    return r;
  } catch (e) {
    if (e instanceof BackupError) throw new HttpError(400, e.message);
    app.log.error(e, 'import failed');
    throw new HttpError(500, 'Import fehlgeschlagen, es wurde nichts geändert');
  }
});

app.get('/api/backups', async () => ({ files: listSafetyBackups() }));

app.get('/api/backups/:name', async (req, reply) => {
  const file = safetyBackupPath(String((req.params as any).name));
  if (!file) throw new HttpError(404, 'Sicherung nicht gefunden');
  reply.header('Content-Type', 'application/json').header('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  return reply.send(fs.createReadStream(file));
});

// ---------------------------------------------------------------- inventory count

const locId = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw new HttpError(400, 'location_id ungültig');
  return n; // 0 = no storage location
};
const needSession = async () => {
  const s = await openSession();
  if (!s) throw new HttpError(409, 'Keine offene Inventur');
  return s;
};

app.get('/api/inventory', async () => {
  const session = await openSession();
  const locs = await db.select({ id: locations.id, name: locations.name }).from(locations).orderBy(locations.id);
  if (!session) return { session: null, locations: locs };
  const list = await inventoryRows(session.id);
  const diffs = list.filter((r) => r.before !== r.counted);
  return { session, locations: locs, rows: list, summary: { total: list.length, diffs: diffs.length, open: diffs.filter((r) => r.resolved == null).length } };
});

app.post('/api/inventory/start', async (req) => {
  const ids: unknown = body(req).location_ids;
  const scope = Array.isArray(ids) ? [...new Set(ids.map(locId))] : [];
  const session = await startSession(scope);
  bus.emit('change', { what: 'inventory' });
  return { session };
});

app.post('/api/inventory/scope', async (req) => {
  const s = await needSession();
  const b = body(req);
  if (b.include) await addScope(s.id, locId(b.location_id));
  else await removeScope(s.id, locId(b.location_id));
  bus.emit('change', { what: 'inventory' });
  return { ok: true };
});

app.patch('/api/inventory/row', async (req) => {
  const s = await needSession();
  const b = body(req);
  await setCounted(s.id, str(b.barcode, 'barcode', 32), locId(b.location_id), int(b.counted, 0, 9999, 'counted'));
  return { ok: true };
});

app.post('/api/inventory/row', async (req) => {
  const s = await needSession();
  const b = body(req);
  if (b.action !== 'keep' && b.action !== 'apply') throw new HttpError(400, 'action: keep oder apply');
  return resolveRow(s.id, str(b.barcode, 'barcode', 32), locId(b.location_id), b.action);
});

app.post('/api/inventory/resolve-all', async (req) => {
  const s = await needSession();
  const action = body(req).action;
  if (action !== 'keep' && action !== 'apply') throw new HttpError(400, 'action: keep oder apply');
  return { resolved: await resolveAll(s.id, action) };
});

app.post('/api/inventory/finish', async (req) => {
  const s = await needSession();
  await finishSession(s.id, body(req).cancel ? 'cancelled' : 'done');
  return { ok: true };
});

// ---------------------------------------------------------------- websocket
// Clients send plain barcode text (or {"code": "..."}) and receive scan results/state/change events.

app.get('/ws', { websocket: true }, (socket) => {
  const send = (type: string, data: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type, data }));
  };
  const onScan = (r: unknown) => send('scan', r);
  const onState = (s: unknown) => send('state', s);
  const onChange = (c: unknown) => send('change', c);
  bus.on('scan', onScan);
  bus.on('state', onState);
  bus.on('change', onChange);
  getState().then((s) => send('state', s)).catch(() => undefined);

  socket.on('message', async (raw: Buffer) => {
    const text = raw.toString().trim();
    let code = text;
    if (text.startsWith('{')) {
      try {
        code = String(JSON.parse(text).code ?? '');
      } catch {
        return send('error', { error: 'Ungültiges JSON' });
      }
    }
    try {
      await handleScan(code, 'ws'); // result is broadcast via the bus
    } catch (e) {
      app.log.error(e);
      send('error', { error: 'Scan fehlgeschlagen' });
    }
  });
  socket.on('close', () => {
    bus.off('scan', onScan);
    bus.off('state', onState);
    bus.off('change', onChange);
  });
});

app.get('/healthz', async (_req: FastifyRequest, reply: FastifyReply) => {
  await ping();
  return reply.send({ ok: true });
});

// ---------------------------------------------------------------- start

async function connectWithRetry(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await migrate();
      return;
    } catch (e) {
      if (e instanceof SchemaError) throw e; // waiting does not help
      app.log.warn(`Datenbank noch nicht bereit (${e instanceof Error ? e.message : e}), neuer Versuch…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Datenbank nicht erreichbar');
}

// set once the HTTPS listener is up; read by /api/info (the UI links to https:// for the camera)
let httpsActive = false;
let tlsHostList: string[] = [];
app.get('/api/info', async () => ({ httpsPort: httpsActive ? config.httpsPort : 0 }));

await connectWithRetry();
await app.listen({ port: config.port, host: '0.0.0.0' });

// Optional HTTPS (self-signed) for the camera scanner on phones. WebSocket upgrades are forwarded to the main server.
try {
  const tls = await loadOrCreateTls();
  if (tls && requestHandler) {
    const httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, requestHandler);
    httpsServer.on('upgrade', (req, socket, head) => app.server.emit('upgrade', req, socket, head));
    httpsServer.on('error', (e) => app.log.error(e, 'HTTPS server error'));
    httpsServer.listen(config.httpsPort, '0.0.0.0', () => app.log.info(`HTTPS on :${config.httpsPort} (self-signed for ${tls.hosts.join(', ')})`));
    httpsActive = true;
    tlsHostList = tls.hosts;
  }
} catch (e) {
  app.log.error(e, 'could not start HTTPS');
}

backfillClassification((m) => app.log.info(m))
  .then(() => backfillImages((m) => app.log.info(m)))
  .catch((e) => app.log.error(e, 'background jobs failed'));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().then(() => pool.end()).finally(() => process.exit(0));
  });
}
