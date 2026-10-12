import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.js';
import { controlSheet, MODES, type Mode } from './control.js';
import { migrate, pool, q, q1 } from './db.js';
import { addScope, finishSession, openSession, removeScope, resolveAll, resolveRow, rows as inventoryRows, setCounted, startSession } from './inventory.js';
import { BackupError, buildExport, importBackup, listSafetyBackups, safetyBackupPath } from './backup.js';
import { clearImageFiles, contentTypeOf, FILE_RE, hasImageFile, imageFilePath, imageStats } from './images.js';
import { defaultSettings, getSettings, SOURCE_IDS, SOURCE_TITLES, updateSettings } from './settings.js';
import { guessKindFromName, KINDS, type Kind } from './storage.js';
import { loadOrCreateTls } from './tls.js';
import {
  addToShopping,
  applyDerivedDefaults,
  backfillClassification,
  backfillImages,
  bus,
  getProduct,
  getState,
  handleScan,
  listLocations,
  productLabel,
  relocateOnOpen,
  resolveProduct,
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

const STOCK_SELECT = `
  SELECT s.id, s.barcode, s.best_before, s.opened_at, s.added_at, s.status, s.finished_at, s.waste_reason,
         LEAST(s.best_before, (s.opened_at::date + p.days_after_opening)) AS expires,
         s.location_id, l.name AS location_name,
         p.name, p.brand, p.quantity_text, p.image_url, p.nutriscore, p.min_stock, p.days_after_opening
  FROM stock_items s JOIN products p USING (barcode) LEFT JOIN locations l ON l.id = s.location_id`;

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
  if (id !== null && !(await q1('SELECT id FROM locations WHERE id = $1', [int(id, 1, 2147483647, 'location_id')]))) throw new HttpError(404, 'Lagerort unbekannt');
  return { state: await setLocation(id) };
});

app.post('/api/locations', async (req) => {
  const name = str(body(req).name, 'name', 60);
  const kind: Kind = KINDS.includes(body(req).kind) ? body(req).kind : guessKindFromName(name);
  try {
    return await q1('INSERT INTO locations (name, kind) VALUES ($1, $2) RETURNING id, name, kind', [name, kind]);
  } catch {
    throw new HttpError(409, 'Lagerort existiert bereits');
  }
});

app.patch('/api/locations/:id', async (req) => {
  const id = int((req.params as any).id, 1, 2147483647, 'id');
  try {
    const b = body(req);
    if (b.kind !== undefined && !KINDS.includes(b.kind)) throw new HttpError(400, 'kind: fridge, freezer, pantry oder other');
    const row = await q1(
      'UPDATE locations SET name = COALESCE($2, name), kind = COALESCE($3, kind) WHERE id = $1 RETURNING id, name, kind',
      [id, b.name === undefined ? null : str(b.name, 'name', 60), b.kind ?? null],
    );
    if (!row) throw new HttpError(404, 'Nicht gefunden');
    bus.emit('state', await getState());
    return row;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(409, 'Lagerort existiert bereits');
  }
});

app.delete('/api/locations/:id', async (req) => {
  await q('DELETE FROM locations WHERE id = $1', [int((req.params as any).id, 1, 2147483647, 'id')]);
  bus.emit('state', await getState());
  bus.emit('change', { what: 'stock' });
  return { ok: true };
});

// ---------------------------------------------------------------- stock

app.get('/api/stock', async () => {
  const items = await q(`${STOCK_SELECT} WHERE s.status = 'in_stock' ORDER BY p.name, COALESCE(LEAST(s.best_before, (s.opened_at::date + p.days_after_opening)), 'infinity'::date)`);
  return { items };
});

app.post('/api/stock', async (req) => {
  const b = body(req);
  const barcode = str(b.barcode, 'barcode', 32);
  const qty = int(b.qty ?? 1, 1, 99, 'qty');
  const bb = dateStr(b.best_before ?? null, 'best_before');
  const { product } = await resolveProduct(barcode);
  const loc = b.location_id == null ? (await getState()).location_id : int(b.location_id, 1, 2147483647, 'location_id');
  const rows = await q(`INSERT INTO stock_items (barcode, best_before, location_id) SELECT $1, $2::date, $4 FROM generate_series(1,$3) RETURNING id`, [
    product.barcode,
    bb,
    qty,
    loc,
  ]);
  bus.emit('change', { what: 'stock' });
  return { added: rows.length };
});

