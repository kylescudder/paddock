import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { SQL as LegacySQL } from "bun";
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
const sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 10 });
afterAll(() => sql.end());
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
    const tables = await sql<
      { tablename: string }[]
    >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
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
  const client = postgres(roleUrl(runtime), { max: 1 });
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
        const previous = postgres(roleUrl(owner), { max: 1 });
        try {
          await legacyMigrate(previous);
        } finally {
          await previous.end();
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
    await client.end();
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

test("Drizzle state queries preserve JSON scalars, null and transaction rollback on the shared application client", async () => {
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

// The old driver is intentionally retained only at this compatibility boundary.
test("legacy Bun JSONB and new Store writes interoperate without changing scalar encodings", async () => {
  await reset();
  assert.equal((await migrate()).code, 0);
  const legacy = new LegacySQL(url, { max: 1 });
  const store = new Store(sql);
  try {
    for (const value of [
      null,
      "calendar cached",
      false,
      42,
      { season: 2026 },
      [1, "two"],
    ]) {
      await legacy`INSERT INTO state (key, value) VALUES ('legacy', ${JSON.stringify(value)}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value=excluded.value`;
      assert.deepEqual(await store.get("legacy", "missing"), value);
      await store.set("legacy", value);
      const [row] = await legacy`SELECT value FROM state WHERE key='legacy'`;
      // Frozen main Store.get behavior, including its JSON string decoder.
      assert.deepEqual(
        typeof row.value === "string" ? JSON.parse(row.value) : row.value,
        value,
      );
    }
    const event = { id: "2026-monaco", season: 2026, round: 6 };
    const colours = { title: "#ffffff" };
    // Legacy Bun persisted both JSON objects and JSON strings containing objects.
    const writers: ((
      query: TemplateStringsArray,
      ...parameters: string[]
    ) => PromiseLike<unknown>)[] = [sql, legacy];
    for (const writer of writers) {
      await writer`INSERT INTO events VALUES (${event.id}, 2026, ${JSON.stringify(event)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET payload=excluded.payload`;
      await writer`INSERT INTO overlays VALUES ('monaco:2026', ${JSON.stringify(colours)}::jsonb)
        ON CONFLICT (venue) DO UPDATE SET colours=excluded.colours`;
      await writer`INSERT INTO studio_drafts VALUES ('monaco:2026', NULL, ${JSON.stringify(colours)}::jsonb, '2026-10-31T12:30:00+02:00')
        ON CONFLICT (venue) DO UPDATE SET colours=excluded.colours`;
      assert.deepEqual(await store.event(event.id), event);
      assert.deepEqual(await store.events(2026), [event]);
      assert.deepEqual(await store.overlay("monaco:2026"), colours);
      assert.deepEqual((await store.overlays()).get("monaco:2026"), colours);
      assert.deepEqual(await store.studioDraft("monaco:2026"), {
        selectedVersionId: null,
        colours,
        updatedAt: "2026-10-31T10:30:00.000Z",
      });
    }
  } finally {
    await legacy.close();
  }
}, 30000);

test("shared raw and Drizzle transactions roll back together, including nested work", async () => {
  await reset();
  assert.equal((await migrate()).code, 0);
  const store = new Store(sql);
  const mapping = {
    eventId: "2026-monaco",
    session: "race" as const,
    itemId: "episode",
    itemName: "Monaco",
    lastImageVersion: null,
    lastSyncedAt: "2026-10-31T12:30:00+02:00",
    error: null,
  };
  await store.saveMapping(mapping);
  await assert.rejects(
    store.transaction(async (tx) => {
      await tx.set("atomic", { saved: true });
      await tx.saveBackground("monaco:2026", "/rollback.png", "rollback");
      await tx.transaction(async (nested) => {
        await nested.set("nested", true);
        await nested.saveMapping({ ...mapping, itemName: "rollback" });
      });
      throw new Error("cancel");
    }),
  );
  assert.equal(await store.get("atomic", null), null);
  assert.equal(await store.get("nested", null), null);
  assert.equal(await store.background("monaco:2026"), undefined);
  assert.deepEqual(await store.mappings(), [
    { ...mapping, lastSyncedAt: "2026-10-31T10:30:00.000Z" },
  ]);
  // A uniqueness failure partway through a remap cannot save the first row.
  await assert.rejects(
    store.replaceMappings([
      { ...mapping, itemName: "partial" },
      { ...mapping, eventId: "2026-silverstone" },
    ]),
  );
  assert.equal((await store.mappings())[0]!.itemName, "Monaco");
  await store.transaction(async (tx) => {
    await tx.set("atomic", true);
    await tx.saveBackground("monaco:2026", "/committed.png", "committed");
  });
  assert.equal(await store.get("atomic", false), true);
  assert.equal((await store.background("monaco:2026"))?.version, "committed");
}, 30000);

test("reopening the Store recovers interrupted jobs and keeps timestamp/null behavior", async () => {
  await reset();
  assert.equal((await migrate()).code, 0);
  const store = new Store(sql);
  const queued = await store.createJob("sync", null, "queued");
  const running = await store.createJob("generate", "2026-monaco", "queued");
  const completed = await store.createJob("emby", null, "queued");
  await store.updateJob(running.id, "running", "working");
  await store.updateJob(completed.id, "completed", "done");
  assert.equal(
    (await store.latestJob("generate", "2026-monaco"))?.finishedAt,
    null,
  );
  const reopened = await new Store(sql).open();
  const jobs = await reopened.jobs();
  for (const id of [queued.id, running.id]) {
    const recovered = jobs.find((job) => job.id === id)!;
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.message, "Interrupted by a restart. You can retry.");
    assert.ok(Number.isFinite(Date.parse(recovered.finishedAt!)));
  }
  const done = jobs.find((job) => job.id === completed.id)!;
  assert.equal(done.status, "completed");
  assert.equal(done.message, "done");
  assert.equal(done.createdAt, completed.createdAt);
  assert.ok(Number.isFinite(Date.parse(done.finishedAt!)));
}, 30000);
