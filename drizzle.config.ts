import { defineConfig } from 'drizzle-kit';

// Migrations are generated from the schema, then applied by src/lib/server/db/migrate.ts, which also applies
// the roles, grants and row level security that no schema diff can express (ADR-021).
export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema/index.ts',
	out: './src/lib/server/db/migrations'
});
