import { SQL } from "bun";
import { readMigrationFiles } from "drizzle-orm/migrator";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const migrations = readMigrationFiles({
  migrationsFolder: path.join(root, "drizzle"),
});

// Compare catalog structure, never application rows. Build the frozen generated
// baseline in a transaction-local reference schema, then discard it. This catches
// partial schemas, types/nullability/defaults, keys, index order, RLS and triggers.
async function structure(sql: SQL, schema: string) {
  return sql`SELECT c.relname AS name, c.relkind, c.relpersistence,
    c.relrowsecurity, c.relforcerowsecurity, c.relispartition,
    (SELECT count(*)::int FROM pg_inherits h WHERE h.inhrelid=c.oid OR h.inhparent=c.oid) AS inheritance,
    (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid,a.atttypmod),
      a.attnotnull, a.attidentity, a.attgenerated, a.attcollation::text, pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(jsonb_build_array(k.conname, pg_get_constraintdef(k.oid), k.convalidated)
      ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints,
    (SELECT jsonb_agg(jsonb_build_array(ic.relname, am.amname, i.indisunique, i.indisprimary,
      i.indisvalid, i.indisready, i.indnkeyatts, i.indnatts, i.indkey::text, i.indoption::text,
      i.indclass::text, i.indcollation::text, pg_get_expr(i.indexprs,i.indrelid),
      pg_get_expr(i.indpred,i.indrelid)) ORDER BY ic.relname)
      FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid
      JOIN pg_am am ON am.oid=ic.relam WHERE i.indrelid=c.oid) AS indexes,
    (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers,
    (SELECT count(*)::int FROM pg_rewrite r WHERE r.ev_class=c.oid) AS rules
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=${schema} AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`;
}

async function adopt(sql: SQL) {
  await sql.begin(async (tx) => {
    // No runtime USAGE on the journal schema, even if the host grants default
    // table privileges globally. Fresh installs and adoption share this boundary.
    await tx`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await tx`REVOKE ALL ON SCHEMA drizzle FROM PUBLIC`;
    const [runtime] = await tx`SELECT rolname FROM pg_roles
      WHERE rolname=current_database() || '_runtime'`;
    if (runtime)
      await tx.unsafe(
        `REVOKE ALL ON SCHEMA drizzle FROM "${String(runtime.rolname).replaceAll('"', '""')}"`,
      );

    const [journal] =
      await tx`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`;
    const applied = journal.name
      ? await tx`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id`
      : [];
    for (const [i, row] of applied.entries()) {
      if (
        row.hash !== migrations[i]?.hash ||
        Number(row.created_at) !== migrations[i]?.folderMillis
      )
        throw new Error(
          "Drizzle migration history differs from this release; refusing migration",
        );
    }
    if (applied.length) return;

    const existing = await structure(tx as unknown as SQL, "public");
    if (!existing.length) return; // drizzle-kit applies the generated initial DDL.

    // Unique name, quoted; the schema and its objects are removed before commit.
    const reference =
      "paddock_baseline_" + crypto.randomUUID().replaceAll("-", "");
    await tx.unsafe(`CREATE SCHEMA "${reference}"`);
    await tx.unsafe(`SET LOCAL search_path TO "${reference}", pg_catalog`);
    for (const statement of migrations[0]!.sql) await tx.unsafe(statement);
    const expected = await structure(tx as unknown as SQL, reference);
    if (JSON.stringify(existing) !== JSON.stringify(expected))
      throw new Error(
        "Existing schema is incompatible with the Paddock baseline; no adoption recorded",
      );
    await tx.unsafe(`DROP SCHEMA "${reference}" CASCADE`);
    await tx`SET LOCAL search_path TO public`;
    // Match drizzle-kit's journal format. Only a fully validated legacy schema
    // receives the baseline hash; its initial CREATE TABLE statements never run.
    await tx`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`;
    await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${migrations[0]!.hash}, ${migrations[0]!.folderMillis})`;
  });
}

export async function migrate(url: string) {
  const pool = new SQL(url, { max: 1, connectionTimeout: 10 });
  const sql = await pool.reserve();
  try {
    // Serialize owner migration commands, including the separate one-slot kit
    // client. The runtime role/pool is never involved.
    await sql`SELECT pg_advisory_lock(714203, 1)`;
    await adopt(sql);
    const child = Bun.spawn(
      [
        process.execPath,
        "--bun",
        "node_modules/drizzle-kit/bin.cjs",
        "migrate",
      ],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: url, DATABASE_PASSWORD_FILE: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    // Consume diagnostics without emitting credentials or SQL row values.
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0)
      throw new Error(
        `drizzle-kit migrate failed (exit ${code}); current app can remain running`,
      );
    await sql`REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC`;
    await sql`REVOKE ALL ON ALL SEQUENCES IN SCHEMA drizzle FROM PUBLIC`;
    const [runtime] =
      await sql`SELECT rolname FROM pg_roles WHERE rolname=current_database() || '_runtime'`;
    if (runtime) {
      const role = '"' + String(runtime.rolname).replaceAll('"', '""') + '"';
      await sql.unsafe(
        `REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM ${role}`,
      );
      await sql.unsafe(
        `REVOKE ALL ON ALL SEQUENCES IN SCHEMA drizzle FROM ${role}`,
      );
    }
  } finally {
    // Closing the reserved connection also releases the session advisory lock.
    sql.release();
    await pool.close();
  }
}
