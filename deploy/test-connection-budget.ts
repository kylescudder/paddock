import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDeploymentDatabase } from "./database";
import postgres, { type Sql } from "postgres";
import { connection, closeConnection } from "../server/database";
import { Store } from "../server/db";
import { sql as drizzleSql } from "drizzle-orm";
function connect(url: string, max: number) {
  return adapt(postgres(url, { max, idle_timeout: 20, connect_timeout: 10 }));
}
function adapt(pool: Sql): Client {
  return {
    query: async (text) => pool.unsafe(text),
    reserve: async () => {
      const connection = await pool.reserve();
      return {
        query: async (text) => connection.unsafe(text),
        release: async () => {
          await connection.release();
        },
      };
    },
    close: async () => {
      await pool.end({ timeout: 1 });
    },
  };
}

type Reservation = {
  query(text: string): Promise<Record<string, unknown>[]>;
  release(): Promise<void>;
};
type Client = {
  query(text: string): Promise<Record<string, unknown>[]>;
  reserve(): Promise<Reservation>;
  close(): Promise<void>;
};

async function checkBudget() {
  const controlUrl = process.env.TEST_DATABASE_URL;
  if (
    !controlUrl ||
    !/^\/(postgres|[a-z_]+_test)$/.test(new URL(controlUrl).pathname)
  )
    throw new Error(
      "TEST_DATABASE_URL must name postgres or a disposable database ending in _test",
    );
  const admin = connect(controlUrl, 1);
  const role = "budget_" + randomUUID().replaceAll("-", "");
  const pools: Client[] = [];
  const held: Reservation[] = [];
  let created = false;
  const previousUrl = process.env.DATABASE_URL;
  const previousPasswordFile = process.env.DATABASE_PASSWORD_FILE;
  try {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER CONNECTION LIMIT 8`,
    );
    created = true;
    const [database] = await admin.query("SELECT current_database() AS name");
    const name = String(database!.name).replaceAll('"', '""');
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
    const url = new URL(controlUrl);
    url.username = role;
    url.password = "";
    process.env.DATABASE_URL = url.toString();
    delete process.env.DATABASE_PASSWORD_FILE;
    const clients = await Promise.all(Array.from({ length: 16 }, connection));
    assert.equal(new Set(clients).size, 1);
    const appPool = clients[0]!;
    const app = adapt(appPool);
    pools.push(app);
    // Warm the actual Drizzle adapter before reserving every app slot. A second
    // ORM pool would consume a ninth slot below and violate the role budget.
    await new Store(appPool).db.execute(drizzleSql`SELECT 1`);
    const deploymentPool = createDeploymentDatabase(url.toString());
    assert.equal(deploymentPool.options.max, 1);
    assert.equal(deploymentPool.options.idle_timeout, 20);
    assert.equal(deploymentPool.options.connect_timeout, 10);
    const deployment = adapt(deploymentPool);
    const concurrent = await Promise.all(
      Array.from({ length: 16 }, () =>
        app.query("SELECT pg_backend_pid() AS pid, pg_sleep(0.05)"),
      ),
    );
    assert.equal(new Set(concurrent.map(([row]) => row!.pid)).size, 4);
    const health = connect(url.toString(), 1);
    const spare = connect(url.toString(), 2);
    const overflow = connect(url.toString(), 1);
    pools.push(deployment, health, spare, overflow);
    // Hold every application slot, rather than relying on a quiet test pool.
    for (let i = 0; i < 4; i++) {
      const connection = await app.reserve();
      held.push(connection);
      await connection.query("SELECT 1");
    }
    // Overlapping deployment queries must serialize on the actual deployment client.
    // This fails if its pool is changed back to four connections.
    const rows = await Promise.all(
      Array.from({ length: 4 }, () =>
        deployment.query("SELECT pg_backend_pid() AS pid, pg_sleep(0.05)"),
      ),
    );
    assert.equal(new Set(rows.map(([row]) => row!.pid)).size, 1);
    const probe = await health.reserve();
    held.push(probe);
    assert.equal((await probe.query("SELECT 42 AS answer"))[0]!.answer, 42);
    // The app, verifier and health occupy six slots, leaving two for operator work.
    for (let i = 0; i < 2; i++) {
      const connection = await spare.reserve();
      held.push(connection);
      await connection.query("SELECT 1");
    }
    let rejected = false;
    try {
      await overflow.query("SELECT 1");
    } catch (error) {
      const value = error as { code?: string; errno?: string };
      rejected = value.code === "53300" || value.errno === "53300";
    }
    assert.equal(
      rejected,
      true,
      "The ninth connection must hit the real role limit",
    );
  } finally {
    await Promise.all(held.map((connection) => connection.release()));
    await Promise.all(pools.map((pool) => pool.close()));
    if (created) {
      await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP ROLE "${role}"`);
    }
    await closeConnection();
    process.env.DATABASE_URL = previousUrl;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    if (previousPasswordFile !== undefined)
      process.env.DATABASE_PASSWORD_FILE = previousPasswordFile;
    await admin.close();
  }
}

await checkBudget();
console.log(
  "Connection budget passed: app 4 + health 1 + deployment 1, with two spare slots",
);
