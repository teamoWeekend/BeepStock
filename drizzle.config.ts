import { defineConfig } from 'drizzle-kit';

// Used by `npm run db:generate`: compares src/schema.ts with the last snapshot in drizzle/ and writes a new migration.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
});
