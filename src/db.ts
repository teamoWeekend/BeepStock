import pg from 'pg';
import { config } from './config.js';

// int8 -> number, date -> 'YYYY-MM-DD' string (no timezone shifting)
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function q1<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}

/** Runs fn inside one transaction (all or nothing). */
export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const MIGRATIONS: string[] = [
  `
CREATE TABLE products (
  barcode TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  quantity_text TEXT,
  categories TEXT,
  image_url TEXT,
  nutriscore TEXT,
  nova_group INT,
  ecoscore TEXT,
  nutriments JSONB NOT NULL DEFAULT '{}',
  ingredients TEXT,
  allergens TEXT,
  serving_size TEXT,
  off_found BOOLEAN,
  off_fetched_at TIMESTAMPTZ,
  shelf_life_days INT,
  days_after_opening INT,
  min_stock INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stock_items (
  id BIGSERIAL PRIMARY KEY,
  barcode TEXT NOT NULL REFERENCES products(barcode) ON DELETE CASCADE,
  best_before DATE,
  opened_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','consumed','wasted')),
  finished_at TIMESTAMPTZ,
  waste_reason TEXT
);
CREATE INDEX stock_items_status_idx ON stock_items (status, barcode);

CREATE TABLE shopping_items (
  id BIGSERIAL PRIMARY KEY,
  barcode TEXT REFERENCES products(barcode) ON DELETE SET NULL,
  name TEXT NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  done BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at TIMESTAMPTZ
);

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  barcode TEXT,
  item_ids BIGINT[] NOT NULL DEFAULT '{}',
  undone BOOLEAN NOT NULL DEFAULT false,
  detail JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE app_state (
  id INT PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'consume',
  pending_date DATE,
  pending_date_label TEXT,
  pending_qty INT,
  digits TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_state (id) VALUES (1);
`,
  `
CREATE TABLE locations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
INSERT INTO locations (name) VALUES ('Kühlschrank'), ('Tiefkühler'), ('Vorratsschrank'), ('Keller');
ALTER TABLE stock_items ADD COLUMN location_id INT REFERENCES locations(id) ON DELETE SET NULL;
ALTER TABLE app_state ADD COLUMN location_id INT REFERENCES locations(id) ON DELETE SET NULL;
UPDATE app_state SET location_id = (SELECT id FROM locations ORDER BY id LIMIT 1);
`,
  `
CREATE TABLE stores (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INT NOT NULL DEFAULT 0
);
ALTER TABLE products ADD COLUMN store_id INT REFERENCES stores(id) ON DELETE SET NULL;
ALTER TABLE shopping_items ADD COLUMN store_id INT REFERENCES stores(id) ON DELETE SET NULL;
`,
  `
ALTER TABLE products ADD COLUMN source TEXT;
UPDATE products SET source = 'off' WHERE off_found IS TRUE;
`,
  `
ALTER TABLE stock_items DROP CONSTRAINT IF EXISTS stock_items_status_check;
ALTER TABLE stock_items ADD CONSTRAINT stock_items_status_check CHECK (status IN ('in_stock','consumed','wasted','adjusted'));
CREATE TABLE inventory_sessions (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  scope INT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE inventory_counts (
  session_id INT NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL REFERENCES products(barcode) ON DELETE CASCADE,
  location_id INT NOT NULL DEFAULT 0,
  counted INT NOT NULL DEFAULT 0,
  resolved TEXT CHECK (resolved IN ('keep','apply')),
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (session_id, barcode, location_id)
);
`,
  `
ALTER TABLE locations ADD COLUMN kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('fridge','freezer','pantry','other'));
UPDATE locations SET kind = CASE
  WHEN name ILIKE '%tief%' OR name ILIKE '%gefrier%' THEN 'freezer'
  WHEN name ILIKE '%k_hl%' THEN 'fridge'
  WHEN name ILIKE '%vorrat%' OR name ILIKE '%speisekammer%' OR name ILIKE '%schrank%' THEN 'pantry'
  ELSE 'other' END;
ALTER TABLE products
  ADD COLUMN categories_tags TEXT[],
  ADD COLUMN conservation TEXT,
  ADD COLUMN location_id INT REFERENCES locations(id) ON DELETE SET NULL,
  ADD COLUMN auto_defaults BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN move_on_open BOOLEAN NOT NULL DEFAULT true;
`,
  `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
`,
  `
ALTER TABLE products ADD COLUMN image_source_url TEXT, ADD COLUMN image_file TEXT;
`,
];

export async function migrate(): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_version (version INT PRIMARY KEY)');
  const client = await pool.connect();
  try {
    // advisory lock so parallel starts don't race
    await client.query('SELECT pg_advisory_lock(727274)');
    const { rows } = await client.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version');
    let current = Number(rows[0]?.v ?? 0);
    for (let i = current; i < MIGRATIONS.length; i++) {
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[i]!);
        await client.query('INSERT INTO schema_version (version) VALUES ($1)', [i + 1]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      current = i + 1;
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
}
