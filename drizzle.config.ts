import { defineConfig } from 'drizzle-kit'
import { databaseUrl } from './server/database.ts'

// drizzle-kit creates its own Postgres.js client from this URL alone. Pass the
// same 2 s connect_timeout as the app (see server/database.ts) in the URL.
const url = process.env.DATABASE_URL ? new URL(await databaseUrl()) : undefined
url?.searchParams.set('connect_timeout', '2')

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/schema.ts',
  out: './drizzle',
  migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
  // Generation needs no credentials. Migration credentials stay in the process,
  // including the existing host-mounted password file, never CLI arguments.
  dbCredentials: { url: url?.toString() ?? '' }
})
