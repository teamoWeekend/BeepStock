import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { products, stockItems } from './schema.js';

/**
 * PostgreSQL functions that Drizzle has no builder for, as typed building blocks over the mapped columns.
 * Queries elsewhere are built from these and the tables in schema.ts; this is the one place that writes SQL text.
 * Constants are written into the SQL (not passed as parameters) where an expression is also used in GROUP BY.
 */

/** The first argument that is not NULL. */
export const coalesce = <T>(...values: (SQLWrapper | T)[]): SQL<T> => sql<T>`coalesce(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;

/** NULL as 0, e.g. "no storage location" as location 0. Safe to group by. */
export const orZero = (value: SQLWrapper): SQL<number> => sql<number>`coalesce(${value}, 0)`.mapWith(Number);

export const greatest = <T>(...values: (SQLWrapper | T)[]): SQL<T> => sql<T>`greatest(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;

/** column + n, evaluated in the database (atomic counters). */
export const plus = (column: SQLWrapper, n: number): SQL<number> => sql<number>`${column} + ${n}`;

/** count(*) FILTER (WHERE ...): rows of the group that match. */
export const countWhere = (condition: SQL | undefined): SQL<number> => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

/** The local calendar date of a timestamp. */
export const dateOf = (timestamp: SQLWrapper): SQL<string> => sql<string>`${timestamp}::date`;

/** 'YYYY-MM' of a timestamp. Safe to group by. */
export const monthOf = (timestamp: SQLWrapper): SQL<string> => sql<string>`to_char(date_trunc('month', ${timestamp}), 'YYYY-MM')`;

/** Values joined with a space, NULLs skipped. */
export const joinedText = (...values: SQLWrapper[]): SQL<string> => sql<string>`concat_ws(' ', ${sql.join(values, sql`, `)})`;

/** The distinct non-NULL values of a group as an array (NULL for an empty group). */
export const distinctValues = <T>(column: SQLWrapper): SQL<T[] | null> => sql<T[] | null>`array_remove(array_agg(distinct ${column}), null)`;

/** Join condition for a lateral subquery that is correlated in its own WHERE. */
export const always = sql`true`;

/**
 * When a pack expires: its best-before date, or once opened the opening day plus the product's days after opening,
 * whichever comes first. Needs stock_items joined with products.
 */
export const expiresAt = (): SQL<string | null> =>
  sql<string | null>`least(${stockItems.best_before}, ${dateOf(stockItems.opened_at)} + ${products.days_after_opening})`;
