import path from 'node:path';
import { getTableName, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { config } from './config.js';
import * as schema from './schema.js';

// int8 -> number (counts); Drizzle maps the mapped columns itself
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export const db = drizzle({ client: pool, schema });

/** The database or an open transaction: functions taking this run inside the caller's transaction if there is one. */
export type Tx = PgDatabase<NodePgQueryResultHKT, typeof schema>;

// ---------------------------------------------------------------- migrations

const MIGRATIONS = path.resolve(import.meta.dirname, '..', 'drizzle');
const LOCK_ID = 727274;
/** Databases created before Drizzle carry their own version table; 8 is the state 0000_baseline describes. */
const LEGACY_VERSION = 8;

export class SchemaError extends Error {}

/** Brings the database to the state of the migrations in drizzle/ (generated from schema.ts). */
export async function migrate(): Promise<void> {
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]); // parallel starts must not race
    await adoptLegacyDatabase();
    await runMigrations(db, { migrationsFolder: MIGRATIONS });
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    lock.release();
  }
}

/**
 * A database set up before Drizzle (numbered scripts, table schema_version) already has every table of
 * 0000_baseline, so that migration is recorded as applied instead of being run. schema_version is left in place:
 * an older Beepstock version still starts on the database as long as no later migration has changed it.
 */
async function adoptLegacyDatabase(): Promise<void> {
  const found = await db.execute<{ legacy: string | null; drizzle: string | null }>(
    sql`SELECT to_regclass('public.schema_version')::text AS legacy, to_regclass('drizzle.__drizzle_migrations')::text AS drizzle`,
  );
  const { legacy, drizzle: adopted } = found.rows[0] ?? {};
  if (!legacy || adopted) return;
  const version = (await db.execute<{ v: number | null }>(sql`SELECT max(version) AS v FROM schema_version`)).rows[0]?.v ?? 0;
  if (version !== LEGACY_VERSION) {
    throw new SchemaError(
      `Datenbank hat den alten Schemastand ${version}, erwartet ist ${LEGACY_VERSION}. Einmal mit dem Image ghcr.io/teamoweekend/beepstock:sha-a90273d starten, dann mit dieser Version.`,
    );
  }
  const baseline = readMigrationFiles({ migrationsFolder: MIGRATIONS })[0]!;
  await db.transaction(async (tx) => {
    // same table the Drizzle migrator creates for itself
    await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    await tx.execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${baseline.hash}, ${baseline.folderMillis})`);
  });
}

// ---------------------------------------------------------------- helpers

/** After rows were inserted with their own ids (import): the next generated id continues after the highest one. */
export async function syncIdSequence(tx: Tx, table: PgTable): Promise<void> {
  const name = getTableName(table);
  await tx.execute(sql`SELECT setval(pg_get_serial_sequence(${name}, 'id'), GREATEST(COALESCE(max(id), 0), 1), count(*) > 0) FROM ${table}`);
}

export async function ping(): Promise<void> {
  await db.execute(sql`SELECT 1`);
}