app.patch('/api/stock/:id', async (req) => {
  const id = int((req.params as any).id, 1, Number.MAX_SAFE_INTEGER, 'id');
  const b = body(req);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('best_before' in b) {
    vals.push(dateStr(b.best_before, 'best_before'));
    sets.push(`best_before = $${vals.length}`);
  }
  if ('location_id' in b) {
    vals.push(b.location_id === null ? null : int(b.location_id, 1, 2147483647, 'location_id'));
    sets.push(`location_id = $${vals.length}`);
  }
  if ('opened' in b) sets.push(b.opened ? 'opened_at = COALESCE(opened_at, now())' : 'opened_at = NULL');
  if (!sets.length) throw new HttpError(400, 'Nichts zu ändern');
  vals.push(id);
  const row = await q1(`UPDATE stock_items SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals);
  if (!row) throw new HttpError(404, 'Nicht gefunden');
  bus.emit('change', { what: 'stock' });
  return { ok: true };
});

app.post('/api/stock/:id/:action', async (req) => {
  const { id: rawId, action } = req.params as { id: string; action: string };
  const id = int(rawId, 1, Number.MAX_SAFE_INTEGER, 'id');
  if (action === 'consume' || action === 'waste') {
    const row = await q1<{ barcode: string }>(
      `UPDATE stock_items SET status = $2, finished_at = now(), waste_reason = $3 WHERE id = $1 AND status = 'in_stock' RETURNING barcode`,
      [id, action === 'consume' ? 'consumed' : 'wasted', typeof body(req).reason === 'string' ? body(req).reason.slice(0, 200) : null],
    );
    if (!row) throw new HttpError(404, 'Nicht im Vorrat');
    await q('INSERT INTO events (kind, barcode, item_ids) VALUES ($1,$2,$3)', [action, row.barcode, [id]]);
    if (action === 'consume' || (await getSettings()).restock_on_waste) await restock(row.barcode);
  } else if (action === 'open') {
    const row = await q1<{ barcode: string }>(`UPDATE stock_items SET opened_at = now() WHERE id = $1 AND status = 'in_stock' RETURNING barcode`, [id]);
    if (!row) throw new HttpError(404, 'Nicht im Vorrat');
    const moved = await relocateOnOpen([id]); // pantry -> fridge
    await q('INSERT INTO events (kind, barcode, item_ids, detail) VALUES ($1,$2,$3,$4)', ['open', row.barcode, [id], JSON.stringify({ moved: moved.moved })]);
    bus.emit('change', { what: 'stock' });
    return { ok: true, moved_to: moved.to };
  } else if (action === 'delete') {
    await q('DELETE FROM stock_items WHERE id = $1', [id]);
  } else {
    throw new HttpError(404, 'Unbekannte Aktion');
  }
  bus.emit('change', { what: 'stock' });
  return { ok: true };
});

async function restock(barcode: string): Promise<void> {
  const p = await getProduct(barcode);
  if (!p || p.min_stock <= 0) return;
  const have = (await q1<{ n: number }>(`SELECT count(*)::int AS n FROM stock_items WHERE barcode=$1 AND status='in_stock'`, [barcode]))?.n ?? 0;
  const open = await q1('SELECT id FROM shopping_items WHERE barcode=$1 AND NOT done', [barcode]);
  if (have < p.min_stock && !open) await addToShopping(p, productLabel(p), p.min_stock - have, 'auto');
}

app.get('/api/history', async (req) => {
  const { status, limit } = req.query as Record<string, string>;
  const st = status === 'consumed' || status === 'wasted' ? status : null;
  const lim = Math.min(Math.max(parseInt(limit ?? '200', 10) || 200, 1), 1000);
  const items = await q(
    `${STOCK_SELECT} WHERE s.status = ${st ? '$1' : `ANY(ARRAY['consumed','wasted'])`} ORDER BY s.finished_at DESC LIMIT ${lim}`,
    st ? [st] : [],
  );
  return { items };
});

app.get('/api/stats', async () => {
  const rows = await q<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM stock_items WHERE finished_at > now() - interval '30 days' AND status <> 'in_stock' GROUP BY status`,
  );
  const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const inStock = (await q1<{ n: number }>(`SELECT count(*)::int AS n FROM stock_items WHERE status='in_stock'`))?.n ?? 0;
  const expiring = (await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM stock_items s JOIN products p USING (barcode)
     WHERE s.status='in_stock' AND LEAST(s.best_before, (s.opened_at::date + p.days_after_opening)) <= current_date + $1::int`,
    [(await getSettings()).expiring_days],
  ))?.n ?? 0;
  return { in_stock: inStock, expiring_soon: expiring, consumed_30d: get('consumed'), wasted_30d: get('wasted') };
});

// ---------------------------------------------------------------- products

app.get('/api/products', async (req) => {
  const search = String((req.query as any)?.q ?? '').trim();
  const rows = await q(
    `SELECT p.*, st.name AS store_name, (SELECT count(*)::int FROM stock_items s WHERE s.barcode = p.barcode AND s.status = 'in_stock') AS in_stock
     FROM products p LEFT JOIN stores st ON st.id = p.store_id WHERE ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.brand ILIKE '%' || $1 || '%' OR p.barcode = $1)
     ORDER BY p.name LIMIT 500`,
    [search],
  );
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
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if ('name' in b) add('name', str(b.name, 'name'));
  if ('brand' in b) add('brand', b.brand ? str(b.brand, 'brand') : null);
  if ('shelf_life_days' in b) add('shelf_life_days', nullableInt(b.shelf_life_days, 1, 36500, 'shelf_life_days'));
  if ('days_after_opening' in b) add('days_after_opening', nullableInt(b.days_after_opening, 1, 3650, 'days_after_opening'));
  if ('min_stock' in b) add('min_stock', int(b.min_stock, 0, 99, 'min_stock'));
  if ('store_id' in b) add('store_id', await storeIdOrNull(b.store_id));
  // a hand-set default location / move-on-open switches the automatic derivation off for this product
  if ('location_id' in b) {
    const lid = b.location_id === null || b.location_id === '' ? null : int(b.location_id, 1, 2147483647, 'location_id');
    if (lid !== null && !(await q1('SELECT id FROM locations WHERE id = $1', [lid]))) throw new HttpError(404, 'Lagerort unbekannt');
    add('location_id', lid);
    sets.push('auto_defaults = false');
  }
  if ('move_on_open' in b) {
    add('move_on_open', !!b.move_on_open);
    if (!sets.includes('auto_defaults = false')) sets.push('auto_defaults = false');
  }
  if (b.reset_auto === true) {
    sets.push('auto_defaults = true');
  }
  if (!sets.length) throw new HttpError(400, 'Nichts zu ändern');
  vals.push(barcode);
  let row = await q1<any>(`UPDATE products SET ${sets.join(', ')} WHERE barcode = $${vals.length} RETURNING *`, vals);
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
  if (!(await q1('SELECT id FROM stores WHERE id = $1', [id]))) throw new HttpError(404, 'Laden unbekannt');
  return id;
}

app.get('/api/stores', async () => ({ stores: await q('SELECT id, name, sort FROM stores ORDER BY sort, name') }));

app.post('/api/stores', async (req) => {
  const name = str(body(req).name, 'name', 60);
  try {
    const row = await q1('INSERT INTO stores (name, sort) VALUES ($1, COALESCE((SELECT max(sort) + 1 FROM stores), 1)) RETURNING id, name, sort', [name]);
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
    const list = await q<{ id: number }>('SELECT id FROM stores ORDER BY sort, name');
    const i = list.findIndex((r) => r.id === id);
    const j = b.move === 'up' ? i - 1 : i + 1;
    if (i < 0) throw new HttpError(404, 'Nicht gefunden');
    if (j >= 0 && j < list.length) {
      const order = list.map((r) => r.id);
      [order[i], order[j]] = [order[j]!, order[i]!];
      await q('UPDATE stores SET sort = x.ord FROM (SELECT id, ord FROM unnest($1::int[]) WITH ORDINALITY AS t(id, ord)) x WHERE stores.id = x.id', [order]);
    }
  } else {
    try {
      if (!(await q1('UPDATE stores SET name = $2 WHERE id = $1 RETURNING id', [id, str(b.name, 'name', 60)]))) throw new HttpError(404, 'Nicht gefunden');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(409, 'Laden existiert bereits');
    }
  }
  bus.emit('change', { what: 'shopping' });
  return { ok: true };
});

app.delete('/api/stores/:id', async (req) => {
  await q('DELETE FROM stores WHERE id = $1', [int((req.params as any).id, 1, 2147483647, 'id')]);
  bus.emit('change', { what: 'shopping' });
  return { ok: true };
});

// ---------------------------------------------------------------- waste analysis
// consumed = used up (empty, thrown away); wasted = not used up, spoiled and thrown away.

app.get('/api/stats/waste', async (req) => {
  const days = Math.min(Math.max(parseInt(String((req.query as any)?.days ?? '90'), 10) || 90, 1), 3650);
  const where = `s.status IN ('consumed','wasted') AND s.finished_at > now() - make_interval(days => $1)`;
  const totalsRows = await q<{ status: string; n: number }>(`SELECT s.status, count(*)::int AS n FROM stock_items s WHERE ${where} GROUP BY s.status`, [days]);
  const consumed = totalsRows.find((r) => r.status === 'consumed')?.n ?? 0;
  const wasted = totalsRows.find((r) => r.status === 'wasted')?.n ?? 0;
  const products = await q(
    `SELECT p.barcode, p.name, p.brand, p.image_url,
            count(*) FILTER (WHERE s.status = 'consumed')::int AS consumed,
            count(*) FILTER (WHERE s.status = 'wasted')::int AS wasted,
            count(*) FILTER (WHERE s.status = 'wasted' AND s.best_before < s.finished_at::date)::int AS wasted_expired,
            count(*) FILTER (WHERE s.status = 'wasted' AND s.opened_at IS NOT NULL)::int AS wasted_opened
     FROM stock_items s JOIN products p USING (barcode) WHERE ${where}
     GROUP BY p.barcode ORDER BY wasted DESC, consumed DESC, p.name LIMIT 200`,
    [days],
  );
  const months = await q(
    `SELECT to_char(date_trunc('month', s.finished_at), 'YYYY-MM') AS month,
            count(*) FILTER (WHERE s.status = 'consumed')::int AS consumed,
            count(*) FILTER (WHERE s.status = 'wasted')::int AS wasted
     FROM stock_items s WHERE ${where} GROUP BY 1 ORDER BY 1`,
    [days],
  );
  const locations = await q(
    `SELECT COALESCE(l.name, 'Ohne Lagerort') AS name,
            count(*) FILTER (WHERE s.status = 'consumed')::int AS consumed,
            count(*) FILTER (WHERE s.status = 'wasted')::int AS wasted
     FROM stock_items s LEFT JOIN locations l ON l.id = s.location_id WHERE ${where} GROUP BY 1 ORDER BY wasted DESC, 1`,
    [days],
  );
  const total = consumed + wasted;
  return { days, consumed, wasted, waste_rate: total ? wasted / total : 0, products, months, locations };
});

// ---------------------------------------------------------------- shopping list

app.get('/api/shopping', async () => ({
  items: await q(
    `SELECT sh.*, p.image_url, COALESCE(sh.store_id, p.store_id) AS eff_store_id, st.name AS store_name
     FROM shopping_items sh LEFT JOIN products p USING (barcode) LEFT JOIN stores st ON st.id = COALESCE(sh.store_id, p.store_id)
     WHERE NOT sh.done OR sh.done_at > now() - interval '2 days'
     ORDER BY sh.done, (st.id IS NULL), st.sort, st.name, sh.name`,
  ),
}));

app.post('/api/shopping', async (req) => {
  const b = body(req);
  const qty = int(b.qty ?? 1, 1, 99, 'qty');
  let product = null;
  if (b.barcode) product = (await resolveProduct(str(b.barcode, 'barcode', 32))).product;
  const name = b.name ? str(b.name, 'name') : product ? productLabel(product) : str(b.name, 'name');
  const r = await addToShopping(product, name, qty, 'manual');
  if ('store_id' in b) await q('UPDATE shopping_items SET store_id = $2 WHERE id = $1', [r.id, await storeIdOrNull(b.store_id)]);
  bus.emit('change', { what: 'shopping' });
  return r;
});

app.patch('/api/shopping/:id', async (req) => {
  const id = int((req.params as any).id, 1, Number.MAX_SAFE_INTEGER, 'id');
  const b = body(req);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('done' in b) sets.push(b.done ? 'done = true, done_at = now()' : 'done = false, done_at = NULL');
  if ('qty' in b) {
    vals.push(int(b.qty, 1, 99, 'qty'));
    sets.push(`qty = $${vals.length}`);
  }
  if ('name' in b) {
    vals.push(str(b.name, 'name'));
    sets.push(`name = $${vals.length}`);
  }
  if ('store_id' in b) {
    vals.push(await storeIdOrNull(b.store_id));
    sets.push(`store_id = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'Nichts zu ändern');
  vals.push(id);
  if (!(await q1(`UPDATE shopping_items SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals))) throw new HttpError(404, 'Nicht gefunden');
  bus.emit('change', { what: 'shopping' });
  return { ok: true };
});

app.delete('/api/shopping/:id', async (req) => {
  await q('DELETE FROM shopping_items WHERE id = $1', [int((req.params as any).id, 1, Number.MAX_SAFE_INTEGER, 'id')]);
  bus.emit('change', { what: 'shopping' });
  return { ok: true };
});

app.post('/api/shopping/clear-done', async () => {
  await q('DELETE FROM shopping_items WHERE done');
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
  const count = async (t: string) => (await q1<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))?.n ?? 0;
  return {
    version: pkgVersion,
    node: process.version,
    uptime_s: Math.round(process.uptime()),
    https_port: httpsActive ? config.httpsPort : 0,
    tls_hosts: tlsHostList,
    token_set: !!config.apiToken,
    images: imageStats(),
    counts: {
      products: await count('products'),
      stock_in: (await q1<{ n: number }>(`SELECT count(*)::int AS n FROM stock_items WHERE status = 'in_stock'`))?.n ?? 0,
      stock_total: await count('stock_items'),
      locations: await count('locations'),
      stores: await count('stores'),
      shopping_open: (await q1<{ n: number }>('SELECT count(*)::int AS n FROM shopping_items WHERE NOT done'))?.n ?? 0,
    },
  };
});

// recompute the automatic default storage location after location types changed (hand-set products are left alone)
app.post('/api/maintenance/reclassify', async () => {
  const list = await q<any>('SELECT * FROM products WHERE auto_defaults');
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
  const list = await q<{ barcode: string }>('SELECT barcode FROM products WHERE off_found IS NOT TRUE ORDER BY off_fetched_at NULLS FIRST LIMIT 40');
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
  await q(`UPDATE products SET image_url = image_source_url, image_file = NULL WHERE image_file IS NOT NULL AND image_source_url IS NOT NULL`);
  await q(`UPDATE products SET image_file = NULL WHERE image_file IS NOT NULL`);
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
  const locations = await q<{ id: number; name: string }>('SELECT id, name FROM locations ORDER BY id');
  if (!session) return { session: null, locations };
  const list = await inventoryRows(session.id);
  const diffs = list.filter((r) => r.before !== r.counted);
  return { session, locations, rows: list, summary: { total: list.length, diffs: diffs.length, open: diffs.filter((r) => r.resolved == null).length } };
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
  await pool.query('SELECT 1');
  return reply.send({ ok: true });
});

// ---------------------------------------------------------------- start

async function connectWithRetry(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await migrate();
      return;
    } catch (e) {
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
