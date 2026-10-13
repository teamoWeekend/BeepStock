import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from './db.js';
import { coalesce, greatest, orZero, plus } from './expressions.js';
import { inventoryCounts, inventorySessions, locations, products, stockItems } from './schema.js';
import { addStock, bus, getProduct, logEvent, PICK_ORDER, productLabel, restockCheck } from './service.js';

/**
 * Inventory count ("Inventur"): scan everything per storage location, then compare the counted amount per
 * product and location with the stock before, and take either value with one click.
 *
 * Location 0 stands for "no storage location". Rows are keyed by (barcode, location).
 * Taking the counted value adds missing packs (no best-before date) or retires surplus packs with status
 * 'adjusted' - never as consumed/wasted, so the waste analysis stays clean.
 */

export interface Session {
  id: number;
  started_at: Date;
  scope: number[];
}

const sessionFields = { id: inventorySessions.id, started_at: inventorySessions.started_at, scope: inventorySessions.scope };

export async function openSession(): Promise<Session | undefined> {
  const [s] = await db.select(sessionFields).from(inventorySessions).where(eq(inventorySessions.status, 'open')).orderBy(desc(inventorySessions.id)).limit(1);
  return s;
}

export async function startSession(scope: number[]): Promise<Session> {
  const existing = await openSession();
  if (existing) {
    for (const loc of scope) await addScope(existing.id, loc);
    return (await openSession())!;
  }
  const [row] = await db.insert(inventorySessions).values({ scope }).returning(sessionFields);
  bus.emit('change', { what: 'inventory' });
  return row!;
}

async function scopeOf(sessionId: number): Promise<number[] | undefined> {
  const [s] = await db.select({ scope: inventorySessions.scope }).from(inventorySessions).where(eq(inventorySessions.id, sessionId));
  return s?.scope;
}

export async function addScope(sessionId: number, loc: number): Promise<void> {
  const scope = await scopeOf(sessionId);
  if (scope && !scope.includes(loc)) await db.update(inventorySessions).set({ scope: [...scope, loc] }).where(eq(inventorySessions.id, sessionId));
}

export async function removeScope(sessionId: number, loc: number): Promise<void> {
  const scope = await scopeOf(sessionId);
  if (scope?.includes(loc)) await db.update(inventorySessions).set({ scope: scope.filter((l) => l !== loc) }).where(eq(inventorySessions.id, sessionId));
}

/** Packs in stock of a product at one location (0 = without location). */
const inStockAt = (barcode: string, loc: number) =>
  and(eq(stockItems.barcode, barcode), eq(stockItems.status, 'in_stock'), loc ? eq(stockItems.location_id, loc) : isNull(stockItems.location_id));

const countRow = (sessionId: number, barcode: string, loc: number) =>
  and(eq(inventoryCounts.session_id, sessionId), eq(inventoryCounts.barcode, barcode), eq(inventoryCounts.location_id, loc));

const countKey = [inventoryCounts.session_id, inventoryCounts.barcode, inventoryCounts.location_id];

/** One scan in inventory mode. Starts a session automatically if none is open. */
export async function countScan(barcode: string, loc: number, qty: number): Promise<{ counted: number; stock: number; autoStarted: boolean; sessionId: number }> {
  let session = await openSession();
  const autoStarted = !session;
  if (!session) session = await startSession([loc]);
  else await addScope(session.id, loc);
  const [row] = await db
    .insert(inventoryCounts)
    .values({ session_id: session.id, barcode, location_id: loc, counted: qty })
    .onConflictDoUpdate({ target: countKey, set: { counted: plus(inventoryCounts.counted, qty), resolved: null } })
    .returning({ counted: inventoryCounts.counted });
  await logEvent('count', barcode, [], { session: session.id, location: loc, qty });
  bus.emit('change', { what: 'inventory' });
  return { counted: row!.counted, stock: await db.$count(stockItems, inStockAt(barcode, loc)), autoStarted, sessionId: session.id };
}

/** Undo of a count scan (PCUNDO in inventory mode). */
export async function undoCount(detail: { session: number; location: number; qty: number }, barcode: string): Promise<void> {
  const where = countRow(detail.session, barcode, detail.location);
  await db.update(inventoryCounts).set({ counted: greatest(0, plus(inventoryCounts.counted, -detail.qty)) }).where(where);
  await db.delete(inventoryCounts).where(and(where, eq(inventoryCounts.counted, 0), isNull(inventoryCounts.resolved)));
  bus.emit('change', { what: 'inventory' });
}

export interface Row {
  barcode: string;
  location_id: number;
  location_name: string;
  name: string;
  brand: string | null;
  image_url: string | null;
  before: number;
  counted: number;
  resolved: string | null;
}

