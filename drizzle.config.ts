import { defineConfig } from "drizzle-kit";
import { databaseUrl } from "./server/database.ts";

export default defineConfig({
  dialect: "postgresql",
  schema: "./server/schema.ts",
  out: "./drizzle",
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
  // Generation needs no credentials. Migration credentials stay in the process,
  // including the existing host-mounted password file, never CLI arguments.
  dbCredentials: { url: process.env.DATABASE_URL ? await databaseUrl() : "" },
});
