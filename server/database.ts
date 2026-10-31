import postgres, { type Sql } from "postgres";

// Created lazily so importing server code never needs a database (e.g. in the router).
let pool: Promise<Sql> | undefined;

export async function databaseUrl(): Promise<string> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const url = new URL(process.env.DATABASE_URL);
  // The host mounts the password as a Docker secret rather than an environment value.
  if (process.env.DATABASE_PASSWORD_FILE)
    url.password = (
      await Bun.file(process.env.DATABASE_PASSWORD_FILE).text()
    ).trim();
  return url.toString();
}

export function connection(): Promise<Sql> {
  // Cache initialization before reading the secret file so simultaneous first
  // callers cannot create independent four-slot pools. A failed read can retry.
  pool ??= databaseUrl()
    .then((url) =>
      postgres(url, { max: 4, idle_timeout: 20, connect_timeout: 10 }),
    )
    .catch((error) => {
      pool = undefined;
      throw error;
    });
  return pool;
}
export async function closeConnection() {
  const current = pool;
  pool = undefined;
  await (await current)?.end();
}