/** Stock before and counted amount per product and location of the session's scope, counted or not. */
export async function rows(sessionId: number): Promise<Row[]> {
  const scope = (await scopeOf(sessionId)) ?? [];
  const stockLoc = orZero(stockItems.location_id);
  const stock = db.$with('stock').as(
    db
      .select({ barcode: stockItems.barcode, loc: stockLoc.as('loc'), n: count().as('n') })
      .from(stockItems)
      .where(and(eq(stockItems.status, 'in_stock'), inArray(stockLoc, scope)))
      .groupBy(stockItems.barcode, stockLoc),
  );
  const cnt = db.$with('cnt').as(
    db
      .select({ barcode: inventoryCounts.barcode, loc: inventoryCounts.location_id, counted: inventoryCounts.counted, resolved: inventoryCounts.resolved })
      .from(inventoryCounts)
      .where(eq(inventoryCounts.session_id, sessionId)),
  );
  const barcode = coalesce<string>(stock.barcode, cnt.barcode);
  const loc = coalesce<number>(stock.loc, cnt.loc);
  return db
    .with(stock, cnt)
    .select({
      barcode,
      location_id: loc,
      location_name: coalesce<string>(locations.name, 'Ohne Lagerort'),
      name: products.name,
      brand: products.brand,
      image_url: products.image_url,
      before: orZero(stock.n),
      counted: orZero(cnt.counted),
      resolved: cnt.resolved,
    })
    .from(stock)
    .fullJoin(cnt, and(eq(stock.barcode, cnt.barcode), eq(stock.loc, cnt.loc)))
    .innerJoin(products, eq(products.barcode, barcode))
    .leftJoin(locations, eq(locations.id, loc))
    .orderBy(eq(loc, 0), asc(locations.id), asc(products.name), asc(products.barcode));
}

/** Corrects a counted value by hand (+/- in the UI). */
export async function setCounted(sessionId: number, barcode: string, loc: number, counted: number): Promise<void> {
  await db
    .insert(inventoryCounts)
    .values({ session_id: sessionId, barcode, location_id: loc, counted })
    .onConflictDoUpdate({ target: countKey, set: { counted, resolved: null } });
  bus.emit('change', { what: 'inventory' });
}

/** keep = stock stays as it was; apply = stock becomes the counted amount. */
export async function resolveRow(sessionId: number, barcode: string, loc: number, action: 'keep' | 'apply'): Promise<{ added: number; removed: number }> {
  const [c] = await db.select({ counted: inventoryCounts.counted }).from(inventoryCounts).where(countRow(sessionId, barcode, loc));
  const counted = c?.counted ?? 0;
  let added = 0, removed = 0;
  if (action === 'apply') {
    const delta = counted - (await db.$count(stockItems, inStockAt(barcode, loc)));
    if (delta > 0) {
      const ids = await addStock(barcode, delta, null, loc || null);
      await logEvent('add', barcode, ids, { inventory: true, location_id: loc });
      added = ids.length;
    } else if (delta < 0) {
      const surplus = db.select({ id: stockItems.id }).from(stockItems).where(inStockAt(barcode, loc)).orderBy(...PICK_ORDER).limit(-delta);
      const ids = await db
        .update(stockItems)
        .set({ status: 'adjusted', finished_at: new Date() })
        .where(inArray(stockItems.id, surplus))
        .returning({ id: stockItems.id });
      await logEvent('adjust', barcode, ids.map((r) => r.id), { inventory: true, location_id: loc });
      removed = ids.length;
      const p = await getProduct(barcode);
      if (p) await restockCheck(p); // fewer packs than the minimum stock -> shopping list
    }
  }
  const resolvedAt = new Date();
  await db
    .insert(inventoryCounts)
    .values({ session_id: sessionId, barcode, location_id: loc, counted: 0, resolved: action, resolved_at: resolvedAt })
    .onConflictDoUpdate({ target: countKey, set: { resolved: action, resolved_at: resolvedAt } });
  bus.emit('change', { what: 'inventory' });
  bus.emit('change', { what: 'stock' });
  return { added, removed };
}

/** Applies one decision to every row that differs and is not yet decided. */
export async function resolveAll(sessionId: number, action: 'keep' | 'apply'): Promise<number> {
  const open = (await rows(sessionId)).filter((r) => r.before !== r.counted && r.resolved == null);
  for (const r of open) await resolveRow(sessionId, r.barcode, r.location_id, action);
  return open.length;
}

export async function finishSession(sessionId: number, status: 'done' | 'cancelled'): Promise<void> {
  await db
    .update(inventorySessions)
    .set({ status, finished_at: new Date() })
    .where(and(eq(inventorySessions.id, sessionId), eq(inventorySessions.status, 'open')));
  bus.emit('change', { what: 'inventory' });
}

export const label = productLabel;
