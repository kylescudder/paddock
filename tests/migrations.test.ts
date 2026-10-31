import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { SQL } from "bun";
import { migrate as legacyMigrate } from "./fixtures/legacy-schema.ts";
import { Store } from "../server/db.ts";

const url =
  process.env.TEST_DATABASE_URL ||
  "postgres://paddock_test_owner@127.0.0.1:55432/paddock_test";
const target = new URL(url);
if (
  !target.pathname.endsWith("_test") ||
  !["localhost", "127.0.0.1"].includes(target.hostname)
)
  throw new Error(
    "Migration tests require a disposable localhost database ending in _test",
  );
const sql = new SQL(url, { max: 1 });
afterAll(() => sql.close());
async function reset() {
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await sql`DROP SCHEMA public CASCADE`;
  await sql`CREATE SCHEMA public`;
}
async function migrate(target = url) {
  const child = Bun.spawn([process.execPath, "server/migrate.ts"], {
    env: { ...process.env, DATABASE_URL: target, DATABASE_PASSWORD_FILE: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: stdout + stderr };
}

test("fresh database migrates once and retains settings on repeat", async () => {
  await reset();
  let result = await migrate();
  assert.equal(result.code, 0, result.output);
  const store = new Store(sql);
  await store.set("migration-probe", { preserved: true });
  result = await migrate();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(await store.get("migration-probe", null), {
    preserved: true,
  });
  const [row] =
    await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  assert.equal(row.count, 1);
}, 30000);

// Independent copy of the pre-Drizzle DDL at audited main, not generated SQL.
test("adopts the legacy schema without touching rows, tables or old migration compatibility", async () => {
  await reset();
  await legacyMigrate(sql);
  await sql`INSERT INTO state VALUES ('settings', '{"monthlyGenerationLimit":9}')`;
  await sql`INSERT INTO events VALUES ('2026-monaco', 2026, '{"id":"2026-monaco","season":2026,"round":6}')`;
  await sql`INSERT INTO backgrounds VALUES ('monaco:2026', '/background.png', 'approved')`;
  await sql`INSERT INTO jobs VALUES ('job', 'generate', '2026-monaco', 'succeeded', 'done', '2026-10-30T10:00:00Z', NULL)`;
  await sql`INSERT INTO attempts VALUES ('attempt', '2026-10', 'model', '2026-10-30T10:00:00Z')`;
  await sql`INSERT INTO mappings VALUES ('2026-monaco', 'race', 'emby-item', 'Race', 'approved', NULL, NULL)`;
  await sql`INSERT INTO overlays VALUES ('monaco:2026', '{"title":"#ffffff"}')`;
  await sql`INSERT INTO studio_versions VALUES ('candidate', 'monaco:2026', '/candidate.png', 'v2', 'generated', NULL, 'feedback', 'prompt', 'model', '2026-10-30T10:00:00Z')`;
  await sql`INSERT INTO studio_drafts VALUES ('monaco:2026', 'candidate', '{"title":"#ffffff"}', '2026-10-30T10:00:00Z')`;
  async function contents() {
    const tables =
      await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
    return Promise.all(
      tables.map(async ({ tablename }: { tablename: string }) => ({
        table: tablename,
        rows: await sql.unsafe(`SELECT * FROM "${tablename}"`),
        identity:
          await sql`SELECT oid FROM pg_class WHERE oid=${"public." + tablename}::regclass`,
      })),
    );
  }
  const before = await contents();
  const result = await migrate();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(await contents(), before);
  assert.equal((await new Store(sql).settings()).monthlyGenerationLimit, 9);
  // A previous image may still run its idempotent migration during rollback.
  await legacyMigrate(sql);
  assert.deepEqual(await contents(), before);
  assert.equal((await migrate()).code, 0);
}, 30000);

for (const [name, change] of [
  ["partial schema", "DROP TABLE studio_drafts"],
  ["column type", "ALTER TABLE jobs ALTER COLUMN message TYPE varchar(20)"],
  ["nullability", "ALTER TABLE events ALTER COLUMN payload DROP NOT NULL"],
  ["default", "ALTER TABLE events ALTER COLUMN season SET DEFAULT 2026"],
  ["unique key", "ALTER TABLE mappings DROP CONSTRAINT mappings_item_id_key"],
  [
    "index ordering",
    "DROP INDEX jobs_created; CREATE INDEX jobs_created ON jobs (created_at ASC)",
  ],
  ["row security", "ALTER TABLE events ENABLE ROW LEVEL SECURITY"],
]) {
  test(`refuses adoption with incompatible ${name} and preserves existing settings`, async () => {
    await reset();
    await legacyMigrate(sql);
    await new Store(sql).set("keep", { untouched: true });
    await sql.unsafe(change!);
    const result = await migrate();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /incompatible/);
    assert.deepEqual(await new Store(sql).get("keep", null), {
      untouched: true,
    });
    const [row] =
      await sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`;
    assert.equal(row.name, null);
  }, 30000);
}

test("rejects unknown migration history and serializes concurrent migration commands", async () => {
  await reset();
  const results = await Promise.all([migrate(), migrate()]);
  for (const result of results) assert.equal(result.code, 0, result.output);
  await sql`UPDATE drizzle.__drizzle_migrations SET hash='unexpected'`;
  const result = await migrate();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /history differs/);
  const [row] =
    await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  assert.equal(row.count, 1);
}, 30000);

test("non-superuser owner migrates while restricted runtime can use data but cannot access metadata or migrate", async () => {
  await reset();
  const db = new URL(url).pathname.slice(1);
  assert.match(db, /^[a-z_]+_test$/);
  const owner = "paddock_migration_owner_test";
  const runtime = db + "_runtime";
  const roleUrl = (role: string) => {
    const target = new URL(url);
    target.username = role;
    target.password = "";
    return target.toString();
  };
  await sql.unsafe(`CREATE ROLE ${owner} LOGIN NOSUPERUSER CONNECTION LIMIT 2`);
  await sql.unsafe(
    `CREATE ROLE ${runtime} LOGIN NOSUPERUSER CONNECTION LIMIT 8`,
  );
  const client = new SQL(roleUrl(runtime), { max: 1 });
  try {
    await sql.unsafe(`GRANT CONNECT, CREATE ON DATABASE "${db}" TO ${owner}`);
    await sql.unsafe(`GRANT CONNECT ON DATABASE "${db}" TO ${runtime}`);
    await sql.unsafe(`ALTER SCHEMA public OWNER TO ${owner}`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
    // Model even a host's broad global default grants: metadata stays private.
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`,
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT USAGE, SELECT ON SEQUENCES TO ${runtime}`,
    );
    for (const legacy of [false, true]) {
      if (legacy) {
        await sql`DROP SCHEMA drizzle CASCADE`;
        await sql`DROP SCHEMA public CASCADE`;
        await sql.unsafe(`CREATE SCHEMA public AUTHORIZATION ${owner}`);
        await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
        const previous = new SQL(roleUrl(owner), { max: 1 });
        try {
          await legacyMigrate(previous);
        } finally {
          await previous.close();
        }
      }
      const result = await migrate(roleUrl(owner));
      assert.equal(result.code, 0, result.output);
      const store = new Store(client);
      await store.set("runtime", { writable: true });
      assert.deepEqual(await store.get("runtime", null), { writable: true });
      await assert.rejects(client`SELECT * FROM drizzle.__drizzle_migrations`);
      await assert.rejects(
        client`INSERT INTO drizzle.__drizzle_migrations (hash) VALUES ('forged')`,
      );
      await assert.rejects(client`CREATE TABLE public.unauthorized (id text)`);
      assert.notEqual((await migrate(roleUrl(runtime))).code, 0);
      const [privileges] = await sql`SELECT
        has_schema_privilege(${runtime}, 'drizzle', 'USAGE') AS usage,
        has_table_privilege(${runtime}, 'drizzle.__drizzle_migrations', 'SELECT') AS read,
        has_table_privilege(${runtime}, 'drizzle.__drizzle_migrations', 'INSERT') AS write`;
      assert.deepEqual(privileges, { usage: false, read: false, write: false });
    }
  } finally {
    await client.close();
    await reset();
    await sql.unsafe(`DROP OWNED BY ${owner}`);
    await sql.unsafe(`DROP OWNED BY ${runtime}`);
    await sql.unsafe(`DROP ROLE ${owner}, ${runtime}`);
  }
}, 30000);

test("reports failed initial DDL without allowing a partial fresh schema", async () => {
  await reset();
  const owner = "paddock_blocked_owner_test";
  const db = new URL(url).pathname.slice(1);
  assert.match(db, /^[a-z_]+_test$/);
  await sql.unsafe(`CREATE ROLE ${owner} LOGIN NOSUPERUSER`);
  try {
    await sql.unsafe(`GRANT CONNECT, CREATE ON DATABASE "${db}" TO ${owner}`);
    await sql`REVOKE CREATE ON SCHEMA public FROM PUBLIC`;
    const target = new URL(url);
    target.username = owner;
    target.password = "";
    const result = await migrate(target.toString());
    assert.notEqual(result.code, 0, result.output);
    const [row] = await sql`SELECT to_regclass('public.state') AS name`;
    assert.equal(row.name, null);
  } finally {
    await reset();
    await sql.unsafe(`DROP OWNED BY ${owner}`);
    await sql.unsafe(`DROP ROLE ${owner}`);
  }
}, 30000);

test("Drizzle state queries preserve JSON scalars, null and transaction rollback on the shared Bun client", async () => {
  await reset();
  const result = await migrate();
  assert.equal(result.code, 0, result.output);
  const store = new Store(sql);
  for (const value of [
    "calendar cached",
    null,
    false,
    42,
    { season: 2026 },
    [1, "two"],
  ]) {
    await store.set("roundtrip", value);
    assert.deepEqual(await store.get("roundtrip", "missing"), value);
  }
  await assert.rejects(
    store.transaction(async (tx) => {
      await tx.set("roundtrip", "rolled back");
      throw new Error("cancel");
    }),
  );
  assert.deepEqual(await store.get("roundtrip", null), [1, "two"]);
}, 30000);
