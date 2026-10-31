import { test } from "bun:test";
import assert from "node:assert/strict";
import { connection, closeConnection } from "../server/database.ts";

test("concurrent first callers share one application client", async () => {
  const previous = process.env.DATABASE_URL;
  const passwordFile = process.env.DATABASE_PASSWORD_FILE;
  process.env.DATABASE_URL = "postgres://unused@127.0.0.1:1/paddock_test";
  delete process.env.DATABASE_PASSWORD_FILE;
  try {
    const clients = await Promise.all(Array.from({ length: 16 }, connection));
    assert.equal(new Set(clients).size, 1);
    assert.equal(clients[0]!.options.max, 4);
    assert.equal(clients[0]!.options.idle_timeout, 20);
    assert.equal(clients[0]!.options.connect_timeout, 10);
  } finally {
    await closeConnection();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    if (passwordFile !== undefined)
      process.env.DATABASE_PASSWORD_FILE = passwordFile;
  }
});
