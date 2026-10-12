import { q, q1 } from './db.js';
import { bus, getProduct, logEvent, productLabel, restockCheck } from './service.js';

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
  started_at: string;
  scope: number[];
}

export async function openSession(): Promise<Session | undefined> {
  return q1<Session>(`SELECT id, started_at, scope FROM inventory_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
}

export async function startSession(scope: number[]): Promise<Session> {
  const existing = await openSession();
  if (existing) {
    for (const loc of scope) await addScope(existing.id, loc);
    return (await openSession())!;
  }
  const row = await q1<Session>(`INSERT INTO inventory_sessions (scope) VALUES ($1::int[]) RETURNING id, started_at, scope`, [scope]);
  bus.emit('change', { what: 'inventory' });
  return row!;
}

export async function addScope(sessionId: number, loc: number): Promise<void> {
  await q(`UPDATE inventory_sessions SET scope = array_append(scope, $2::int) WHERE id = $1 AND NOT ($2::int = ANY(scope))`, [sessionId, loc]);
}

export async function removeScope(sessionId: number, loc: number): Promise<void> {
  await q(`UPDATE inventory_sessions SET scope = array_remove(scope, $2::int) WHERE id = $1`, [sessionId, loc]);
}

async function stockCountAt(barcode: string, loc: number): Promise<number> {
  const r = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM stock_items WHERE barcode = $1 AND status = 'in_stock' AND COALESCE(location_id, 0) = $2`,
    [barcode, loc],
  );
  return r?.n ?? 0;
}

/** One scan in inventory mode. Starts a session automatically if none is open. */
export async function countScan(barcode: string, loc: number, qty: number): Promise<{ counted: number; stock: number; autoStarted: boolean; sessionId: number }> {
  let session = await openSession();
  const autoStarted = !session;
  if (!session) session = await startSession([loc]);
  else await addScope(session.id, loc);
  const row = await q1<{ counted: number }>(
    `INSERT INTO inventory_counts (session_id, barcode, location_id, counted) VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id, barcode, location_id) DO UPDATE SET counted = inventory_counts.counted + $4, resolved = NULL
     RETURNING counted`,
    [session.id, barcode, loc, qty],
  );
  await logEvent('count', barcode, [], { session: session.id, location: loc, qty });
  bus.emit('change', { what: 'inventory' });
  return { counted: row!.counted, stock: await stockCountAt(barcode, loc), autoStarted, sessionId: session.id };
}

/** Undo of a count scan (PCUNDO in inventory mode). */
export async function undoCount(detail: { session: number; location: number; qty: number }, barcode: string): Promise<void> {
  await q(`UPDATE inventory_counts SET counted = GREATEST(0, counted - $4) WHERE session_id = $1 AND barcode = $2 AND location_id = $3`, [
    detail.session, barcode, detail.location, detail.qty,
  ]);
  await q(`DELETE FROM inventory_counts WHERE session_id = $1 AND barcode = $2 AND location_id = $3 AND counted = 0 AND resolved IS NULL`, [
    detail.session, barcode, detail.location,
  ]);
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

export async function rows(sessionId: number): Promise<Row[]> {
  return q<Row>(
    `WITH scope AS (SELECT unnest(scope) AS loc FROM inventory_sessions WHERE id = $1),
          stock AS (SELECT barcode, COALESCE(location_id, 0) AS loc, count(*)::int AS n FROM stock_items
                    WHERE status = 'in_stock' AND COALESCE(location_id, 0) IN (SELECT loc FROM scope) GROUP BY 1, 2),
          cnt AS (SELECT barcode, location_id AS loc, counted, resolved FROM inventory_counts WHERE session_id = $1)
     SELECT COALESCE(s.barcode, c.barcode) AS barcode, COALESCE(s.loc, c.loc) AS location_id,
            COALESCE(l.name, 'Ohne Lagerort') AS location_name, p.name, p.brand, p.image_url,
            COALESCE(s.n, 0) AS before, COALESCE(c.counted, 0) AS counted, c.resolved
     FROM stock s FULL JOIN cnt c ON s.barcode = c.barcode AND s.loc = c.loc
     JOIN products p ON p.barcode = COALESCE(s.barcode, c.barcode)
     LEFT JOIN locations l ON l.id = COALESCE(s.loc, c.loc)
     ORDER BY (COALESCE(s.loc, c.loc) = 0), l.id, p.name`,
    [sessionId],
  );
}

/** Corrects a counted value by hand (+/- in the UI). */
export async function setCounted(sessionId: number, barcode: string, loc: number, counted: number): Promise<void> {
  await q(
    `INSERT INTO inventory_counts (session_id, barcode, location_id, counted) VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id, barcode, location_id) DO UPDATE SET counted = $4, resolved = NULL`,
    [sessionId, barcode, loc, counted],
  );
  bus.emit('change', { what: 'inventory' });
}

/** keep = stock stays as it was; apply = stock becomes the counted amount. */
export async function resolveRow(sessionId: number, barcode: string, loc: number, action: 'keep' | 'apply'): Promise<{ added: number; removed: number }> {
  const c = await q1<{ counted: number }>(`SELECT counted FROM inventory_counts WHERE session_id = $1 AND barcode = $2 AND location_id = $3`, [sessionId, barcode, loc]);
  const counted = c?.counted ?? 0;
  let added = 0, removed = 0;
  if (action === 'apply') {
    const cur = await stockCountAt(barcode, loc);
    const delta = counted - cur;
    if (delta > 0) {
      const ids = await q<{ id: number }>(
        `INSERT INTO stock_items (barcode, location_id) SELECT $1, $2::int FROM generate_series(1, $3) RETURNING id`,
        [barcode, loc || null, delta],
      );
      await logEvent('add', barcode, ids.map((r) => r.id), { inventory: true, location_id: loc });
      added = ids.length;
    } else if (delta < 0) {
      const ids = await q<{ id: number }>(
        `UPDATE stock_items SET status = 'adjusted', finished_at = now()
         WHERE id IN (SELECT id FROM stock_items WHERE barcode = $1 AND status = 'in_stock' AND COALESCE(location_id, 0) = $2
                      ORDER BY (opened_at IS NULL), COALESCE(best_before, 'infinity'::date), added_at LIMIT $3)
         RETURNING id`,
        [barcode, loc, -delta],
      );
      await logEvent('adjust', barcode, ids.map((r) => r.id), { inventory: true, location_id: loc });
      removed = ids.length;
      const p = await getProduct(barcode);
      if (p) await restockCheck(p); // fewer packs than the minimum stock -> shopping list
    }
  }
  await q(
    `INSERT INTO inventory_counts (session_id, barcode, location_id, counted, resolved, resolved_at) VALUES ($1, $2, $3, 0, $4, now())
     ON CONFLICT (session_id, barcode, location_id) DO UPDATE SET resolved = $4, resolved_at = now()`,
    [sessionId, barcode, loc, action],
  );
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
  await q(`UPDATE inventory_sessions SET status = $2, finished_at = now() WHERE id = $1 AND status = 'open'`, [sessionId, status]);
  bus.emit('change', { what: 'inventory' });
}

export const label = productLabel;
