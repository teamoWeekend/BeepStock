import { sql } from 'drizzle-orm';
import { bigint, bigserial, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';
import type { Mode } from './control.js';
import type { Kind } from './storage.js';

/**
 * The database mapped for Drizzle ORM. This file is the source of truth for the schema: after a change here,
 * `npm run db:generate` writes the matching migration to drizzle/ (applied on the next start).
 *
 * Property names are the column names (snake_case), so rows go to the API and into backups unchanged.
 * Columns are listed in their physical order and constraints carry the names PostgreSQL gave them in
 * databases created before Drizzle, so generated migrations fit both old and new databases.
 */

const timestamptz = () => timestamp({ withTimezone: true });

const STOCK_STATUS = ['in_stock', 'consumed', 'wasted', 'adjusted'] as const;

export const locations = pgTable(
  'locations',
  {
    id: serial().primaryKey(),
    name: text().notNull(),
    kind: text().$type<Kind>().notNull().default('other'),
  },
  (t) => [
    unique('locations_name_key').on(t.name),
    check('locations_kind_check', sql`kind IN ('fridge', 'freezer', 'pantry', 'other')`),
  ],
);

/** Shops; a product or shopping list entry can name the one it is usually bought in. */
export const stores = pgTable(
  'stores',
  {
    id: serial().primaryKey(),
    name: text().notNull(),
    sort: integer().notNull().default(0),
  },
  (t) => [unique('stores_name_key').on(t.name)],
);

export const products = pgTable(
  'products',
  {
    barcode: text().primaryKey(),
    name: text().notNull(),
    brand: text(),
    quantity_text: text(),
    categories: text(),
    image_url: text(),
    nutriscore: text(),
    nova_group: integer(),
    ecoscore: text(),
    nutriments: jsonb().$type<Record<string, number | string>>().notNull().default({}),
    ingredients: text(),
    allergens: text(),
    serving_size: text(),
    off_found: boolean(),
    off_fetched_at: timestamptz(),
    shelf_life_days: integer(),
    days_after_opening: integer(),
    min_stock: integer().notNull().default(0),
    created_at: timestamptz().notNull().defaultNow(),
    store_id: integer(),
    source: text(), // off | obf | opf | opff
    categories_tags: text().array(),
    conservation: text(),
    location_id: integer(), // default storage location
    auto_defaults: boolean().notNull().default(true), // location_id / move_on_open were derived automatically (false = set by hand)
    move_on_open: boolean().notNull().default(true), // pantry -> fridge when opened
    image_source_url: text(),
    image_file: text(),
  },
  (t) => [
    foreignKey({ name: 'products_store_id_fkey', columns: [t.store_id], foreignColumns: [stores.id] }).onDelete('set null'),
    foreignKey({ name: 'products_location_id_fkey', columns: [t.location_id], foreignColumns: [locations.id] }).onDelete('set null'),
  ],
);

/** One row per pack. Packs leave the stock by status; they are only deleted by hand or by an undo. */
export const stockItems = pgTable(
  'stock_items',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    barcode: text().notNull(),
    best_before: date({ mode: 'string' }),
    opened_at: timestamptz(),
    added_at: timestamptz().notNull().defaultNow(),
    status: text({ enum: STOCK_STATUS }).notNull().default('in_stock'),
    finished_at: timestamptz(),
    waste_reason: text(),
    location_id: integer(),
  },
  (t) => [
    index('stock_items_status_idx').on(t.status, t.barcode),
    check('stock_items_status_check', sql`status IN ('in_stock', 'consumed', 'wasted', 'adjusted')`),
    foreignKey({ name: 'stock_items_barcode_fkey', columns: [t.barcode], foreignColumns: [products.barcode] }).onDelete('cascade'),
    foreignKey({ name: 'stock_items_location_id_fkey', columns: [t.location_id], foreignColumns: [locations.id] }).onDelete('set null'),
  ],
);

export const shoppingItems = pgTable(
  'shopping_items',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    barcode: text(),
    name: text().notNull(),
    qty: integer().notNull().default(1),
    done: boolean().notNull().default(false),
    source: text().notNull().default('manual'),
    created_at: timestamptz().notNull().defaultNow(),
    done_at: timestamptz(),
    store_id: integer(),
  },
  (t) => [
    foreignKey({ name: 'shopping_items_barcode_fkey', columns: [t.barcode], foreignColumns: [products.barcode] }).onDelete('set null'),
    foreignKey({ name: 'shopping_items_store_id_fkey', columns: [t.store_id], foreignColumns: [stores.id] }).onDelete('set null'),
  ],
);

/** What a scan or click changed, so it can be undone (PCUNDO). */
export const events = pgTable('events', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  ts: timestamptz().notNull().defaultNow(),
  kind: text().notNull(),
  barcode: text(),
  item_ids: bigint({ mode: 'number' }).array().notNull().default([]),
  undone: boolean().notNull().default(false),
  detail: jsonb().$type<Record<string, any>>().notNull().default({}),
});

/** The scanner state (mode, sticky location, pending quantity and digits). Exactly one row, id 1. */
export const appState = pgTable(
  'app_state',
  {
    id: integer().primaryKey(),
    mode: text().$type<Mode>().notNull().default('consume'),
    pending_date: date({ mode: 'string' }), // unused, kept so the table stays as it is
    pending_date_label: text(), // unused
    pending_qty: integer(),
    digits: text().notNull().default(''),
    updated_at: timestamptz().notNull().defaultNow(),
    location_id: integer(),
  },
  (t) => [
    check('app_state_id_check', sql`id = 1`),
    foreignKey({ name: 'app_state_location_id_fkey', columns: [t.location_id], foreignColumns: [locations.id] }).onDelete('set null'),
  ],
);

export const inventorySessions = pgTable(
  'inventory_sessions',
  {
    id: serial().primaryKey(),
    started_at: timestamptz().notNull().defaultNow(),
    finished_at: timestamptz(),
    status: text({ enum: ['open', 'done', 'cancelled'] }).notNull().default('open'),
    scope: integer().array().notNull().default([]), // location ids being counted, 0 = no storage location
  },
  () => [check('inventory_sessions_status_check', sql`status IN ('open', 'done', 'cancelled')`)],
);

export const inventoryCounts = pgTable(
  'inventory_counts',
  {
    session_id: integer().notNull(),
    barcode: text().notNull(),
    location_id: integer().notNull().default(0), // 0 = no storage location (no foreign key on purpose)
    counted: integer().notNull().default(0),
    resolved: text({ enum: ['keep', 'apply'] }),
    resolved_at: timestamptz(),
  },
  (t) => [
    primaryKey({ name: 'inventory_counts_pkey', columns: [t.session_id, t.barcode, t.location_id] }),
    check('inventory_counts_resolved_check', sql`resolved IN ('keep', 'apply')`),
    foreignKey({ name: 'inventory_counts_session_id_fkey', columns: [t.session_id], foreignColumns: [inventorySessions.id] }).onDelete('cascade'),
    foreignKey({ name: 'inventory_counts_barcode_fkey', columns: [t.barcode], foreignColumns: [products.barcode] }).onDelete('cascade'),
  ],
);

/** Settings changed in the UI (see settings.ts); missing keys fall back to the defaults. */
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().$type<unknown>().notNull(),
});

export type Product = typeof products.$inferSelect;
